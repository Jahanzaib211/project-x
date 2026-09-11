/**
 * G2/G4 — selection, failover and exactly-once delivery at the gateway.
 *
 * INV-121: a failing source is isolated — the next configured source that is
 * delivering takes over, per symbol, and the failing one's ticks are dropped.
 * INV-122: a batch is pushed once; a tick the gateway forwards is the latest
 * in its window, and a retry after a push failure does not duplicate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Adapter } from "./adapters/base.js";
import { FRESH_MS, Gateway } from "./gateway.js";

/** An adapter the test drives by hand. */
class Manual extends Adapter {
  /** @param {string} name @param {() => number} now */
  constructor(name, now) { super(name, { now }); this.connectCalls = 0; }
  connect() { this.connectCalls += 1; this.up(); }
  /** @param {string} symbol @param {string} bid @param {string} ask */
  tick(symbol, bid, ask) { this.emit({ symbol, ms: this.now(), bid, ask, seq: 0 }); }
}

/** A fake market-data that records what it was sent. */
function fakeMarketData() {
  /** @type {{url: string, body: any}[]} */
  const calls = [];
  /** @type {{classes: Record<string, string[]>}} */
  let config = { classes: { Crypto: ["binance", "mt5", "synthetic"], "FX major": ["mt5", "twelvedata", "synthetic"], Metal: ["mt5", "synthetic"] } };
  let failNext = false;
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith("/v1/feed/config")) return new Response(JSON.stringify(config), { status: 200 });
    if (failNext) { failNext = false; return new Response("{}", { status: 503 }); }
    return new Response(JSON.stringify({ accepted: body?.ticks?.length ?? 0 }), { status: 200 });
  };
  return {
    calls,
    fetch: fetchImpl,
    /** @param {{classes: Record<string, string[]>}} next */
    setConfig(next) { config = next; },
    failNextPush() { failNext = true; },
    pushes() { return calls.filter((c) => c.url.endsWith("/v1/feed/ticks")); },
  };
}

test("INV-121: the first delivering source is selected per symbol, and failover follows the list", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const md = fakeMarketData();
  const binance = new Manual("binance", clock);
  const mt5 = new Manual("mt5", clock);
  const twelvedata = new Manual("twelvedata", clock);
  const gateway = new Gateway({ marketDataUrl: "http://md", adapters: { binance, mt5, twelvedata }, now: clock, fetch: md.fetch });
  await gateway.refreshConfig();
  assert.deepEqual(binance.symbols, ["BTCUSD"]);
  assert.deepEqual(mt5.symbols.sort(), ["AUDUSD", "BTCUSD", "EURUSD", "GBPUSD", "XAUUSD"]);
  assert.equal(gateway.selected.get("BTCUSD"), undefined, "nothing has delivered yet");

  // mt5 speaks first for BTC: it is selected even though binance is listed
  // first, because binance has not delivered.
  mt5.tick("BTCUSD", "68000.00", "68010.00");
  assert.equal(gateway.selected.get("BTCUSD"), "mt5");
  // binance delivers: it is preferred, and takes over on its first tick.
  binance.tick("BTCUSD", "68100.00", "68110.00");
  assert.equal(gateway.selected.get("BTCUSD"), "binance");
  mt5.tick("BTCUSD", "68000.00", "68010.00");
  await gateway.flush();
  const pushed = md.pushes();
  assert.equal(pushed.length, 2, "one push per source that was selected at the time");
  assert.equal(pushed[1]?.body.source, "binance");
  assert.equal(gateway.counters.dropped, 1, "the unselected source's tick was dropped");

  // binance goes quiet past the freshness window: mt5 takes over.
  now += FRESH_MS + 1;
  mt5.tick("BTCUSD", "68050.00", "68060.00");
  gateway.reselect();
  assert.equal(gateway.selected.get("BTCUSD"), "mt5");
  assert.ok(gateway.counters.failovers >= 1);
  // binance fails outright: it is skipped even when it "delivers" again
  // only after the circuit opens.
  for (let i = 0; i < 5; i += 1) binance.fail("down");
  assert.equal(binance.state, "circuit-open");
  gateway.reselect();
  assert.equal(gateway.selected.get("BTCUSD"), "mt5");
  gateway.stop();
});

test("INV-122: a window collapses to the latest tick per symbol and a failed push is not replayed as a duplicate", async () => {
  const now = () => 5_000;
  const md = fakeMarketData();
  const binance = new Manual("binance", now);
  const gateway = new Gateway({ marketDataUrl: "http://md", adapters: { binance }, now, fetch: md.fetch });
  await gateway.refreshConfig();
  binance.tick("BTCUSD", "1.00", "1.10");
  binance.tick("BTCUSD", "2.00", "2.10");
  binance.tick("BTCUSD", "3.00", "3.10");
  await gateway.flush();
  let pushes = md.pushes();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]?.body.ticks.length, 1, "three ticks in one window are one quote");
  assert.equal(pushes[0]?.body.ticks[0].bid, "3.00");

  md.failNextPush();
  binance.tick("BTCUSD", "4.00", "4.10");
  await gateway.flush();
  assert.equal(gateway.counters.pushFailures, 1);
  assert.ok(gateway.lastPushError);
  await gateway.flush();
  pushes = md.pushes();
  assert.equal(pushes.length, 2, "nothing was queued twice");
  gateway.stop();
});

test("a reconfiguration stops adapters no class names and starts the ones it does", async () => {
  const now = () => 1;
  const md = fakeMarketData();
  const binance = new Manual("binance", now);
  const mt5 = new Manual("mt5", now);
  const gateway = new Gateway({ marketDataUrl: "http://md", adapters: { binance, mt5 }, now, fetch: md.fetch });
  await gateway.refreshConfig();
  assert.equal(binance.state, "connected");
  const next = { classes: { Crypto: ["synthetic"], "FX major": ["mt5"], Metal: ["mt5"] } };
  md.setConfig(next);
  await gateway.refreshConfig();
  assert.equal(binance.state, "idle", "binance is no longer wanted");
  assert.deepEqual(mt5.symbols.sort(), ["AUDUSD", "EURUSD", "GBPUSD", "XAUUSD"]);
  const status = gateway.status();
  assert.deepEqual(status.config, next.classes);
  assert.equal(/** @type {any} */ (status.adapters).binance.configured, true);
  gateway.stop();
});

test("health is reported to market-data for every adapter", async () => {
  const now = () => 1;
  const md = fakeMarketData();
  const binance = new Manual("binance", now);
  const gateway = new Gateway({ marketDataUrl: "http://md", adapters: { binance }, now, fetch: md.fetch });
  await gateway.refreshConfig();
  await gateway.reportHealth();
  const report = md.calls.find((c) => c.url.endsWith("/v1/feed/health"));
  assert.ok(report);
  assert.equal(report.body.adapters.binance.state, "connected");
  gateway.stop();
});

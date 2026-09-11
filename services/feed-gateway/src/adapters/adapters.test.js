/**
 * G2/G5 — the adapter contract, against every parser and the simulator.
 *
 * The real providers need the internet and a key. What can be proven here,
 * deterministically, is that each adapter's translation of its provider's
 * dialect into canonical ticks is right (INV-120), that the shared health and
 * circuit-breaker machinery behaves (INV-121), and that the simulator — the
 * one adapter CI can run end to end — honours the whole contract including
 * the faults it injects.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { Adapter, CIRCUIT_FAILURES, aroundMid, decimal } from "./base.js";
import { klineToTicks, parseBookTicker } from "./binance.js";
import { parseTradeMessage } from "./finnhub.js";
import { Mt5Adapter, parseTickLine } from "./mt5.js";
import { SimAdapter } from "./sim.js";
import { parsePriceEvent } from "./twelvedata.js";
import { carried, toCanonical, toProvider } from "../symbols.js";

/* ------------------------------------------------------------ mapping */

test("INV-120: every provider dialect maps to a canonical symbol and back", () => {
  assert.equal(toProvider("binance", "BTCUSD"), "BTCUSDT");
  assert.equal(toCanonical("binance", "BTCUSDT"), "BTCUSD");
  assert.equal(toCanonical("finnhub", "OANDA:EUR_USD"), "EURUSD");
  assert.equal(toProvider("binance", "EURUSD"), undefined, "binance does not carry FX");
  assert.deepEqual(carried("binance", ["EURUSD", "BTCUSD"]), ["BTCUSD"]);
  assert.equal(toCanonical("nasa", "X"), undefined);
});

/* ------------------------------------------------------------ parsers */

test("binance book tickers become decimal-string ticks; anything else is dropped", () => {
  const tick = parseBookTicker({ stream: "btcusdt@bookTicker", data: { s: "BTCUSDT", b: "68200.10", a: "68201.30", u: 42 } }, 1_000);
  assert.deepEqual(tick, { symbol: "BTCUSD", ms: 1_000, bid: "68200.10", ask: "68201.30", seq: 42 });
  assert.equal(parseBookTicker({ data: { s: "ETHUSDT", b: "1", a: "2" } }, 1), null, "unmapped symbol");
  assert.equal(parseBookTicker({ data: { s: "BTCUSDT", b: "abc", a: "2" } }, 1), null, "not a decimal");
  assert.equal(parseBookTicker("nonsense", 1), null);
  assert.equal(parseBookTicker(null, 1), null);
});

test("binance klines become open/high/low/close ticks in time order", () => {
  const ticks = klineToTicks("BTCUSD", [1_000_000, "100.00", "110.00", "90.00", "105.00", "1", 1_059_999]);
  assert.equal(ticks.length, 4);
  assert.deepEqual(ticks.map((t) => t.bid), ["100.00", "110.00", "90.00", "105.00"]);
  for (let i = 1; i < ticks.length; i += 1) assert.ok((ticks[i]?.ms ?? 0) > (ticks[i - 1]?.ms ?? 0));
  assert.deepEqual(klineToTicks("BTCUSD", ["bad"]), []);
});

test("twelvedata price events use the book when sent and a nominal spread when not", () => {
  const withBook = parsePriceEvent({ event: "price", symbol: "EUR/USD", price: 1.085, bid: 1.08495, ask: 1.08505, timestamp: 1_789_000_000 }, 5);
  assert.deepEqual(withBook, { symbol: "EURUSD", ms: 1_789_000_000_000, bid: "1.08495", ask: "1.08505", seq: 0 });
  const priceOnly = parsePriceEvent({ event: "price", symbol: "XAU/USD", price: 2350.5 }, 7);
  assert.equal(priceOnly?.symbol, "XAUUSD");
  assert.equal(priceOnly?.ms, 7);
  assert.equal(priceOnly?.bid, "2350.35");
  assert.equal(priceOnly?.ask, "2350.65");
  assert.equal(parsePriceEvent({ event: "heartbeat" }, 1), null);
  assert.equal(parsePriceEvent({ event: "price", symbol: "USD/JPY", price: 150 }, 1), null, "unmapped");
});

test("finnhub trades become ticks around the trade price, one per row", () => {
  const ticks = parseTradeMessage({ type: "trade", data: [
    { s: "OANDA:EUR_USD", p: 1.085, t: 1_789_000_000_123, v: 1 },
    { s: "OANDA:XAU_USD", p: 2350, t: 1_789_000_000_456, v: 1 },
    { s: "NASDAQ:AAPL", p: 190, t: 1, v: 1 },
  ] }, 9);
  assert.equal(ticks.length, 2);
  assert.equal(ticks[0]?.symbol, "EURUSD");
  assert.equal(ticks[0]?.bid, "1.08494");
  assert.equal(ticks[0]?.ask, "1.08506");
  assert.equal(ticks[1]?.ms, 1_789_000_000_456);
  assert.deepEqual(parseTradeMessage({ type: "ping" }, 1), []);
});

test("mt5 bridge lines parse as sent, with the bridge's own timestamp", () => {
  const tick = parseTickLine('{"symbol":"XAUUSD","bid":"2350.10","ask":"2350.40","ms":1789000000000,"seq":3}', 1);
  assert.deepEqual(tick, { symbol: "XAUUSD", ms: 1_789_000_000_000, bid: "2350.10", ask: "2350.40", seq: 3 });
  assert.equal(parseTickLine("not json", 1), null);
  assert.equal(parseTickLine('{"symbol":"XAUUSD","bid":"-1","ask":"2"}', 1), null);
});

test("decimal rendering never produces a float artefact or accepts a negative", () => {
  assert.equal(decimal("1.08500", 5), "1.08500");
  assert.equal(decimal(1.085, 5), "1.08500");
  assert.equal(decimal(-1, 2), null);
  assert.equal(decimal("1e5", 2), null);
  assert.equal(decimal(Number.NaN, 2), null);
  assert.deepEqual(aroundMid("1.08500", 5, 12), { bid: "1.08494", ask: "1.08506" });
  assert.deepEqual(aroundMid("2350", 2, 30), { bid: "2349.85", ask: "2350.15" });
});

/* ----------------------------------------------------- health machinery */

test("INV-121: consecutive failures open the circuit, and a success closes it", () => {
  let now = 1_000_000;
  class Flaky extends Adapter {
    constructor() { super("flaky", { now: () => now }); this.attempts = 0; }
    connect() { this.attempts += 1; this.fail("nope"); }
  }
  const adapter = new Flaky();
  adapter.start(["EURUSD"], () => {});
  // The first attempt failed synchronously; reconnects are scheduled, not
  // run, so drive them by hand.
  for (let i = 1; i < CIRCUIT_FAILURES; i += 1) adapter.open();
  assert.equal(adapter.state, "circuit-open");
  assert.equal(adapter.errors, CIRCUIT_FAILURES);
  assert.equal(adapter.fresh(1_000), false);
  // While open, nothing is attempted.
  const attempts = adapter.attempts;
  adapter.open();
  assert.equal(adapter.attempts, attempts, "an open circuit is not retried");
  // After the window, one more attempt is allowed.
  now += 61_000;
  adapter.open();
  assert.equal(adapter.attempts, attempts + 1);
  adapter.stop();
  assert.equal(adapter.state, "idle");
});

test("an unconfigured adapter reports so and never connects", () => {
  class NeedsKey extends Adapter {
    configured() { return false; }
    connect() { throw new Error("must not be called"); }
  }
  const adapter = new NeedsKey("keyed");
  adapter.start(["EURUSD"], () => {});
  assert.equal(adapter.state, "unconfigured");
  assert.equal(adapter.health().state, "unconfigured");
});

/* ------------------------------------------------------------ simulator */

test("the simulator honours the contract: canonical ticks, fresh health, deterministic walk", async () => {
  const a = new SimAdapter({ seed: 3, intervalMs: 5 });
  const b = new SimAdapter({ seed: 3, intervalMs: 5 });
  /** @type {import("./base.js").Tick[]} */
  const got = [];
  /** @type {import("./base.js").Tick[]} */
  const again = [];
  a.start(["EURUSD", "BTCUSD"], (t) => got.push(t));
  b.start(["EURUSD", "BTCUSD"], (t) => again.push(t));
  await new Promise((r) => setTimeout(r, 60));
  a.stop();
  b.stop();
  assert.ok(got.length >= 8, `only ${got.length} ticks`);
  assert.equal(a.health().state, "idle");
  for (const tick of got) {
    assert.ok(["EURUSD", "BTCUSD"].includes(tick.symbol));
    assert.match(tick.bid, /^\d+\.\d+$/);
    assert.ok(tick.bid <= tick.ask || tick.bid.length !== tick.ask.length);
  }
  const n = Math.min(got.length, again.length);
  assert.deepEqual(got.slice(0, n).map((t) => [t.symbol, t.bid, t.ask]), again.slice(0, n).map((t) => [t.symbol, t.bid, t.ask]), "same seed, same walk");
});

test("the simulator's faults are real: duplicates, reordering, crossed quotes, a drop", async () => {
  const sim = new SimAdapter({ seed: 1, intervalMs: 2, faults: { duplicateEvery: 3, reorderEvery: 5, crossEvery: 7, dropAfter: 20 } });
  /** @type {import("./base.js").Tick[]} */
  const got = [];
  sim.start(["EURUSD"], (t) => got.push(t));
  await new Promise((r) => setTimeout(r, 120));
  const seqs = got.map((t) => t.seq);
  assert.ok(new Set(seqs).size < seqs.length, "a duplicate was emitted");
  assert.ok(seqs.some((s, i) => i > 0 && s < (seqs[i - 1] ?? 0)), "an out-of-order tick was emitted");
  assert.ok(got.some((t) => Number(t.bid) > Number(t.ask)), "a crossed quote was emitted");
  assert.ok(sim.errors >= 1, "the connection was dropped");
  sim.stop();
});

/* --------------------------------------------------------------- mt5 SSE */

test("the mt5 adapter consumes a bridge event stream and reconnects when it ends", async () => {
  let connections = 0;
  const server = http.createServer((req, res) => {
    if (String(req.url) === "/v1/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "connected", simulated: false }));
      return;
    }
    connections += 1;
    assert.match(String(req.url), /^\/v1\/ticks\?symbols=/);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"symbol":"EURUSD","bid":"1.08500","ask":"1.08520","ms":1789000000000,"seq":1}\n\n');
    res.write("event: heartbeat\ndata: {}\n\n");
    res.write('data: {"symbol":"NOPE","bid":"1","ask":"2"}\n\n');
    setTimeout(() => res.end(), 20);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  process.env.MT5_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
  const adapter = new Mt5Adapter();
  /** @type {import("./base.js").Tick[]} */
  const got = [];
  adapter.start(["EURUSD", "XAUUSD"], (t) => got.push(t));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(got.length, 1);
  assert.equal(got[0]?.bid, "1.08500");
  assert.ok(["disconnected", "connecting", "connected"].includes(adapter.state));
  assert.ok(adapter.errors >= 1, "the ended stream counted as a failure");
  adapter.stop();
  server.close();
  assert.ok(connections >= 1);
});

test("a simulated bridge is not a price source unless explicitly allowed", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": String(req.url) === "/v1/state" ? "application/json" : "text/event-stream" });
    if (String(req.url) === "/v1/state") return res.end(JSON.stringify({ state: "connected", simulated: true }));
    res.write('data: {"symbol":"EURUSD","bid":"1.08500","ask":"1.08520"}\n\n');
    return setTimeout(() => res.end(), 10);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  process.env.MT5_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
  delete process.env.MT5_ALLOW_SIMULATED;
  const refused = new Mt5Adapter();
  /** @type {import("./base.js").Tick[]} */
  const none = [];
  refused.start(["EURUSD"], (t) => none.push(t));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(refused.state, "unconfigured");
  assert.equal(none.length, 0);
  refused.stop();

  process.env.MT5_ALLOW_SIMULATED = "1";
  const allowed = new Mt5Adapter();
  /** @type {import("./base.js").Tick[]} */
  const got = [];
  allowed.start(["EURUSD"], (t) => got.push(t));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(got.length, 1);
  allowed.stop();
  delete process.env.MT5_ALLOW_SIMULATED;
  server.close();
});

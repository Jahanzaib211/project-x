/**
 * G4 — INV-200 and INV-201, at the level where they can be proven without a
 * platform: the reconciler's decisions are pure functions of the two states,
 * and the module has no write path to the ledger.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fromMilli, netByLots, plan, toMilli } from "./external.js";

test("INV-200: the reconciler names no ledger write — it reads the ledger and writes only to the OMS", () => {
  const source = readFileSync(new URL("./external.js", import.meta.url), "utf8");
  // Every forward() to the ledger must be a GET: no method, no body.
  const ledgerCalls = [...source.matchAll(/forward\(\s*UPSTREAM\.ledger,[^;]*?\)/gs)].map((m) => m[0]);
  assert.ok(ledgerCalls.length >= 2, "the ledger is read");
  for (const call of ledgerCalls) {
    assert.doesNotMatch(call, /method\s*:/, `a ledger call carries a method: ${call}`);
    assert.doesNotMatch(call, /body\s*:/, `a ledger call carries a body: ${call}`);
  }
  // The only mutating core call is the OMS front door, keyed by the ticket.
  assert.match(source, /forward\(UPSTREAM\.oms, "\/v1\/orders", \{\s*method: "POST",\s*idempotencyKey: `mt5-deal-\$\{deal\.ticket\}`/);
  assert.doesNotMatch(source, /demo-credit|demo-reset|\/v1\/accounts\/[^`]*\/status/);
});

test("net positions are signed thousandths of a lot, exactly", () => {
  assert.equal(toMilli("0.10"), 100n);
  assert.equal(toMilli("1"), 1000n);
  assert.equal(toMilli("0.001"), 1n);
  assert.equal(fromMilli(100n), "0.100");
  assert.equal(fromMilli(-2500n), "2.500");
  const net = netByLots([
    { symbol: "EURUSD", side: "BUY", volume: "0.500" },
    { symbol: "EURUSD", side: "SELL", volume: "0.200" },
    { symbol: "XAUUSD", side: "SELL", volume: "0.100" },
  ]);
  assert.equal(net.get("EURUSD"), 300n);
  assert.equal(net.get("XAUUSD"), -100n);
});

test("INV-201: the plan moves the platform to the core's net, and reports what still differs", () => {
  const ledger = netByLots([{ symbol: "EURUSD", side: "BUY", volume: "0.300" }, { symbol: "BTCUSD", side: "SELL", volume: "0.020" }]);
  // Platform: nothing in EURUSD, a BUY in BTC (wrong side), a stray XAU.
  const platform = [
    { ticket: 1, symbol: "BTCUSD", type: "BUY", volume: "0.010" },
    { ticket: 2, symbol: "XAUUSD", type: "BUY", volume: "0.100" },
  ];
  const p = plan(ledger, platform);
  assert.deepEqual(p.opens, [
    { symbol: "EURUSD", side: "BUY", volume: "0.300" },
    { symbol: "BTCUSD", side: "SELL", volume: "0.020" },
  ]);
  assert.deepEqual(p.closes.map((c) => c.ticket).sort(), [1, 2]);
  assert.equal(p.diverged.length, 3);

  // In sync: nothing to do, nothing diverged.
  const same = plan(ledger, [
    { ticket: 3, symbol: "EURUSD", type: "BUY", volume: "0.300" },
    { ticket: 4, symbol: "BTCUSD", type: "SELL", volume: "0.020" },
  ]);
  assert.deepEqual(same, { closes: [], opens: [], diverged: [] });

  // Same side, short: open the difference. Same side, long: close down.
  const short = plan(ledger, [{ ticket: 5, symbol: "EURUSD", type: "BUY", volume: "0.100" }, { ticket: 4, symbol: "BTCUSD", type: "SELL", volume: "0.020" }]);
  assert.deepEqual(short.opens, [{ symbol: "EURUSD", side: "BUY", volume: "0.200" }]);
  assert.deepEqual(short.closes, []);
  const long = plan(ledger, [
    { ticket: 6, symbol: "EURUSD", type: "BUY", volume: "0.300" },
    { ticket: 7, symbol: "EURUSD", type: "BUY", volume: "0.200" },
    { ticket: 4, symbol: "BTCUSD", type: "SELL", volume: "0.020" },
  ]);
  assert.deepEqual(long.closes, [{ ticket: 6, symbol: "EURUSD" }]);
  assert.deepEqual(long.opens, []);
});

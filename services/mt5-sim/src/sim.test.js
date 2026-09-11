/**
 * G2 — the simulated terminal behaves like a platform: deterministic prices,
 * positions that value against them, deals that record what happened.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Terminal, points, render } from "./sim.js";

test("prices are deterministic in the seed and the clock", () => {
  const a = new Terminal({ seed: 5, now: () => 1_789_000_000_000 });
  const b = new Terminal({ seed: 5, now: () => 1_789_000_000_000 });
  assert.deepEqual(a.tick("EURUSD")?.bid, b.tick("EURUSD")?.bid);
  assert.notEqual(a.tick("EURUSD", 1_789_000_000_000)?.bid, a.tick("EURUSD", 1_789_000_060_000)?.bid);
  assert.equal(a.tick("NOPE"), null);
  assert.equal(a.symbols().length, 5);
  assert.equal(a.candles("XAUUSD", "M1", 3).length, 3);
});

test("a round trip moves the platform's balance by the realised profit", () => {
  let now = 1_789_000_000_000;
  const t = new Terminal({ seed: 2, now: () => now });
  const opened = t.open({ symbol: "BTCUSD", type: "BUY", volume: "0.100", comment: "order-42" });
  assert.equal(opened.retcode, 10009);
  assert.equal(t.listPositions().length, 1);
  assert.equal(t.dealsSince(0).length, 1);
  assert.equal(t.dealsSince(0)[0]?.comment, "order-42");
  now += 60_000;
  const account = t.account();
  assert.match(account.equity, /^-?\d+\.\d\d$/);
  const closed = t.close(opened.order ?? 0);
  assert.equal(closed.retcode, 10009);
  const expected = 1_000_000n + points(closed.profit ?? "0", 2);
  assert.equal(t.account().balance, render(expected, 2));
  assert.equal(t.listPositions().length, 0);
  assert.equal(t.dealsSince(0).length, 2);
  assert.equal(t.dealsSince(0)[1]?.entry, "OUT");
  assert.equal(t.close(999).retcode, 10036);
  assert.equal(t.open({ symbol: "NOPE", type: "BUY", volume: "1" }).retcode, 10014);
});

test("decimal helpers are exact", () => {
  assert.equal(render(108_500n, 5), "1.08500");
  assert.equal(render(-250n, 2), "-2.50");
  assert.equal(points("1.08500", 5), 108_500n);
  assert.equal(points("-2.5", 2), -250n);
});

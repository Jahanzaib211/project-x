/**
 * MT5 — ticks from the MT5 bridge (`21-external`) over server-sent events.
 *
 * The bridge speaks the Project X bridge protocol whether it is the real
 * terminal under Wine or the simulator: `GET /v1/ticks?symbols=…` streams
 * `data: {"symbol":"EURUSD","bid":"1.08500","ask":"1.08520","ms":…}` lines.
 * Needs `MT5_BRIDGE_URL`; unconfigured without it.
 *
 * A bridge that reports itself *simulated* is not a price source: its walk
 * is a test fixture, and pricing clients on it would be pricing them on
 * nothing. It is refused unless `MT5_ALLOW_SIMULATED=1` says otherwise —
 * which the end-to-end suite does, and a deployment never should.
 */

import { Adapter, decimal } from "./base.js";
import { toCanonical, toProvider } from "../symbols.js";

/**
 * One SSE `data:` payload as a canonical tick.
 * @param {string} line The JSON after `data:`.
 * @param {number} arrivalMs
 * @returns {import("./base.js").Tick|null}
 */
export function parseTickLine(line, arrivalMs) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const m = /** @type {Record<string, unknown>} */ (message);
  const symbol = toCanonical("mt5", String(m.symbol ?? ""));
  if (!symbol) return null;
  const bid = decimal(m.bid, 8);
  const ask = decimal(m.ask, 8);
  if (!bid || !ask) return null;
  return {
    symbol,
    ms: typeof m.ms === "number" ? m.ms : arrivalMs,
    bid,
    ask,
    seq: typeof m.seq === "number" ? m.seq : 0,
  };
}

export class Mt5Adapter extends Adapter {
  constructor() {
    super("mt5");
    this.url = process.env.MT5_BRIDGE_URL ?? "";
    this.allowSimulated = process.env.MT5_ALLOW_SIMULATED === "1";
    /** @type {AbortController|null} */
    this.controller = null;
  }

  configured() {
    return this.url.length > 0;
  }

  connect() {
    const symbols = this.symbols.map((s) => toProvider("mt5", s)).filter((s) => s !== undefined);
    if (symbols.length === 0) {
      this.state = "idle";
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    void this.check(symbols, controller);
  }

  /**
   * Ask the bridge what it is before pricing anything on it.
   * @param {string[]} symbols
   * @param {AbortController} controller
   */
  async check(symbols, controller) {
    try {
      const response = await fetch(`${this.url}/v1/state`, { signal: controller.signal });
      const state = /** @type {{state?: string, simulated?: boolean, detail?: string}} */ (await response.json());
      if (state.simulated && !this.allowSimulated) {
        this.state = "unconfigured";
        this.detail = "the bridge is simulated; set MT5_ALLOW_SIMULATED=1 to price on it";
        return;
      }
      if (state.state !== "connected") {
        this.fail(`bridge is ${state.state ?? "unknown"}: ${state.detail ?? ""}`);
        return;
      }
    } catch (error) {
      if (this.controller === controller) this.fail(`bridge state unavailable: ${String(error)}`);
      return;
    }
    const url = `${this.url}/v1/ticks?symbols=${encodeURIComponent(symbols.join(","))}`;
    void this.consume(url, controller);
  }

  /**
   * @param {string} url
   * @param {AbortController} controller
   */
  async consume(url, controller) {
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      if (!response.ok || !response.body) {
        this.fail(`bridge returned ${response.status}`);
        return;
      }
      this.up();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("data:")) {
            const tick = parseTickLine(line.slice(5).trim(), this.now());
            if (tick) this.emit(tick);
          }
          newline = buffer.indexOf("\n");
        }
      }
      if (this.controller === controller) this.fail("bridge stream ended");
    } catch (error) {
      if (this.controller === controller) this.fail(`bridge stream failed: ${String(error)}`);
    }
  }

  disconnect() {
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
  }

  /**
   * The bridge's own candle history, as ticks — open, high, low, close per
   * minute — so a symbol that has just switched to this source has a day of
   * chart behind it rather than a few minutes.
   * @param {string} symbol
   * @param {number} sinceMs
   */
  async backfill(symbol, sinceMs) {
    const theirs = toProvider("mt5", symbol);
    if (!theirs) return [];
    const count = Math.min(2_000, Math.max(1, Math.ceil((Date.now() - sinceMs) / 60_000)));
    const response = await fetch(
      `${this.url}/v1/candles?symbol=${encodeURIComponent(theirs)}&timeframe=M1&count=${count}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error(`bridge candles ${response.status}`);
    const rows = /** @type {{ms: number, open: string, high: string, low: string, close: string}[]} */ (await response.json());
    /** @type {import("./base.js").Tick[]} */
    const ticks = [];
    for (const row of rows) {
      if (typeof row.ms !== "number" || row.ms < sinceMs) continue;
      const o = decimal(row.open, 8);
      const h = decimal(row.high, 8);
      const l = decimal(row.low, 8);
      const c = decimal(row.close, 8);
      if (!o || !h || !l || !c) continue;
      ticks.push(
        { symbol, ms: row.ms, bid: o, ask: o, seq: 0 },
        { symbol, ms: row.ms + 15_000, bid: h, ask: h, seq: 1 },
        { symbol, ms: row.ms + 30_000, bid: l, ask: l, seq: 2 },
        { symbol, ms: row.ms + 59_999, bid: c, ask: c, seq: 3 },
      );
    }
    return ticks;
  }
}

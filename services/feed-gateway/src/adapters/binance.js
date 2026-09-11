/**
 * Binance — spot book tickers over WebSocket. Keyless.
 *
 * `wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker`
 * delivers `{stream, data:{s, b, a, ...}}` on every best-bid/ask change:
 * `b` and `a` are decimal strings, which is exactly what the core wants.
 *
 * Backfill: `GET /api/v3/klines` gives a day of 1-minute candles; each one
 * is turned into four ticks (open, high, low, close) so the record's own
 * candle builder recovers the shape of the day.
 */

import { Adapter, decimal } from "./base.js";
import { toCanonical, toProvider } from "../symbols.js";

const WS_URL = process.env.BINANCE_WS_URL ?? "wss://stream.binance.com:9443/stream";
const REST_URL = process.env.BINANCE_REST_URL ?? "https://api.binance.com";

/**
 * One book-ticker message as a canonical tick, or null if it is not one.
 * Pure, so the parser is testable without a socket.
 * @param {unknown} message
 * @param {number} arrivalMs
 * @returns {import("./base.js").Tick|null}
 */
export function parseBookTicker(message, arrivalMs) {
  if (!message || typeof message !== "object") return null;
  const data = /** @type {{data?: Record<string, unknown>}} */ (message).data;
  if (!data || typeof data !== "object") return null;
  const symbol = toCanonical("binance", String(data.s ?? ""));
  if (!symbol) return null;
  const bid = decimal(data.b, 2);
  const ask = decimal(data.a, 2);
  if (!bid || !ask) return null;
  const seq = typeof data.u === "number" ? data.u : 0;
  return { symbol, ms: arrivalMs, bid, ask, seq };
}

/**
 * A Binance kline row as four ticks.
 * @param {string} symbol Canonical.
 * @param {unknown[]} row
 * @returns {import("./base.js").Tick[]}
 */
export function klineToTicks(symbol, row) {
  const [openTime, open, high, low, close, , closeTime] = row;
  if (typeof openTime !== "number" || typeof closeTime !== "number") return [];
  const o = decimal(open, 2);
  const h = decimal(high, 2);
  const l = decimal(low, 2);
  const c = decimal(close, 2);
  if (!o || !h || !l || !c) return [];
  const span = Math.max(1, closeTime - openTime);
  return [
    { symbol, ms: openTime, bid: o, ask: o, seq: 0 },
    { symbol, ms: openTime + Math.floor(span / 4), bid: h, ask: h, seq: 1 },
    { symbol, ms: openTime + Math.floor(span / 2), bid: l, ask: l, seq: 2 },
    { symbol, ms: closeTime - 1, bid: c, ask: c, seq: 3 },
  ];
}

export class BinanceAdapter extends Adapter {
  constructor() {
    super("binance");
    /** @type {WebSocket|null} */
    this.socket = null;
  }

  connect() {
    const streams = this.symbols
      .map((s) => toProvider("binance", s))
      .filter((s) => s !== undefined)
      .map((s) => `${String(s).toLowerCase()}@bookTicker`);
    if (streams.length === 0) {
      this.state = "idle";
      this.detail = "no symbols carried";
      return;
    }
    const socket = new WebSocket(`${WS_URL}?streams=${streams.join("/")}`);
    this.socket = socket;
    socket.addEventListener("open", () => this.up());
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const tick = parseBookTicker(message, this.now());
      if (tick) this.emit(tick);
    });
    socket.addEventListener("error", () => this.fail("websocket error"));
    socket.addEventListener("close", (event) => {
      if (this.socket === socket) this.fail(`websocket closed (${event.code})`);
    });
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
  }

  /**
   * @param {string} symbol
   * @param {number} sinceMs
   */
  async backfill(symbol, sinceMs) {
    const theirs = toProvider("binance", symbol);
    if (!theirs) return [];
    /** @type {import("./base.js").Tick[]} */
    const ticks = [];
    let start = sinceMs;
    // A thousand one-minute klines per page; a day is two pages. Bounded so
    // a provider that keeps answering cannot turn a backfill into a loop.
    for (let page = 0; page < 4; page += 1) {
      const url = `${REST_URL}/api/v3/klines?symbol=${theirs}&interval=1m&startTime=${start}&limit=1000`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`binance klines ${response.status}`);
      const rows = /** @type {unknown[][]} */ (await response.json());
      if (rows.length === 0) break;
      ticks.push(...rows.flatMap((row) => klineToTicks(symbol, row)));
      const last = rows[rows.length - 1];
      const closeTime = last ? last[6] : undefined;
      if (typeof closeTime !== "number" || rows.length < 1000 || closeTime >= this.now()) break;
      start = closeTime + 1;
    }
    return ticks;
  }
}

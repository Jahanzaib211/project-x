/**
 * Finnhub — FX (via OANDA) and crypto trades over WebSocket. Needs
 * `FINNHUB_API_KEY`.
 *
 * `wss://ws.finnhub.io?token=…`, subscribe per symbol with
 * `{"type":"subscribe","symbol":"OANDA:EUR_USD"}`, receive
 * `{type:"trade", data:[{s, p, t, v}]}`. Trades, not a book: bid and ask are
 * placed around the trade price at the instrument's nominal spread.
 */

import { Adapter, aroundMid, decimal } from "./base.js";
import { GRID } from "./twelvedata.js";
import { toCanonical, toProvider } from "../symbols.js";

const WS_URL = process.env.FINNHUB_WS_URL ?? "wss://ws.finnhub.io";

/**
 * @param {unknown} message
 * @param {number} arrivalMs
 * @returns {import("./base.js").Tick[]}
 */
export function parseTradeMessage(message, arrivalMs) {
  if (!message || typeof message !== "object") return [];
  const m = /** @type {{type?: string, data?: unknown[]}} */ (message);
  if (m.type !== "trade" || !Array.isArray(m.data)) return [];
  /** @type {import("./base.js").Tick[]} */
  const ticks = [];
  m.data.forEach((row, index) => {
    if (!row || typeof row !== "object") return;
    const r = /** @type {Record<string, unknown>} */ (row);
    const symbol = toCanonical("finnhub", String(r.s ?? ""));
    if (!symbol) return;
    const grid = GRID[/** @type {keyof typeof GRID} */ (symbol)];
    const price = decimal(r.p, grid.digits);
    if (!price) return;
    const around = aroundMid(price, grid.digits, grid.spreadPoints);
    ticks.push({
      symbol,
      ms: typeof r.t === "number" ? r.t : arrivalMs,
      bid: around.bid,
      ask: around.ask,
      seq: index,
    });
  });
  return ticks;
}

export class FinnhubAdapter extends Adapter {
  constructor() {
    super("finnhub");
    this.key = process.env.FINNHUB_API_KEY ?? "";
    /** @type {WebSocket|null} */
    this.socket = null;
  }

  configured() {
    return this.key.length > 0;
  }

  connect() {
    const symbols = this.symbols.map((s) => toProvider("finnhub", s)).filter((s) => s !== undefined);
    if (symbols.length === 0) {
      this.state = "idle";
      return;
    }
    const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(this.key)}`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      for (const symbol of symbols) socket.send(JSON.stringify({ type: "subscribe", symbol }));
      this.up();
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.type === "error") {
        this.fail(`provider error: ${String(message.msg ?? "")}`);
        return;
      }
      for (const tick of parseTradeMessage(message, this.now())) this.emit(tick);
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
}

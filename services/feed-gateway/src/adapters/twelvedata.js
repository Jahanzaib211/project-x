/**
 * Twelve Data — FX and metals over WebSocket. Needs `TWELVEDATA_API_KEY`.
 *
 * `wss://ws.twelvedata.com/v1/quotes/price?apikey=…`, subscribe with
 * `{"action":"subscribe","params":{"symbols":"EUR/USD,XAU/USD"}}`, and
 * receive `{event:"price", symbol, price, timestamp, bid?, ask?}`. The free
 * tier sends a price and often no book; the book is then placed around the
 * price at the instrument's nominal spread.
 */

import { Adapter, aroundMid, decimal } from "./base.js";
import { toCanonical, toProvider } from "../symbols.js";

const WS_URL = process.env.TWELVEDATA_WS_URL ?? "wss://ws.twelvedata.com/v1/quotes/price";

/** Digits and nominal spread per canonical symbol, for price-only feeds. */
export const GRID = {
  EURUSD: { digits: 5, spreadPoints: 12 },
  GBPUSD: { digits: 5, spreadPoints: 16 },
  AUDUSD: { digits: 5, spreadPoints: 18 },
  XAUUSD: { digits: 2, spreadPoints: 30 },
  BTCUSD: { digits: 2, spreadPoints: 1200 },
};

/**
 * @param {unknown} message
 * @param {number} arrivalMs
 * @returns {import("./base.js").Tick|null}
 */
export function parsePriceEvent(message, arrivalMs) {
  if (!message || typeof message !== "object") return null;
  const m = /** @type {Record<string, unknown>} */ (message);
  if (m.event !== "price") return null;
  const symbol = toCanonical("twelvedata", String(m.symbol ?? ""));
  if (!symbol) return null;
  const grid = GRID[/** @type {keyof typeof GRID} */ (symbol)];
  const bid = decimal(m.bid, grid.digits);
  const ask = decimal(m.ask, grid.digits);
  const ms = typeof m.timestamp === "number" ? m.timestamp * 1000 : arrivalMs;
  if (bid && ask) return { symbol, ms, bid, ask, seq: 0 };
  const price = decimal(m.price, grid.digits);
  if (!price) return null;
  const around = aroundMid(price, grid.digits, grid.spreadPoints);
  return { symbol, ms, bid: around.bid, ask: around.ask, seq: 0 };
}

export class TwelveDataAdapter extends Adapter {
  constructor() {
    super("twelvedata");
    this.key = process.env.TWELVEDATA_API_KEY ?? "";
    /** @type {WebSocket|null} */
    this.socket = null;
  }

  configured() {
    return this.key.length > 0;
  }

  connect() {
    const symbols = this.symbols.map((s) => toProvider("twelvedata", s)).filter((s) => s !== undefined);
    if (symbols.length === 0) {
      this.state = "idle";
      return;
    }
    const socket = new WebSocket(`${WS_URL}?apikey=${encodeURIComponent(this.key)}`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ action: "subscribe", params: { symbols: symbols.join(",") } }));
      this.up();
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.event === "subscribe-status" && message.status === "error") {
        this.fail(`subscribe refused: ${JSON.stringify(message.fails ?? message)}`);
        return;
      }
      const tick = parsePriceEvent(message, this.now());
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
}

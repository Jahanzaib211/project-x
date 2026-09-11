/**
 * Live updates over server-sent events.
 *
 * The terminal used to poll: the quote at 800ms, the account at 2s, the chart
 * at 3s — three timers per tab, each a full request. This is the same data
 * pushed once, when it changes, over one connection per tab:
 *
 * - `quote`   the client quote for the symbol, with its session state
 * - `candle`  the newest candle of the symbol at the chosen interval
 * - `account` the account's valuation, when the ledger's version moves
 * - `orders`  the account's order history, when its length moves
 *
 * Polling of the *core* still happens, here, once per symbol or account
 * rather than once per browser tab: a poller is shared by every subscriber
 * that wants the same thing and stopped when the last one leaves. The edge
 * still computes nothing; every event body is a core response forwarded
 * verbatim (INV-180).
 */

import { forward, UPSTREAM } from "./core.js";

/** How often each kind of state is read from the core. */
const CADENCE_MS = { quote: 250, candle: 1_000, account: 1_000, orders: 2_000 };
/** A comment line, so proxies and browsers know the stream is alive. */
const KEEPALIVE_MS = 15_000;

/**
 * @typedef {object} Subscriber
 * @property {import("node:http").ServerResponse} res
 * @property {(event: string, data: string) => void} send
 */

/**
 * A shared poller: one timer, many listeners, stopped when empty.
 */
class Poller {
  /**
   * @param {string} event
   * @param {number} cadenceMs
   * @param {() => Promise<string|null>} read Returns the JSON body, or null to skip.
   */
  constructor(event, cadenceMs, read) {
    this.event = event;
    this.cadenceMs = cadenceMs;
    this.read = read;
    /** @type {Set<Subscriber>} */
    this.listeners = new Set();
    /** @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
    /** @type {string|null} */
    this.last = null;
    this.busy = false;
  }

  /** @param {Subscriber} subscriber */
  add(subscriber) {
    this.listeners.add(subscriber);
    if (this.last !== null) subscriber.send(this.event, this.last);
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.cadenceMs);
      void this.tick();
    }
  }

  /** @param {Subscriber} subscriber */
  remove(subscriber) {
    this.listeners.delete(subscriber);
    if (this.listeners.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.last = null;
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const body = await this.read();
      if (body !== null && body !== this.last) {
        this.last = body;
        for (const subscriber of this.listeners) subscriber.send(this.event, body);
      }
    } catch {
      /* the next tick is a fresh read; nothing to tell the browser */
    } finally {
      this.busy = false;
    }
  }
}

/** @type {Map<string, Poller>} */
const pollers = new Map();

/**
 * @param {string} key
 * @param {() => Poller} make
 */
function poller(key, make) {
  let found = pollers.get(key);
  if (!found) {
    found = make();
    pollers.set(key, found);
  }
  return found;
}

/**
 * The quote poller for a symbol: the client quote, as pricing serves it.
 * @param {string} symbol
 */
function quotePoller(symbol) {
  return poller(`quote:${symbol}`, () => new Poller("quote", CADENCE_MS.quote, async () => {
    const result = await forward(UPSTREAM.pricing, `/v1/quote?symbol=${encodeURIComponent(symbol)}`);
    // Stale is a state worth showing, not an error to hide.
    return result.ok || result.status === 409 ? JSON.stringify(result.body) : null;
  }));
}

/**
 * @param {string} symbol
 * @param {string} interval
 */
function candlePoller(symbol, interval) {
  return poller(`candle:${symbol}:${interval}`, () => new Poller("candle", CADENCE_MS.candle, async () => {
    const result = await forward(
      UPSTREAM.marketData,
      `/v1/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=2`,
    );
    if (!result.ok) return null;
    const candles = /** @type {unknown[]} */ (result.body.candles ?? []);
    // The newest two: the growing one and the one just closed, so a client
    // that missed the boundary still receives the completed candle.
    return JSON.stringify({ symbol, interval, digits: result.body.digits, source: result.body.source, candles });
  }));
}

/** @param {string} account */
function accountPoller(account) {
  return poller(`account:${account}`, () => new Poller("account", CADENCE_MS.account, async () => {
    const result = await forward(UPSTREAM.ledger, `/v1/accounts/${encodeURIComponent(account)}/state`);
    return result.ok ? JSON.stringify(result.body) : null;
  }));
}

/** @param {string} account */
function ordersPoller(account) {
  return poller(`orders:${account}`, () => new Poller("orders", CADENCE_MS.orders, async () => {
    const result = await forward(UPSTREAM.ledger, `/v1/accounts/${encodeURIComponent(account)}/orders`);
    return result.ok ? JSON.stringify(result.body) : null;
  }));
}

/**
 * Serve one stream until the client goes away.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{symbol: string|null, interval: string, account: string|null}} wants
 */
export function serveStream(req, res, wants) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");

  /** @type {Subscriber} */
  const subscriber = {
    res,
    send(event, data) {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${data}\n\n`);
    },
  };

  /** @type {Poller[]} */
  const joined = [];
  if (wants.symbol) {
    joined.push(quotePoller(wants.symbol), candlePoller(wants.symbol, wants.interval));
  }
  if (wants.account) {
    joined.push(accountPoller(wants.account), ordersPoller(wants.account));
  }
  for (const p of joined) p.add(subscriber);

  const keepalive = setInterval(() => subscriber.send("ping", String(Date.now())), KEEPALIVE_MS);
  const leave = () => {
    clearInterval(keepalive);
    for (const p of joined) p.remove(subscriber);
    if (!res.writableEnded) res.end();
  };
  req.on("close", leave);
  req.on("error", leave);
}

/** How many pollers are running, for the status view. */
export function pollerCount() {
  let running = 0;
  for (const p of pollers.values()) if (p.timer) running += 1;
  return running;
}

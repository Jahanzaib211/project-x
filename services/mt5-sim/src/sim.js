/**
 * The simulated MT5 terminal: symbols, a price walk, an account, positions,
 * deals. Deterministic from a seed, so a test can assert exact figures.
 *
 * This is a *platform*, not a broker (INV-200): its account balance is its
 * own bookkeeping and is never the core's truth. The reconciler compares
 * this against the ledger and raises a break when they diverge — which is
 * the whole point of having something to compare against.
 */

/** A splitmix64-style mix. */
function mix(/** @type {bigint} */ x) {
  x = (x + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
  return x ^ (x >> 31n);
}

/** @type {Record<string, {digits: number, contractSize: number, ref: bigint, spread: number, description: string}>} */
export const SYMBOLS = {
  EURUSD: { digits: 5, contractSize: 100_000, ref: 108_500n, spread: 12, description: "Euro vs US Dollar" },
  GBPUSD: { digits: 5, contractSize: 100_000, ref: 127_000n, spread: 16, description: "Great Britain Pound vs US Dollar" },
  AUDUSD: { digits: 5, contractSize: 100_000, ref: 65_800n, spread: 18, description: "Australian Dollar vs US Dollar" },
  XAUUSD: { digits: 2, contractSize: 100, ref: 235_000n, spread: 30, description: "Gold vs US Dollar" },
  BTCUSD: { digits: 2, contractSize: 1, ref: 6_820_000n, spread: 1200, description: "Bitcoin vs US Dollar" },
};

/**
 * @param {bigint} points
 * @param {number} digits
 */
export function render(points, digits) {
  const negative = points < 0n;
  const s = (negative ? -points : points).toString().padStart(digits + 1, "0");
  const text = digits === 0 ? s : `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  return negative ? `-${text}` : text;
}

/**
 * @param {string} text Decimal string.
 * @param {number} digits
 */
export function points(text, digits) {
  const negative = text.startsWith("-");
  const [whole = "0", frac = ""] = text.replace("-", "").split(".");
  const value = BigInt(whole) * 10n ** BigInt(digits) + BigInt((frac + "0".repeat(digits)).slice(0, digits));
  return negative ? -value : value;
}

export class Terminal {
  /**
   * @param {{seed?: number, now?: () => number, login?: string, server?: string}} [options]
   */
  constructor(options = {}) {
    this.seed = BigInt(options.seed ?? 11);
    this.now = options.now ?? Date.now;
    this.login = options.login ?? "1000001";
    this.server = options.server ?? "ProjectX-Sim";
    this.currency = "USD";
    this.leverage = 500;
    /** Balance in cents, the platform's own bookkeeping. */
    this.balanceCents = 1_000_000n;
    this.nextTicket = 1;
    this.tickSeq = 0;
    /** @type {{ticket: number, symbol: string, type: "BUY"|"SELL", volumeMilli: number, priceOpen: string, comment: string, timeMs: number}[]} */
    this.positions = [];
    /** @type {{ticket: number, order: number, positionId: number, symbol: string, type: "BUY"|"SELL", entry: "IN"|"OUT", volume: string, price: string, profit: string, commission: string, comment: string, timeMs: number}[]} */
    this.deals = [];
  }

  /** The mid at a moment, in points. Deterministic in (seed, symbol, ms/500). */
  /** @param {string} symbol @param {number} ms */
  mid(symbol, ms) {
    const spec = SYMBOLS[symbol];
    if (!spec) return null;
    const step = BigInt(Math.floor(ms / 500));
    const h = mix(this.seed * 1_000_003n + step * 13n + BigInt(symbol.charCodeAt(0)));
    const span = spec.ref / 400n;
    return spec.ref + ((h % (2n * span + 1n)) - span);
  }

  /** @param {string} symbol @param {number} [ms] */
  tick(symbol, ms = this.now()) {
    const spec = SYMBOLS[symbol];
    const mid = this.mid(symbol, ms);
    if (!spec || mid === null) return null;
    const half = BigInt(Math.ceil(spec.spread / 2));
    this.tickSeq += 1;
    return { symbol, bid: render(mid - half, spec.digits), ask: render(mid + half, spec.digits), ms, seq: this.tickSeq };
  }

  symbols() {
    return Object.entries(SYMBOLS).map(([symbol, s]) => ({ symbol, digits: s.digits, contractSize: s.contractSize, description: s.description }));
  }

  /**
   * @param {string} symbol
   * @param {string} timeframe M1|M5|M15|H1
   * @param {number} count
   */
  candles(symbol, timeframe, count) {
    const spec = SYMBOLS[symbol];
    if (!spec) return [];
    const minutes = { M1: 1, M5: 5, M15: 15, H1: 60 }[timeframe] ?? 1;
    const span = minutes * 60_000;
    const end = Math.floor(this.now() / span) * span;
    const out = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const open = end - i * span;
      let o = null, h = 0n, l = 0n, c = 0n;
      for (let t = open; t < open + span; t += 500) {
        const m = this.mid(symbol, t);
        if (m === null) continue;
        if (o === null) { o = m; h = m; l = m; }
        h = m > h ? m : h;
        l = m < l ? m : l;
        c = m;
      }
      if (o === null) continue;
      out.push({ ms: open, open: render(o, spec.digits), high: render(h, spec.digits), low: render(l, spec.digits), close: render(c, spec.digits), volume: "0" });
    }
    return out;
  }

  /** Unrealised profit of a position in cents, at the current price. */
  /** @param {(typeof this.positions)[number]} position */
  profitCents(position) {
    const spec = SYMBOLS[position.symbol];
    const t = this.tick(position.symbol);
    if (!spec || !t) return 0n;
    const current = points(position.type === "BUY" ? t.bid : t.ask, spec.digits);
    const open = points(position.priceOpen, spec.digits);
    const diff = position.type === "BUY" ? current - open : open - current;
    // diff is in points; value = diff / 10^digits * contractSize * lots; in cents ×100.
    const lotsMilli = BigInt(position.volumeMilli);
    return (diff * BigInt(spec.contractSize) * lotsMilli * 100n) / (10n ** BigInt(spec.digits) * 1000n);
  }

  account() {
    const unrealised = this.positions.reduce((sum, p) => sum + this.profitCents(p), 0n);
    const margin = this.positions.reduce((sum, p) => {
      const spec = SYMBOLS[p.symbol];
      if (!spec) return sum;
      const open = points(p.priceOpen, spec.digits);
      const notional = (open * BigInt(spec.contractSize) * BigInt(p.volumeMilli) * 100n) / (10n ** BigInt(spec.digits) * 1000n);
      return sum + notional / BigInt(this.leverage);
    }, 0n);
    const equity = this.balanceCents + unrealised;
    return {
      login: this.login,
      currency: this.currency,
      leverage: this.leverage,
      balance: render(this.balanceCents, 2),
      equity: render(equity, 2),
      margin: render(margin, 2),
      freeMargin: render(equity - margin, 2),
    };
  }

  listPositions() {
    return this.positions.map((p) => {
      const t = this.tick(p.symbol);
      return {
        ticket: p.ticket,
        symbol: p.symbol,
        type: p.type,
        volume: render(BigInt(p.volumeMilli), 3),
        priceOpen: p.priceOpen,
        priceCurrent: t ? (p.type === "BUY" ? t.bid : t.ask) : p.priceOpen,
        profit: render(this.profitCents(p), 2),
        comment: p.comment,
        timeMs: p.timeMs,
      };
    });
  }

  /** @param {number} since */
  dealsSince(since) {
    return this.deals.filter((d) => d.ticket > since);
  }

  /**
   * Open a position, as the terminal would on `order_send`.
   * @param {{symbol: string, type: "BUY"|"SELL", volume: string, comment?: string}} order
   */
  open(order) {
    const spec = SYMBOLS[order.symbol];
    if (!spec) return { retcode: 10014, detail: "invalid symbol" };
    if (order.type !== "BUY" && order.type !== "SELL") return { retcode: 10013, detail: "invalid type" };
    const volumeMilli = Number(points(order.volume, 3));
    if (!Number.isFinite(volumeMilli) || volumeMilli <= 0) return { retcode: 10014, detail: "invalid volume" };
    const t = this.tick(order.symbol);
    if (!t) return { retcode: 10018, detail: "market closed" };
    const price = order.type === "BUY" ? t.ask : t.bid;
    const ticket = this.nextTicket++;
    const dealTicket = this.nextTicket++;
    const comment = order.comment ?? "";
    this.positions.push({ ticket, symbol: order.symbol, type: order.type, volumeMilli, priceOpen: price, comment, timeMs: this.now() });
    this.deals.push({ ticket: dealTicket, order: ticket, positionId: ticket, symbol: order.symbol, type: order.type, entry: "IN", volume: order.volume, price, profit: "0.00", commission: "0.00", comment, timeMs: this.now() });
    return { retcode: 10009, order: ticket, deal: dealTicket, price };
  }

  /** @param {number} ticket */
  close(ticket) {
    const index = this.positions.findIndex((p) => p.ticket === ticket);
    const position = this.positions[index];
    if (index === -1 || !position) return { retcode: 10036, detail: "position not found" };
    const t = this.tick(position.symbol);
    if (!t) return { retcode: 10018, detail: "market closed" };
    const profit = this.profitCents(position);
    const price = position.type === "BUY" ? t.bid : t.ask;
    this.positions.splice(index, 1);
    this.balanceCents += profit;
    const dealTicket = this.nextTicket++;
    this.deals.push({ ticket: dealTicket, order: this.nextTicket++, positionId: position.ticket, symbol: position.symbol, type: position.type === "BUY" ? "SELL" : "BUY", entry: "OUT", volume: render(BigInt(position.volumeMilli), 3), price, profit: render(profit, 2), commission: "0.00", comment: position.comment, timeMs: this.now() });
    return { retcode: 10009, order: dealTicket, deal: dealTicket, price, profit: render(profit, 2) };
  }
}

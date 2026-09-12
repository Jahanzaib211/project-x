/**
 * The gateway: which provider speaks for which instrument, and when.
 *
 * ## The rules (INV-120, INV-121)
 *
 * - market-data owns the configuration: per instrument class, an ordered list
 *   of sources. The gateway *reads* it (every few seconds) and runs whichever
 *   adapters the lists name. The console changes market-data; nothing changes
 *   here directly.
 * - For every symbol, exactly one source is **selected**: the first in its
 *   class's list that is configured, connected and has delivered recently.
 *   Only the selected source's ticks are forwarded. When it goes quiet or
 *   fails, the next one that is delivering takes over — that is failover,
 *   and it is decided here, in one place, per symbol.
 * - A source that is failing is behind its own circuit breaker (see
 *   `adapters/base.js`) and is skipped in selection: isolated, not retried in
 *   the request path, and never able to poison another source's symbols.
 * - Ticks are batched for 250ms and pushed to `POST /v1/feed/ticks`. Adapter
 *   health is pushed to `POST /v1/feed/health` so the console can see it.
 *
 * The gateway holds no price. A tick it does not forward is gone, which is
 * correct: market-data's record is the only record.
 */

import { BinanceAdapter } from "./adapters/binance.js";
import { FinnhubAdapter } from "./adapters/finnhub.js";
import { Mt5Adapter } from "./adapters/mt5.js";
import { SimAdapter } from "./adapters/sim.js";
import { TwelveDataAdapter } from "./adapters/twelvedata.js";
import { carried } from "./symbols.js";

/** A source counts as delivering if it ticked within this window. */
export const FRESH_MS = 15_000;
/** How often the configuration is re-read from market-data. */
export const CONFIG_POLL_MS = 5_000;
/** How long ticks are batched before a push. */
export const FLUSH_MS = 250;
/** Backfill this much history when a source first takes over a symbol. */
export const BACKFILL_MS = 24 * 3_600_000;

/**
 * @typedef {object} GatewayOptions
 * @property {string} marketDataUrl
 * @property {Record<string, import("./adapters/base.js").Adapter>} [adapters]
 * @property {() => number} [now]
 * @property {(level: string, message: string, fields?: Record<string, unknown>) => void} [log]
 * @property {typeof fetch} [fetch]
 */

/**
 * The adapters this process runs.
 *
 * `FEED_ADAPTERS` names them (comma-separated); unset means every real
 * provider. A test stack sets it to `mt5` so nothing reaches the internet and
 * every price is the simulator's deterministic walk. `sim-lp` is only ever
 * present when asked for.
 */
function defaultAdapters() {
  /** @type {Record<string, () => import("./adapters/base.js").Adapter>} */
  const available = {
    binance: () => new BinanceAdapter(),
    twelvedata: () => new TwelveDataAdapter(),
    finnhub: () => new FinnhubAdapter(),
    mt5: () => new Mt5Adapter(),
    "sim-lp": () => new SimAdapter(),
  };
  const wanted = (process.env.FEED_ADAPTERS ?? "binance,twelvedata,finnhub,mt5")
    .split(",").map((s) => s.trim()).filter((s) => s in available);
  if (process.env.SIM_LP === "1" && !wanted.includes("sim-lp")) wanted.push("sim-lp");
  /** @type {Record<string, import("./adapters/base.js").Adapter>} */
  const adapters = {};
  for (const name of wanted) {
    const make = available[name];
    if (make) adapters[name] = make();
  }
  return adapters;
}

/** The instruments per class, mirroring market-core's table. */
export const CLASSES = {
  "FX major": ["EURUSD", "GBPUSD", "AUDUSD"],
  Metal: ["XAUUSD"],
  Crypto: ["BTCUSD"],
};

export class Gateway {
  /** @param {GatewayOptions} options */
  constructor(options) {
    this.marketDataUrl = options.marketDataUrl;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.fetch = options.fetch ?? fetch;
    /** @type {Record<string, import("./adapters/base.js").Adapter>} */
    this.adapters = options.adapters ?? defaultAdapters();
    /** @type {Record<string, string[]>} class → sources */
    this.config = {};
    /** @type {Map<string, string>} symbol → selected source */
    this.selected = new Map();
    /** @type {Map<string, Map<string, import("./adapters/base.js").Tick>>} source → symbol → latest tick this batch */
    this.pending = new Map();
    /** @type {Set<string>} `${source}:${symbol}` already backfilled */
    this.backfilled = new Set();
    /** @type {Map<string, string[]>} source → symbols it is started for */
    this.running = new Map();
    this.counters = { forwarded: 0, dropped: 0, pushes: 0, pushFailures: 0, failovers: 0 };
    /** @type {ReturnType<typeof setInterval>[]} */
    this.timers = [];
    /** @type {string|null} */
    this.lastPushError = null;
  }

  /** Begin: read the config, start adapters, run the loops. */
  async start() {
    for (const [name, adapter] of Object.entries(this.adapters)) {
      adapter.name = name;
    }
    await this.refreshConfig();
    this.timers.push(setInterval(() => void this.refreshConfig(), CONFIG_POLL_MS));
    this.timers.push(setInterval(() => void this.flush(), FLUSH_MS));
    this.timers.push(setInterval(() => void this.reportHealth(), CONFIG_POLL_MS));
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const adapter of Object.values(this.adapters)) adapter.stop();
  }

  /** Pull the source order from market-data and reconcile which adapters run. */
  async refreshConfig() {
    try {
      const response = await this.fetch(`${this.marketDataUrl}/v1/feed/config`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`market-data returned ${response.status}`);
      const body = /** @type {{classes?: Record<string, string[]>}} */ (await response.json());
      this.applyConfig(body.classes ?? {});
    } catch (error) {
      this.log("warn", "could not read feed config", { detail: String(error) });
    }
  }

  /**
   * Start and stop adapters so exactly the configured sources run, each for
   * the symbols whose class names it.
   * @param {Record<string, string[]>} classes
   */
  applyConfig(classes) {
    this.config = classes;
    /** @type {Map<string, Set<string>>} */
    const wanted = new Map();
    for (const [cls, sources] of Object.entries(classes)) {
      const symbols = CLASSES[/** @type {keyof typeof CLASSES} */ (cls)] ?? [];
      for (const source of sources) {
        if (source === "synthetic" || !this.adapters[source]) continue;
        const set = wanted.get(source) ?? new Set();
        for (const symbol of carried(source, symbols)) set.add(symbol);
        wanted.set(source, set);
      }
    }
    for (const [name, adapter] of Object.entries(this.adapters)) {
      const symbols = [...(wanted.get(name) ?? [])].sort();
      const current = this.running.get(name) ?? [];
      const same = symbols.length === current.length && symbols.every((s, i) => s === current[i]);
      if (symbols.length === 0) {
        if (current.length > 0) {
          adapter.stop();
          this.running.delete(name);
          this.log("info", "adapter stopped", { adapter: name });
        }
        continue;
      }
      if (same) continue;
      adapter.stop();
      adapter.start(symbols, (tick) => this.onTick(name, tick));
      this.running.set(name, symbols);
      this.log("info", "adapter started", {
        adapter: name, symbols, state: adapter.state,
      });
    }
    this.reselect();
  }

  /**
   * Decide, per symbol, which source is forwarded (INV-121: a failing source
   * is skipped, never waited for).
   */
  reselect() {
    for (const [cls, sources] of Object.entries(this.config)) {
      const symbols = CLASSES[/** @type {keyof typeof CLASSES} */ (cls)] ?? [];
      for (const symbol of symbols) {
        const previous = this.selected.get(symbol);
        let chosen;
        for (const source of sources) {
          if (source === "synthetic") break;
          const adapter = this.adapters[source];
          if (!adapter || !(this.running.get(source) ?? []).includes(symbol)) continue;
          if (adapter.fresh(FRESH_MS)) {
            chosen = source;
            break;
          }
        }
        if (chosen !== previous) {
          if (chosen) this.selected.set(symbol, chosen);
          else this.selected.delete(symbol);
          if (previous !== undefined) this.counters.failovers += 1;
          this.log("info", "source selected", { symbol, from: previous ?? null, to: chosen ?? null });
          if (chosen) void this.backfill(chosen, symbol);
        }
      }
    }
  }

  /**
   * A tick from an adapter. Forwarded only if that adapter is the selected
   * source for the symbol; the rest are counted and dropped.
   * @param {string} source
   * @param {import("./adapters/base.js").Tick} tick
   */
  onTick(source, tick) {
    // A tick from a source that was not selected may make it selectable.
    if (this.selected.get(tick.symbol) !== source) this.reselect();
    if (this.selected.get(tick.symbol) !== source) {
      this.counters.dropped += 1;
      return;
    }
    const batch = this.pending.get(source) ?? new Map();
    // Ticks inside one flush window collapse to the latest per symbol: the
    // record is at 250ms resolution and the last quote in a bucket wins.
    batch.set(tick.symbol, tick);
    this.pending.set(source, batch);
  }

  /**
   * Seed the record with the source's recent history, once per pair.
   * @param {string} source
   * @param {string} symbol
   */
  async backfill(source, symbol) {
    const key = `${source}:${symbol}`;
    if (this.backfilled.has(key)) return;
    this.backfilled.add(key);
    const adapter = this.adapters[source];
    if (!adapter) return;
    try {
      const ticks = await adapter.backfill(symbol, this.now() - BACKFILL_MS);
      for (let i = 0; i < ticks.length; i += 500) {
        await this.push(source, ticks.slice(i, i + 500));
      }
      if (ticks.length > 0) this.log("info", "backfilled", { source, symbol, ticks: ticks.length });
    } catch (error) {
      this.log("warn", "backfill failed", { source, symbol, detail: String(error) });
    }
  }

  /** Push every pending batch. */
  async flush() {
    const batches = [...this.pending.entries()];
    this.pending = new Map();
    for (const [source, bySymbol] of batches) {
      await this.push(source, [...bySymbol.values()]);
    }
  }

  /**
   * @param {string} source
   * @param {import("./adapters/base.js").Tick[]} ticks
   */
  async push(source, ticks) {
    if (ticks.length === 0) return;
    try {
      const response = await this.fetch(`${this.marketDataUrl}/v1/feed/ticks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, ticks }),
        signal: AbortSignal.timeout(3_000),
      });
      this.counters.pushes += 1;
      if (!response.ok && response.status !== 422) {
        throw new Error(`market-data returned ${response.status}`);
      }
      this.counters.forwarded += ticks.length;
      this.lastPushError = null;
    } catch (error) {
      this.counters.pushFailures += 1;
      this.lastPushError = String(error);
      this.log("warn", "push failed", { source, ticks: ticks.length, detail: String(error) });
    }
  }

  /** Tell market-data how every adapter is doing. */
  async reportHealth() {
    this.reselect();
    /** @type {Record<string, unknown>} */
    const adapters = {};
    for (const [name, adapter] of Object.entries(this.adapters)) {
      adapters[name] = adapter.health();
    }
    try {
      await this.fetch(`${this.marketDataUrl}/v1/feed/health`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapters }),
        signal: AbortSignal.timeout(3_000),
      });
    } catch (error) {
      this.log("warn", "health report failed", { detail: String(error) });
    }
  }

  /** The gateway's own view, for `/v1/adapters`. */
  status() {
    /** @type {Record<string, unknown>} */
    const adapters = {};
    for (const [name, adapter] of Object.entries(this.adapters)) {
      adapters[name] = { ...adapter.health(), symbols: this.running.get(name) ?? [], configured: adapter.configured() };
    }
    return {
      config: this.config,
      selected: Object.fromEntries(this.selected),
      adapters,
      counters: this.counters,
      lastPushError: this.lastPushError,
    };
  }
}

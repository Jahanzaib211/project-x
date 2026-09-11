/**
 * The simulated liquidity provider (INV-121's test double, and CI's feed).
 *
 * It implements the whole adapter contract and produces a deterministic
 * random walk per symbol — plus, on request, the faults a real provider
 * produces: duplicate ticks, out-of-order ticks, crossed quotes, silence and a
 * dropped connection. Every one of those is a thing the gateway and
 * market-data must survive, and this is where they are proven to.
 *
 * Enabled by `SIM_LP=1` (or in tests). Never carries a price anyone should
 * trade on outside a test.
 */

import { Adapter } from "./base.js";
import { GRID } from "./twelvedata.js";

/** A splitmix64-style mix, so the walk is reproducible from a seed. */
function mix(/** @type {bigint} */ x) {
  x = (x + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
  return x ^ (x >> 31n);
}

/** Reference prices, in points of each instrument's grid. */
const REFERENCE = {
  EURUSD: 108_500n,
  GBPUSD: 127_000n,
  AUDUSD: 65_800n,
  XAUUSD: 235_000n,
  BTCUSD: 6_820_000n,
};

/**
 * @typedef {object} Faults
 * @property {number} [duplicateEvery] Emit every Nth tick twice.
 * @property {number} [reorderEvery] Emit every Nth pair swapped.
 * @property {number} [crossEvery] Emit every Nth tick crossed (bid > ask).
 * @property {number} [dropAfter] Fail the connection after N ticks.
 */

export class SimAdapter extends Adapter {
  /**
   * @param {{seed?: number, intervalMs?: number, faults?: Faults, now?: () => number}} [options]
   */
  constructor(options = {}) {
    super("sim-lp", { now: options.now ?? Date.now });
    this.seed = BigInt(options.seed ?? 7);
    this.intervalMs = options.intervalMs ?? 250;
    this.faults = options.faults ?? {};
    /** @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
    this.count = 0;
    /** @type {import("./base.js").Tick|null} */
    this.held = null;
  }

  connect() {
    this.up();
    this.timer = setInterval(() => this.step(), this.intervalMs);
    this.timer.unref?.();
  }

  disconnect() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One tick per symbol, with whichever faults are configured. */
  step() {
    for (const symbol of this.symbols) {
      const grid = GRID[/** @type {keyof typeof GRID} */ (symbol)];
      const ref = REFERENCE[/** @type {keyof typeof REFERENCE} */ (symbol)];
      if (!grid || ref === undefined) continue;
      this.count += 1;
      const n = BigInt(this.count);
      // A bounded walk: the displacement is a hashed value in ±0.3% of ref.
      const h = mix(this.seed * 1_000_003n + n * 7n + BigInt(symbol.length));
      const span = ref / 333n;
      const displacement = (h % (2n * span + 1n)) - span;
      const mid = ref + displacement;
      const half = BigInt(Math.ceil(grid.spreadPoints / 2));
      const render = (/** @type {bigint} */ t) => {
        const s = t.toString().padStart(grid.digits + 1, "0");
        return grid.digits === 0 ? s : `${s.slice(0, -grid.digits)}.${s.slice(-grid.digits)}`;
      };
      let bid = render(mid - half);
      let ask = render(mid + half);
      if (this.faults.crossEvery && this.count % this.faults.crossEvery === 0) {
        [bid, ask] = [ask, bid];
      }
      /** @type {import("./base.js").Tick} */
      const tick = { symbol, ms: this.now(), bid, ask, seq: this.count };

      if (this.faults.reorderEvery && this.count % this.faults.reorderEvery === 0) {
        // Hold this one and emit it after the next.
        this.held = { ...tick, ms: tick.ms - this.intervalMs };
        continue;
      }
      this.emit(tick);
      if (this.held) {
        this.emit(this.held);
        this.held = null;
      }
      if (this.faults.duplicateEvery && this.count % this.faults.duplicateEvery === 0) {
        this.emit({ ...tick });
      }
      if (this.faults.dropAfter && this.count >= this.faults.dropAfter) {
        this.fail("simulated drop");
        return;
      }
    }
  }
}

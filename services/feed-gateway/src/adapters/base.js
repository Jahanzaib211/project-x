/**
 * The adapter interface, and the parts every adapter shares (INV-120).
 *
 * An adapter turns one provider's dialect into canonical ticks:
 *
 *     { symbol: "EURUSD", ms: 1789000000000, bid: "1.08500", ask: "1.08520", seq: 3 }
 *
 * Prices are decimal strings, never numbers, the whole way (P1). An adapter
 * never touches the core's endpoints: it hands ticks to the gateway and the
 * gateway decides what to forward.
 *
 * ## Health and the circuit breaker (INV-121)
 *
 * Each adapter tracks its own state. A provider that keeps failing is put
 * behind an open circuit for a while rather than hammered, and the gateway
 * treats an open circuit as "not connected" for source selection — so a
 * failing provider is isolated from the ones that work.
 */

/**
 * @typedef {object} Tick
 * @property {string} symbol Canonical symbol.
 * @property {number} ms Epoch milliseconds the provider stamped, or arrival.
 * @property {string} bid Decimal string.
 * @property {string} ask Decimal string.
 * @property {number} seq Provider sequence within the millisecond.
 */

/**
 * @typedef {"unconfigured"|"idle"|"connecting"|"connected"|"disconnected"|"circuit-open"} AdapterState
 */

/**
 * @typedef {object} AdapterHealth
 * @property {AdapterState} state
 * @property {number|null} lastTickMs
 * @property {string} ticksPerSecond
 * @property {number} errors
 * @property {string} detail
 */

/** How many consecutive failures open the circuit. */
export const CIRCUIT_FAILURES = 5;
/** How long an open circuit stays open. */
export const CIRCUIT_OPEN_MS = 60_000;
/** The reconnect backoff bounds. */
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/**
 * State and bookkeeping shared by every adapter. Concrete adapters extend it
 * and implement `connect`/`disconnect`; everything about health, backoff and
 * the circuit is here so that no adapter can forget to count a failure.
 */
export class Adapter {
  /**
   * @param {string} name
   * @param {{now?: () => number}} [options]
   */
  constructor(name, options = {}) {
    this.name = name;
    this.now = options.now ?? Date.now;
    /** @type {AdapterState} */
    this.state = "idle";
    /** @type {number|null} */
    this.lastTickMs = null;
    this.errors = 0;
    this.consecutiveFailures = 0;
    this.detail = "";
    /** @type {number[]} arrival times of recent ticks, for the rate */
    this.recent = [];
    /** @type {((tick: Tick) => void)|null} */
    this.onTick = null;
    /** @type {string[]} */
    this.symbols = [];
    /** @type {number} */
    this.circuitOpenedAt = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.reconnectTimer = null;
    this.backoffMs = BACKOFF_MIN_MS;
    this.stopped = true;
  }

  /** Whether the adapter has what it needs (a key, a URL) to run at all. */
  configured() {
    return true;
  }

  /**
   * Start delivering ticks for `symbols`.
   * @param {string[]} symbols Canonical symbols.
   * @param {(tick: Tick) => void} onTick
   */
  start(symbols, onTick) {
    this.symbols = symbols;
    this.onTick = onTick;
    this.stopped = false;
    if (!this.configured()) {
      this.state = "unconfigured";
      return;
    }
    this.open();
  }

  /** Stop, and stay stopped. */
  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.disconnect();
    if (this.state !== "unconfigured") this.state = "idle";
  }

  /** Establish the provider connection. Implemented by the adapter. */
  connect() {}

  /** Tear the provider connection down. Implemented by the adapter. */
  disconnect() {}

  /**
   * Historical ticks to seed the record with, oldest first. Optional.
   * @param {string} _symbol
   * @param {number} _sinceMs
   * @returns {Promise<Tick[]>}
   */
  async backfill(_symbol, _sinceMs) {
    return [];
  }

  open() {
    if (this.stopped) return;
    if (this.state === "circuit-open") {
      if (this.now() - this.circuitOpenedAt < CIRCUIT_OPEN_MS) return;
      this.consecutiveFailures = 0;
    }
    this.state = "connecting";
    try {
      this.connect();
    } catch (error) {
      this.fail(String(error));
    }
  }

  /** Called by the adapter once the provider is delivering. */
  up() {
    this.state = "connected";
    this.detail = "";
    this.consecutiveFailures = 0;
    this.backoffMs = BACKOFF_MIN_MS;
  }

  /**
   * Called by the adapter when the provider connection fails or closes.
   * @param {string} why
   */
  fail(why) {
    this.errors += 1;
    this.consecutiveFailures += 1;
    this.detail = why;
    this.disconnect();
    if (this.stopped) return;
    if (this.consecutiveFailures >= CIRCUIT_FAILURES) {
      this.state = "circuit-open";
      this.circuitOpenedAt = this.now();
      this.schedule(CIRCUIT_OPEN_MS);
      return;
    }
    this.state = "disconnected";
    this.schedule(this.backoffMs);
    this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
  }

  /** @param {number} delayMs */
  schedule(delayMs) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delayMs);
    // A pending reconnect must never keep the process alive on its own.
    this.reconnectTimer.unref?.();
  }

  /**
   * Hand one canonical tick to the gateway.
   * @param {Tick} tick
   */
  emit(tick) {
    if (!this.onTick) return;
    if (this.state !== "connected") this.up();
    const at = this.now();
    this.lastTickMs = at;
    this.recent.push(at);
    // Keep ten seconds of arrivals for the rate.
    while (this.recent.length && (this.recent[0] ?? 0) < at - 10_000) this.recent.shift();
    this.onTick(tick);
  }

  /** @returns {AdapterHealth} */
  health() {
    const at = this.now();
    const inWindow = this.recent.filter((t) => t >= at - 10_000).length;
    return {
      state: this.state,
      lastTickMs: this.lastTickMs,
      ticksPerSecond: (inWindow / 10).toFixed(1),
      errors: this.errors,
      detail: this.detail,
    };
  }

  /**
   * Whether the adapter is delivering: connected and heard from recently.
   * @param {number} withinMs
   */
  fresh(withinMs) {
    return (
      this.state === "connected" &&
      this.lastTickMs !== null &&
      this.now() - this.lastTickMs <= withinMs
    );
  }
}

/**
 * A decimal string that is exactly what the provider sent, or a rejection.
 *
 * Providers send numbers as JSON numbers, which have already been parsed into
 * a double by the time this sees them. Re-rendering with enough places is the
 * best that can be done; the instrument grid in market-data snaps the result.
 * A provider that sends strings is used verbatim.
 *
 * @param {unknown} value
 * @param {number} places
 */
export function decimal(value, places) {
  if (typeof value === "string") {
    return /^\d+(\.\d+)?$/.test(value) ? value : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value.toFixed(Math.min(8, places));
  }
  return null;
}

/**
 * Bid and ask from a provider that only sends a mid, using the instrument's
 * nominal spread in points. Only where the provider has no book at all.
 * @param {string} mid Decimal string.
 * @param {number} digits
 * @param {number} spreadPoints
 */
export function aroundMid(mid, digits, spreadPoints) {
  const scale = 10 ** digits;
  // Exact integer arithmetic on the instrument's own grid.
  const [whole = "0", frac = ""] = mid.split(".");
  const ticks = BigInt(whole) * BigInt(scale) + BigInt((frac + "0".repeat(digits)).slice(0, digits));
  const half = BigInt(Math.ceil(spreadPoints / 2));
  const render = (/** @type {bigint} */ t) => {
    const s = t.toString().padStart(digits + 1, "0");
    return digits === 0 ? s : `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  };
  return { bid: render(ticks - half), ask: render(ticks + half) };
}

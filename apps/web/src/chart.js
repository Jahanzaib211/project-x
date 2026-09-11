/**
 * The chart suite: KLineChart (Apache-2.0, vendored) wired to the terminal.
 *
 * Runs only on the terminal, after the vendored library has loaded. It mounts
 * the chart over the canvas fallback, feeds it candles from the API, keeps the
 * newest candle growing from the event stream, and wires the toolbar — chart
 * type, indicators, drawing tools, position lines. Preferences survive a
 * reload in localStorage.
 *
 * **This module computes no financial figure** (INV-190, INV-191). The
 * library needs numbers to place pixels, and a candle's open/high/low/close
 * are converted for that purpose alone; nothing derived here is ever shown
 * as a balance, a P&L or a price the client could act on — every such figure
 * on the page is still the API's string, rendered by client.js.
 *
 * It also owns the event stream for the page. Every event it receives is
 * re-dispatched on `document` as `px:stream`, so client.js can render quote,
 * account and order updates without a second connection.
 */

// A module, so its helpers do not collide with client.js's on the page.
export {};

/**
 * The vendored library's global, loaded by a classic script before this
 * module. Typed in `klinecharts.d.ts`; read off `globalThis` so a page where
 * the script failed to load falls back to the canvas rather than throwing.
 */
const klinecharts = /** @type {typeof globalThis & {klinecharts?: typeof import("./klinecharts.js")}} */ (globalThis).klinecharts;

const PREFS_KEY = "px.chart";

/** @type {Record<string, {type: string, span: number}>} */
const PERIODS = {
  "5s": { type: "second", span: 5 },
  "15s": { type: "second", span: 15 },
  "1m": { type: "minute", span: 1 },
  "5m": { type: "minute", span: 5 },
  "15m": { type: "minute", span: 15 },
  "1h": { type: "hour", span: 1 },
  "4h": { type: "hour", span: 4 },
  "1d": { type: "day", span: 1 },
};

/** @param {string} sel @param {ParentNode} [root] */
const $ = (sel, root = document) => /** @type {HTMLElement|null} */ (root.querySelector(sel));
/** @param {string} sel @param {ParentNode} [root] */
const $$ = (sel, root = document) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)]);

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, unknown>} prefs */
function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode, quota — a preference is not worth an error */
  }
}

/**
 * A candle from the API as the library wants it. Numbers for pixels only.
 * @param {{openMs: number, open: string, high: string, low: string, close: string}} c
 */
function toBar(c) {
  return {
    timestamp: c.openMs,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: 0,
  };
}

/** The colour tokens the page already uses, read once from CSS. */
function palette() {
  const styles = getComputedStyle(document.documentElement);
  const read = (/** @type {string} */ name, /** @type {string} */ fallback) => styles.getPropertyValue(name).trim() || fallback;
  return {
    up: read("--positive", "#0f7b47"),
    down: read("--danger", "#b3261e"),
    text: read("--text", "#111"),
    muted: read("--text-muted", "#666"),
    grid: read("--border", "#e5e5e5"),
    bg: read("--surface", "#fff"),
    accent: read("--accent", "#2f5fe0"),
    mono: read("--mono", "monospace"),
  };
}

/** @param {ReturnType<typeof palette>} p */
function stylesFor(p) {
  const line = { color: p.grid, size: 1, style: "dashed", dashedValue: [2, 4] };
  return {
    grid: { horizontal: { ...line }, vertical: { ...line } },
    candle: {
      bar: { upColor: p.up, downColor: p.down, noChangeColor: p.muted, upBorderColor: p.up, downBorderColor: p.down, noChangeBorderColor: p.muted, upWickColor: p.up, downWickColor: p.down, noChangeWickColor: p.muted },
      priceMark: { last: { upColor: p.up, downColor: p.down, noChangeColor: p.muted, text: { family: p.mono } } },
      tooltip: { text: { color: p.text, family: p.mono } },
    },
    indicator: { tooltip: { text: { color: p.text, family: p.mono } } },
    xAxis: { axisLine: { color: p.grid }, tickText: { color: p.muted, family: p.mono }, tickLine: { color: p.grid } },
    yAxis: { axisLine: { color: p.grid }, tickText: { color: p.muted, family: p.mono }, tickLine: { color: p.grid } },
    separator: { color: p.grid },
    crosshair: {
      horizontal: { line: { color: p.muted }, text: { backgroundColor: p.accent, family: p.mono } },
      vertical: { line: { color: p.muted }, text: { backgroundColor: p.accent, family: p.mono } },
    },
    overlay: { line: { color: p.accent }, point: { color: p.accent, borderColor: p.accent } },
  };
}

function main() {
  const root = $("[data-terminal]");
  const mount = $("[data-chart-suite]");
  const host = $("[data-chart-host]");
  if (!root || !mount || !host || !klinecharts) return;

  const prefs = loadPrefs();
  let symbol = root.dataset.symbol || "EURUSD";
  let interval = root.dataset.interval || "1m";
  let digits = Number.parseInt(root.dataset.digits || "5", 10);
  let account = root.dataset.account || "";

  mount.hidden = false;
  host.classList.add("suite-active");
  document.documentElement.dataset.chartSuiteState = "active";

  const created = klinecharts.init(mount, { locale: "en-US", timezone: "UTC", styles: stylesFor(palette()) });
  if (!created) return;
  /** @type {import("./klinecharts.js").Chart} */
  const chart = created;
  chart.setStyles({ candle: { type: prefs.type ?? "candle_solid" } });

  /** @type {((bar: ReturnType<typeof toBar>) => void)|null} */
  let onBar = null;
  let generation = 0;

  chart.setDataLoader({
    /** @param {{type: string, timestamp: number|null, callback: (bars: unknown[], more?: unknown) => void}} params */
    async getBars({ type, timestamp, callback }) {
      const mine = generation;
      // Backwards paging: ask for the window ending just before the oldest
      // bar on screen, which market-data serves by tick (INV-052).
      const params = new URLSearchParams({ symbol, interval, limit: "500" });
      if (type === "forward" && typeof timestamp === "number") {
        params.set("tick", String(Math.floor(timestamp / 250) - 1));
      }
      try {
        const response = await fetch(`/api/v1/candles?${params}`, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json();
        if (mine !== generation) return;
        const bars = (body.candles ?? []).map(toBar);
        host.dataset.candles = String(bars.length);
        host.dataset.last = body.candles?.at(-1)?.close ?? "";
        const source = $("[data-chart-source]");
        if (source) source.textContent = body.source ? `source: ${body.source}` : "";
        callback(bars, { forward: bars.length >= 500, backward: false });
      } catch {
        if (mine === generation) callback([], false);
        const empty = $("[data-chart-empty]");
        if (empty) empty.textContent = "Price history is unavailable.";
      }
    },
    /** @param {{callback: (bar: ReturnType<typeof toBar>) => void}} params */
    subscribeBar({ callback }) {
      onBar = callback;
    },
    unsubscribeBar() {
      onBar = null;
    },
  });

  const apply = () => {
    generation += 1;
    chart.setSymbol({ ticker: symbol, pricePrecision: digits, volumePrecision: 0 });
    chart.setPeriod(PERIODS[interval] ?? { type: "minute", span: 1 });
    connectStream();
  };

  /* ------------------------------------------------------ live stream */
  /** @type {EventSource|null} */
  let stream = null;
  const live = $("[data-chart-live]");

  function connectStream() {
    stream?.close();
    const params = new URLSearchParams({ symbol, interval });
    if (account) params.set("account", account);
    stream = new EventSource(`/api/v1/stream?${params}`);
    document.documentElement.dataset.stream = "connecting";
    stream.addEventListener("open", () => {
      document.documentElement.dataset.stream = "live";
      if (live) live.textContent = "live";
    });
    stream.addEventListener("error", () => {
      document.documentElement.dataset.stream = "down";
      if (live) live.textContent = "live: reconnecting…";
    });
    for (const name of ["quote", "candle", "account", "orders"]) {
      stream.addEventListener(name, (event) => {
        let data;
        try {
          data = JSON.parse(/** @type {MessageEvent} */ (event).data);
        } catch {
          return;
        }
        if (name === "candle" && data.symbol === symbol && data.interval === interval && onBar) {
          for (const candle of data.candles ?? []) onBar(toBar(candle));
          if (host) host.dataset.last = data.candles?.at(-1)?.close ?? host.dataset.last ?? "";
        }
        if (name === "account") drawPositions(data.valuation?.positions ?? []);
        document.dispatchEvent(new CustomEvent("px:stream", { detail: { event: name, data } }));
      });
    }
  }

  /* --------------------------------------------------- position lines */
  /** @type {string[]} */
  let positionOverlays = [];
  const showPositions = /** @type {HTMLInputElement|null} */ ($("[data-show-positions]"));
  if (showPositions && typeof prefs.positions === "boolean") showPositions.checked = prefs.positions;

  /** @param {{symbol: string, side: string, openPrice: string, volume: string}[]} positions */
  function drawPositions(positions) {
    for (const id of positionOverlays) chart.removeOverlay({ id });
    positionOverlays = [];
    if (showPositions && !showPositions.checked) return;
    for (const position of positions) {
      if (position.symbol !== symbol) continue;
      const id = chart.createOverlay({
        name: "priceLine",
        lock: true,
        points: [{ value: Number(position.openPrice) }],
        styles: { line: { color: position.side === "BUY" ? palette().up : palette().down } },
        extendData: `${position.side} ${position.volume}`,
      });
      if (typeof id === "string") positionOverlays.push(id);
    }
  }
  showPositions?.addEventListener("change", () => {
    prefs.positions = showPositions.checked;
    savePrefs(prefs);
    if (!showPositions.checked) drawPositions([]);
  });

  /* ---------------------------------------------------------- toolbar */
  const typeSelect = /** @type {HTMLSelectElement|null} */ ($("[data-chart-type]"));
  if (typeSelect) {
    typeSelect.value = prefs.type ?? "candle_solid";
    typeSelect.addEventListener("change", () => {
      chart.setStyles({ candle: { type: typeSelect.value } });
      prefs.type = typeSelect.value;
      savePrefs(prefs);
    });
  }

  /** @type {Map<string, string>} indicator name → id */
  const indicators = new Map();
  /** @param {string} name @param {boolean} onPrice */
  function addIndicator(name, onPrice) {
    if (indicators.has(name)) return;
    const id = onPrice
      ? chart.createIndicator({ name, paneId: "candle_pane" }, true)
      : chart.createIndicator(name, false);
    if (typeof id !== "string") return;
    indicators.set(name, id);
    if (!onPrice) {
      // A sub-pane gets a fixed, modest height so the price never gets
      // squeezed out of its own chart.
      const created = chart.getIndicators({ id })[0];
      if (created?.paneId) chart.setPaneOptions({ id: created.paneId, height: 90 });
    }
  }
  /** @param {string} name */
  function removeIndicator(name) {
    const id = indicators.get(name);
    if (id) chart.removeIndicator({ id });
    indicators.delete(name);
  }
  const savedIndicators = Array.isArray(prefs.indicators) ? prefs.indicators : ["MA"];
  $$("[data-indicator]").forEach((el) => {
    const box = /** @type {HTMLInputElement} */ (el);
    const name = box.dataset.indicator ?? "";
    const onPrice = box.dataset.pane === "candle_pane";
    if (savedIndicators.includes(name)) {
      box.checked = true;
      addIndicator(name, onPrice);
    }
    box.addEventListener("change", () => {
      if (box.checked) addIndicator(name, onPrice);
      else removeIndicator(name);
      prefs.indicators = [...indicators.keys()];
      savePrefs(prefs);
    });
  });

  $$("[data-drawing]").forEach((button) =>
    button.addEventListener("click", () => {
      chart.createOverlay({ name: button.dataset.drawing ?? "segment" });
    }),
  );
  $("[data-drawing-clear]")?.addEventListener("click", () => {
    // Everything but the position lines, which are the account's, not a drawing.
    for (const overlay of chart.getOverlays()) {
      if (!positionOverlays.includes(overlay.id)) chart.removeOverlay({ id: overlay.id });
    }
  });

  /* ------------------------------------------------ symbol / interval */
  $("[data-symbol-select]")?.addEventListener("change", (event) => {
    const select = /** @type {HTMLSelectElement} */ (event.currentTarget);
    symbol = select.value;
    const option = select.selectedOptions[0];
    digits = Number.parseInt(option?.dataset.digits || root.dataset.digits || "5", 10);
    drawPositions([]);
    apply();
  });
  $$("[data-interval-btn]").forEach((button) =>
    button.addEventListener("click", () => {
      interval = button.dataset.intervalBtn || "1m";
      apply();
    }),
  );
  $("[data-account-select]")?.addEventListener("change", (event) => {
    account = /** @type {HTMLSelectElement} */ (event.currentTarget).value;
    drawPositions([]);
    connectStream();
  });

  new ResizeObserver(() => chart.resize()).observe(mount);
  apply();
}

main();

/**
 * Client-side behaviour, served at /client.js.
 *
 * The page is complete before this runs; everything here is an upgrade, not a
 * requirement. No framework — the interactive surface is a handful of menus, a
 * dialog and three forms, and a framework would be more code than the code.
 *
 * What it does take seriously:
 * - focus management (dialogs trap focus and restore it on close)
 * - keyboard (Escape closes, arrow-free menus stay reachable by Tab)
 * - `aria-expanded` / `aria-selected` kept in sync with what is actually shown
 * - money is validated as a decimal string and never parsed into a `Number`
 */

const API = document.documentElement.dataset.api || "";

/* ------------------------------------------------------------------ utils */

/**
 * Query one element. Typed as HTMLElement rather than Element so `.dataset`,
 * `.hidden` and `.focus()` are available without a cast at every call site.
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {HTMLElement | null}
 */
const $ = (sel, root = document) =>
  /** @type {HTMLElement | null} */ (root.querySelector(sel));

/**
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {HTMLElement[]}
 */
const $$ = (sel, root = document) =>
  /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)]);

/**
 * The element an event fired on, when it is an element at all. `event.target`
 * is an EventTarget, which has no `closest`; text nodes and the document both
 * land here in practice.
 * @param {Event} event
 * @returns {HTMLElement | null}
 */
const eventTarget = (event) =>
  event.target instanceof HTMLElement ? event.target : null;

/** @param {string} message @param {"info"|"error"} [tone] */
function toast(message, tone = "info") {
  const host = $("[data-toasts]");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", tone === "error" ? "alert" : "status");

  // Built as nodes, not markup. `message` carries API error text, and error
  // text is exactly where user input tends to end up quoted back; assigning it
  // through innerHTML would make that a script-execution path.
  const text = document.createElement("span");
  text.style.flex = "1";
  text.textContent = message;

  const dismiss = document.createElement("button");
  dismiss.className = "close";
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => el.remove());

  el.append(text, dismiss);
  host.append(el);
  setTimeout(() => el.remove(), 6000);
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function api(path, init = {}) {
  const response = await fetch(`${API}/api${path}`, {
    headers: { "content-type": "application/json", ...(init.headers || {}) },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || "Request failed"), { body, status: response.status });
  return body;
}

/**
 * Narrow a caught value into the shape `api()` throws. `catch` gives `unknown`,
 * and reaching into `.body.error` on an unknown is exactly how an error handler
 * becomes a second error.
 *
 * @param {unknown} error
 * @returns {{status?: number|undefined, body: {error?: string, detail?: string, recorded?: boolean, outcome?: {detail?: string, error?: string}}}}
 */
function asApiError(error) {
  if (error && typeof error === "object") {
    const e = /** @type {{status?: number, body?: {error?: string, detail?: string, recorded?: boolean, outcome?: {detail?: string, error?: string}}}} */ (error);
    return { status: e.status, body: e.body ?? {} };
  }
  return { body: {} };
}

/** A stable idempotency key per submission attempt (INV-181). */
const newKey = () =>
  (crypto.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/* ------------------------------------------------------------------ theme */

function initTheme() {
  const root = document.documentElement;
  const sync = () => {
    const dark = root.dataset.theme === "dark";
    // Show the theme you would switch TO, not the one you are in — the button
    // is a control, and a control should picture its outcome.
    $$("[data-theme-icon]").forEach((el) => {
      el.hidden = el.dataset.themeIcon === (dark ? "dark" : "light");
    });
  };
  sync();
  $$("[data-theme-toggle]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem("px-theme", next); } catch {}
      sync();
    }),
  );
}

/* ---------------------------------------------------------------- sidebar */

function initSidebar() {
  const app = $(".app");
  if (!app) return;

  // Rail state lives on <html>, which the inline head script sets before first
  // paint. Toggling it here (rather than on .app) means the collapsed sidebar is
  // already collapsed when the page paints — no flash of the expanded rail.
  const root = document.documentElement;

  $("[data-collapse]")?.addEventListener("click", () => {
    const rail = root.dataset.rail !== "true";
    root.dataset.rail = String(rail);
    try { localStorage.setItem("px-rail", String(rail)); } catch {}
    $("[data-collapse]")?.setAttribute("aria-label", rail ? "Expand sidebar" : "Collapse sidebar");
  });

  $("[data-drawer-toggle]")?.addEventListener("click", () => {
    app.dataset.drawer = app.dataset.drawer === "open" ? "closed" : "open";
  });

  // Tapping the scrim closes the drawer.
  app.addEventListener("click", (event) => {
    if (app.dataset.drawer !== "open") return;
    const el = eventTarget(event);
    if (!el?.closest(".sidebar") && !el?.closest("[data-drawer-toggle]")) {
      app.dataset.drawer = "closed";
    }
  });

  $$("[data-toggle-group]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const group = /** @type {HTMLElement|null} */ (btn.closest(".nav-group"));
      if (!group) return;
      const open = group.dataset.open !== "true";
      group.dataset.open = String(open);
      btn.setAttribute("aria-expanded", String(open));
    }),
  );
}

/* ------------------------------------------------------------------ menus */

function initMenus() {
  /** @param {string} name */
  const close = (name) => {
    $(`[data-menu-panel="${name}"]`)?.setAttribute("hidden", "");
    $(`[data-menu="${name}"]`)?.setAttribute("aria-expanded", "false");
  };
  const closeAll = () =>
    $$("[data-menu]").forEach((b) => { if (b.dataset.menu) close(b.dataset.menu); });

  $$("[data-menu]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const name = button.dataset.menu;
      const panel = name ? $(`[data-menu-panel="${name}"]`) : null;
      if (!panel) return;
      const isOpen = !panel.hasAttribute("hidden");
      closeAll();
      if (!isOpen) {
        panel.removeAttribute("hidden");
        button.setAttribute("aria-expanded", "true");
        if (name === "notifications") loadNotifications();
      }
    });
  });

  document.addEventListener("click", (event) => {
    const el = eventTarget(event);
    if (!el?.closest(".menu") && !el?.closest("[data-menu]")) closeAll();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll();
  });
}

/* ------------------------------------------------------------------ modal */

/** @type {HTMLElement | null} */
let lastFocused = null;

/** @param {string} name */
function openModal(name) {
  const backdrop = $(`[data-modal="${name}"]`);
  if (!backdrop) return;
  lastFocused = /** @type {HTMLElement | null} */ (document.activeElement);
  backdrop.hidden = false;
  document.body.style.overflow = "hidden";
  const focusable = getFocusable(backdrop);
  focusable[0]?.focus();
}

function closeModal() {
  const backdrop = $(".modal-backdrop:not([hidden])");
  if (!backdrop) return;
  backdrop.hidden = true;
  document.body.style.overflow = "";
  lastFocused?.focus();
}

/** @param {HTMLElement} root */
const getFocusable = (root) =>
  $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea,[tabindex]:not([tabindex="-1"])', root)
    .filter((el) => el.offsetParent !== null);

function initModal() {
  $$("[data-open-account]").forEach((b) => b.addEventListener("click", () => openModal("open-account")));
  $$("[data-close-modal]").forEach((b) => b.addEventListener("click", closeModal));

  document.addEventListener("click", (event) => {
    if (eventTarget(event)?.classList.contains("modal-backdrop")) closeModal();
  });

  document.addEventListener("keydown", (event) => {
    const backdrop = $(".modal-backdrop:not([hidden])");
    if (!backdrop) return;
    if (event.key === "Escape") return closeModal();
    if (event.key !== "Tab") return;

    // Trap focus inside the dialog.
    const items = getFocusable(backdrop);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });

  // Real/Demo picker inside the dialog.
  $$("[data-mode-pick]").forEach((button) =>
    button.addEventListener("click", () => {
      $$("[data-mode-pick]").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
      const hidden = /** @type {HTMLInputElement|null} */ ($('input[name="mode"]'));
      if (hidden && button.dataset.modePick) hidden.value = button.dataset.modePick;
      const hint = $("[data-mode-hint]");
      if (hint) {
        hint.textContent = button.dataset.modePick === "demo"
          ? "Funded with 10,000.00 USD of demo capital on opening. Trades settle through the real ledger; only the money is not real."
          : "Opens unfunded. Real deposits wait on 17-payments; demo capital is never issued to a real account.";
      }
    }),
  );

  // A freshly opened account is pointed at, briefly, so the person who just
  // pressed the button can see where it went.
  const fresh = new URL(location.href).searchParams.get("new");
  const card = fresh ? $(`[data-account="${CSS.escape(fresh)}"]`) : null;
  if (card) {
    card.classList.add("account-new");
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => card.classList.remove("account-new"), 4000);
  }
}

/* --------------------------------------------------------------- accounts */

function initAccountActions() {
  const form = /** @type {HTMLFormElement|null} */ ($("[data-open-account-form]"));
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = /** @type {HTMLButtonElement|null} */ ($("[data-submit]", form));
    if (!submit) return;
    submit.disabled = true;
    submit.textContent = "Opening…";
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      const account = await api("/v1/accounts", {
        method: "POST",
        headers: { "idempotency-key": newKey() },
        body: JSON.stringify({ ...data, leverage: Number(data.leverage) }),
      });
      toast(`Account #${account.accountNumber} opened.`);
      closeModal();
      // Land on the tab the account belongs to. Reloading the current tab
      // after opening an account of the *other* mode made the new account
      // look as though it had vanished.
      const url = new URL(location.href);
      url.searchParams.set("mode", account.mode === "demo" ? "demo" : "real");
      url.searchParams.set("new", String(account.accountNumber));
      setTimeout(() => location.assign(url), 400);
    } catch (error) {
      toast(asApiError(error).body.detail || asApiError(error).body.error || "Could not open the account.", "error");
      submit.disabled = false;
      submit.textContent = "Open account";
    }
  });

  document.addEventListener("click", async (event) => {
    const el = eventTarget(event);
    if (!el) return;
    const restore = /** @type {HTMLButtonElement|null} */ (el.closest("[data-restore]"));
    const archive = /** @type {HTMLButtonElement|null} */ (el.closest("[data-archive]"));
    const copy = /** @type {HTMLElement|null} */ (el.closest("[data-copy]"));

    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy ?? "");
        toast("Copied to clipboard.");
      } catch { toast("Could not copy.", "error"); }
      return;
    }

    if (restore) {
      const number = restore.dataset.restore;
      restore.disabled = true;
      try {
        await api(`/v1/accounts/${number}/restore`, { method: "POST" });
        toast(`Account #${number} restored.`);
        setTimeout(() => location.reload(), 400);
      } catch (error) {
        toast(asApiError(error).body.error || "Could not restore the account.", "error");
        restore.disabled = false;
      }
      return;
    }

    const reset = /** @type {HTMLButtonElement|null} */ (el.closest("[data-demo-reset]"));
    if (reset) {
      const number = reset.dataset.demoReset;
      if (!confirm(`Reset demo account #${number} to 10,000.00 USD? Open positions must be closed first.`)) return;
      try {
        const result = await api("/v1/funding/demo-reset", {
          method: "POST",
          headers: { "idempotency-key": newKey() },
          body: JSON.stringify({ account: number }),
        });
        toast(result.detail || `Account #${number} reset.`);
        setTimeout(() => location.reload(), 400);
      } catch (error) {
        const failure = asApiError(error);
        toast(failure.body.detail || failure.body.error || "Could not reset the account.", "error");
      }
      return;
    }

    if (archive) {
      const number = archive.dataset.archive;
      if (!confirm(`Archive account #${number}? You can restore it later.`)) return;
      try {
        await api(`/v1/accounts/${number}/archive`, { method: "POST" });
        toast(`Account #${number} archived.`);
        setTimeout(() => location.reload(), 400);
      } catch (error) {
        toast(asApiError(error).body.error || "Could not archive the account.", "error");
      }
    }
  });

  // Sort and view are display preferences: update the URL so they survive a
  // reload and can be linked, rather than living only in memory.
  $("[data-sort]")?.addEventListener("change", (event) => {
    const select = /** @type {HTMLSelectElement|null} */ (eventTarget(event));
    if (!select) return;
    const url = new URL(location.href);
    url.searchParams.set("sort", select.value);
    location.assign(url);
  });

  $$("[data-view]").forEach((button) =>
    button.addEventListener("click", () => {
      const url = new URL(location.href);
      url.searchParams.set("view", button.dataset.view ?? "list");
      location.assign(url);
    }),
  );

  const toggleArchived = $("[data-toggle-archived]");
  toggleArchived?.addEventListener("click", () => {
    const list = $("[data-archived-list]");
    if (!list) return;
    const shown = list.hidden;
    list.hidden = !shown;
    toggleArchived.setAttribute("aria-expanded", String(shown));
    const label = $("[data-archived-label]", toggleArchived);
    if (label) label.textContent = shown ? "Hide accounts" : "Show accounts";
    const chev = $(".chev", toggleArchived);
    if (chev) chev.style.transform = shown ? "" : "rotate(-90deg)";
  });
}

/* ---------------------------------------------------------------- funding */

/** Exact decimal, never a float. Mirrors the API's own validation. */
const DECIMAL = /^\d{1,18}(\.\d{1,8})?$/;

function initFunding() {
  $$("[data-money-input]").forEach((el) => {
    const input = /** @type {HTMLInputElement} */ (el);
    input.addEventListener("input", () => {
      // Keep only characters that can form an exact decimal.
      const cleaned = input.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
      if (cleaned !== input.value) input.value = cleaned;
      updateSummary(cleaned);
    });
  });

  /** @param {string} value */
  function updateSummary(value) {
    const amount = $("[data-summary-amount]");
    const fee = $("[data-summary-fee]");
    const total = $("[data-summary-total]");
    // The transfer page has no summary aside; nothing to update there.
    if (!amount || !fee || !total) return;
    const valid = DECIMAL.test(value);
    // String formatting only — the browser never does arithmetic on money.
    amount.textContent = valid ? `${value} USD` : "—";
    fee.textContent = valid ? "0.00 USD" : "—";
    total.textContent = valid ? `${value} USD` : "—";
  }

  $$("[data-funding-form]").forEach((el) => {
    const form = /** @type {HTMLFormElement} */ (el);

    // The form follows the chosen account's mode: demo capital for a demo
    // account, the gated real-money path for a real one.
    const picker = /** @type {HTMLSelectElement|null} */ ($("[data-account-pick]", form));
    const applyMode = () => {
      if (form.dataset.kind !== "deposit") return;
      const option = picker?.selectedOptions[0];
      const demo = option?.dataset.mode === "demo";
      form.dataset.demo = demo ? "true" : "false";
      $$("[data-methods]", form).forEach((block) => {
        block.hidden = block.hasAttribute("data-demo") ? !demo : demo;
      });
      $$("[data-funding-notice]").forEach((block) => {
        block.hidden = block.hasAttribute("data-demo") ? !demo : demo;
      });
      const submit = $("[data-funding-submit]", form);
      if (submit) submit.textContent = demo ? "Add demo capital" : "Deposit";
    };
    picker?.addEventListener("change", applyMode);
    applyMode();

    $$("[data-preset]", form).forEach((button) =>
      button.addEventListener("click", () => {
        const input = /** @type {HTMLInputElement|null} */ ($('[name="amount"]', form));
        if (!input) return;
        input.value = button.dataset.preset ?? "";
        input.dispatchEvent(new Event("input"));
      }),
    );

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      const demo = form.dataset.demo === "true";
      if (demo) data.method = "demo";
      delete data.demoMethod;
      const result_ = $("[data-funding-result]", form);

      if (!DECIMAL.test(String(data.amount ?? ""))) {
        toast("Enter an exact amount, for example 250.00", "error");
        $('[name="amount"]', form)?.focus();
        return;
      }
      if (form.dataset.kind === "transfer" && data.fromAccount === data.toAccount) {
        toast("Choose two different accounts.", "error");
        return;
      }

      const button = /** @type {HTMLButtonElement|null} */ ($('button[type="submit"]', form));
      if (!button) return;
      button.disabled = true;
      const original = button.textContent;
      button.textContent = "Submitting…";

      try {
        const result = await api(`/v1/funding/${form.dataset.kind}`, {
          method: "POST",
          headers: { "idempotency-key": newKey() },
          body: JSON.stringify({ ...data, currency: "USD" }),
        });
        if (result.settled) {
          // Settled: the ledger's own figure, rendered verbatim (INV-191).
          toast(result.detail || "Demo capital added.");
          if (result_) {
            result_.textContent = `Settled. Balance is now ${result.balance} USD.`;
            result_.dataset.tone = "ok";
          }
          const shellBalance = $("[data-wallet-balance]");
          if (shellBalance && typeof result.balance === "string") shellBalance.textContent = result.balance;
        } else {
          toast(result.message || result.detail || "Request recorded.");
        }
      } catch (error) {
        // A gated response is expected, not a failure — say so plainly.
        const failure = asApiError(error);
        if (failure.status === 503 && failure.body.recorded) {
          toast(failure.body.detail || "Recorded as an intent. Funding is not live yet.");
          if (result_) result_.textContent = "Recorded as an intent. Real-money funding is not live yet.";
        } else {
          toast(failure.body.detail || failure.body.error || "Could not submit the request.", "error");
          if (result_) {
            result_.textContent = failure.body.detail || failure.body.error || "Could not submit the request.";
            result_.dataset.tone = "error";
          }
        }
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    });
  });
}

/* ---------------------------------------------------- topbar data loading */

async function loadNotifications() {
  const host = $("[data-notifications]");
  if (!host || host.dataset.loaded) return;
  try {
    const { notifications } = await api("/v1/notifications");
    host.dataset.loaded = "true";
    host.innerHTML = notifications.length
      ? notifications
          .map((/** @type {{href:string,title:string,text:string}} */ n) =>
            `<a class="menu-item" href="${n.href}" style="align-items:flex-start">
              <span style="display:block">
                <span style="display:block;font-weight:500">${n.title}</span>
                <span style="display:block" class="micro muted">${n.text}</span>
              </span>
            </a>`)
          .join("")
      : '<div class="small muted">Nothing new.</div>';
  } catch {
    host.innerHTML = '<div class="small muted">Could not load notifications.</div>';
  }
}

// The profile menu used to be filled in here from /v1/profile. It is rendered
// by the server now, from the same session that decided whether to render the
// menu at all — so fetching it again would be a second round trip that can only
// agree, arrive late, or briefly overwrite correct markup with a placeholder.

/* --------------------------------------------------------------- terminal */

/**
 * Convert a decimal price string into an exact integer count of its own last
 * decimal place — `"1.08512"` at 5 digits becomes `108512`.
 *
 * This is the only place the terminal turns a quoted figure into a number, and
 * it does so **without floating point**: the string is split on the point, the
 * fraction is padded or refused, and the two halves are combined with integer
 * arithmetic. The result is used for chart geometry only. No money is ever
 * computed here — the balances, P&L and margin on this page are strings the
 * core produced (INV-190, INV-191).
 *
 * @param {string} text
 * @param {number} digits
 * @returns {number|null} null when the text is not an exact decimal.
 */
function toPriceTicks(text, digits) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > digits) return null;
  const padded = fraction.padEnd(digits, "0");
  const combined = `${whole}${padded}`;
  // Safe-integer range covers every instrument here by a wide margin: the
  // largest is BTC at 2 decimal places, so about 10^7 ticks.
  const value = globalThis.parseInt(combined, 10);
  if (!Number.isSafeInteger(value)) return null;
  return sign === "-" ? -value : value;
}

/**
 * @typedef {object} Candle
 * @property {number} openTick
 * @property {number} openMs
 * @property {string} open
 * @property {string} high
 * @property {string} low
 * @property {string} close
 */

/** The chart's own state. Rebuilt when the symbol or interval changes. */
const chart = {
  /** @type {Candle[]} */ candles: [],
  digits: 5,
  symbol: "",
  interval: "1m",
};

/**
 * Draw the candles.
 *
 * Plain canvas: a charting library would be an order of magnitude more code
 * than this, shipped to every client, to draw rectangles.
 *
 * @param {HTMLCanvasElement} canvas
 */
function drawChart(canvas) {
  const context = canvas.getContext("2d");
  if (!context) return;

  // Draw at device resolution so the candles are not soft on a retina screen.
  const ratio = globalThis.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const styles = getComputedStyle(document.documentElement);
  const ink = styles.getPropertyValue("--text").trim() || "#111";
  const faint = styles.getPropertyValue("--border").trim() || "#ddd";
  const muted = styles.getPropertyValue("--text-muted").trim() || "#888";
  const up = styles.getPropertyValue("--positive").trim() || "#12a150";
  const down = styles.getPropertyValue("--danger").trim() || "#d13438";

  context.clearRect(0, 0, width, height);

  const rows = chart.candles.map((candle) => ({
    open: toPriceTicks(candle.open, chart.digits),
    high: toPriceTicks(candle.high, chart.digits),
    low: toPriceTicks(candle.low, chart.digits),
    close: toPriceTicks(candle.close, chart.digits),
  }));
  const usable = rows.filter(
    (r) => r.open !== null && r.high !== null && r.low !== null && r.close !== null,
  );
  if (usable.length === 0) return;

  const highs = usable.map((r) => /** @type {number} */ (r.high));
  const lows = usable.map((r) => /** @type {number} */ (r.low));
  let top = Math.max(...highs);
  let bottom = Math.min(...lows);
  // A flat series would divide by zero; give it a nominal band instead.
  if (top === bottom) { top += 1; bottom -= 1; }
  const pad = Math.max(1, Math.round((top - bottom) * 0.08));
  top += pad;
  bottom -= pad;

  const gutter = Math.round(78 * ratio);
  const margin = Math.round(10 * ratio);
  const plotWidth = width - gutter - margin;
  const plotHeight = height - margin * 2;
  const y = (/** @type {number} */ value) =>
    margin + ((top - value) * plotHeight) / (top - bottom);

  // Gridlines and the price scale.
  context.strokeStyle = faint;
  context.fillStyle = muted;
  context.lineWidth = 1;
  context.font = `${Math.round(11 * ratio)}px ${styles.getPropertyValue("--mono").trim() || "monospace"}`;
  context.textBaseline = "middle";
  const lines = 5;
  for (let i = 0; i <= lines; i += 1) {
    const value = bottom + ((top - bottom) * i) / lines;
    const py = Math.round(y(value)) + 0.5;
    context.beginPath();
    context.moveTo(margin, py);
    context.lineTo(margin + plotWidth, py);
    context.stroke();
    // Render the label by re-inserting the decimal point, so the axis shows the
    // same text the API would have sent rather than a re-rounded number.
    const ticks = Math.round(value);
    const asText = chart.digits === 0
      ? String(ticks)
      : `${Math.trunc(ticks / 10 ** chart.digits)}.${String(Math.abs(ticks % 10 ** chart.digits)).padStart(chart.digits, "0")}`;
    context.fillText(asText, margin + plotWidth + Math.round(8 * ratio), py);
  }

  const slot = plotWidth / usable.length;
  const body = Math.max(1, Math.floor(slot * 0.62));

  usable.forEach((row, index) => {
    const open = /** @type {number} */ (row.open);
    const close = /** @type {number} */ (row.close);
    const high = /** @type {number} */ (row.high);
    const low = /** @type {number} */ (row.low);
    const centre = Math.round(margin + slot * index + slot / 2);
    const rising = close >= open;
    context.strokeStyle = rising ? up : down;
    context.fillStyle = rising ? up : down;

    // Wick.
    context.beginPath();
    context.moveTo(centre + 0.5, y(high));
    context.lineTo(centre + 0.5, y(low));
    context.stroke();

    // Body. A doji still gets a line, so it is visible rather than absent.
    const topY = y(Math.max(open, close));
    const bottomY = y(Math.min(open, close));
    context.fillRect(
      centre - Math.floor(body / 2),
      topY,
      body,
      Math.max(1, bottomY - topY),
    );
  });

  // The latest close, marked on the axis.
  const latest = usable[usable.length - 1];
  if (latest) {
    const close = /** @type {number} */ (latest.close);
    const py = Math.round(y(close)) + 0.5;
    context.strokeStyle = ink;
    context.setLineDash([Math.round(4 * ratio), Math.round(4 * ratio)]);
    context.beginPath();
    context.moveTo(margin, py);
    context.lineTo(margin + plotWidth, py);
    context.stroke();
    context.setLineDash([]);
  }
}

/**
 * Load the candle history for the current symbol and interval.
 * @param {HTMLElement} root
 */
async function loadCandles(root) {
  const host = $("[data-chart-host]", root);
  const canvas = /** @type {HTMLCanvasElement|null} */ ($("[data-chart]", root));
  if (!host || !canvas) return;
  try {
    const data = await api(
      `/v1/candles?symbol=${encodeURIComponent(chart.symbol)}&interval=${encodeURIComponent(chart.interval)}&limit=180`,
    );
    chart.candles = data.candles ?? [];
    chart.digits = data.digits ?? chart.digits;
    // Published as attributes as well as pixels: a chart that renders but plots
    // nothing is indistinguishable from a working one otherwise.
    host.dataset.candles = String(chart.candles.length);
    host.dataset.last = chart.candles.at(-1)?.close ?? "";
    drawChart(canvas);
  } catch {
    host.dataset.candles = "0";
    const empty = $("[data-chart-empty]", root);
    if (empty) empty.textContent = "Price history is unavailable.";
  }
}

/**
 * Show a price and flash the direction it moved.
 * @param {HTMLElement|null} el
 * @param {string} next
 */
function setPrice(el, next) {
  if (!el) return;
  const previous = el.textContent ?? "";
  if (previous && previous !== "—" && previous !== next) {
    // String comparison, not numeric: the two are the same instrument at the
    // same precision, so they compare correctly as text once padded — and this
    // keeps money out of arithmetic entirely.
    el.dataset.move = next.length === previous.length && next > previous ? "up" : "down";
  }
  el.textContent = next;
}

/**
 * A duration as people say it: "1d 3h", "42m", "under a minute".
 * @param {number} ms
 */
function humanDuration(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Reflect the instrument's session on the terminal (INV-053, INV-084).
 *
 * A closed market shows a banner with when it reopens, freezes the quote
 * strip's "age" and disables the ticket. The server rendered the same state
 * for the first paint; this keeps it true as the clock moves.
 *
 * @param {HTMLElement} root
 * @param {{open: boolean, nextTransitionMs: number|null, hours?: string}|undefined} session
 */
function applySession(root, session) {
  if (!session) return;
  const open = session.open !== false;
  root.dataset.sessionOpen = open ? "true" : "false";
  const banner = $("[data-session-banner]", root);
  if (banner) {
    banner.hidden = open;
    banner.dataset.open = open ? "true" : "false";
    const text = $("[data-session-text]", banner);
    if (text && !open) {
      text.textContent = `${chart.symbol} is closed. Prices are frozen at the last close; orders are refused until it reopens.`;
    }
    const countdown = $("[data-session-countdown]", banner);
    if (countdown) {
      countdown.textContent = !open && session.nextTransitionMs
        ? `Opens in ${humanDuration(session.nextTransitionMs - Date.now())}`
        : "";
    }
  }
  $$("[data-buy], [data-sell]", root).forEach((button) => {
    /** @type {HTMLButtonElement} */ (button).disabled = !open;
  });
  if (!open) note(root, "Market closed — orders are refused until it reopens.", "");
  else {
    const el = $("[data-ticket-note]", root);
    if (el && el.textContent?.startsWith("Market closed")) note(root, "", "");
  }
}

/**
 * Poll the live quote and refresh the growing candle.
 * @param {HTMLElement} root
 */
async function refreshQuote(root) {
  try {
    const quote = await api(`/v1/quote?symbol=${encodeURIComponent(chart.symbol)}`);
    applySession(root, quote.session);
    setPrice($("[data-bid]", root), quote.bid);
    setPrice($("[data-ask]", root), quote.ask);
    const buy = $("[data-buy-price]", root);
    const sell = $("[data-sell-price]", root);
    if (buy) buy.textContent = quote.ask;
    if (sell) sell.textContent = quote.bid;

    const spread = $("[data-spread]", root);
    if (spread) {
      // The spread is displayed as the two sides, not as a computed
      // difference: subtracting them here would be the page doing arithmetic
      // on money, which is exactly what INV-191 forbids.
      spread.textContent = `${quote.bid} / ${quote.ask}`;
    }
    const age = $("[data-quote-age]", root);
    if (age) {
      age.textContent = quote.session && quote.session.open === false
        ? "frozen"
        : `${quote.ageMs ?? 0} ms`;
    }
  } catch {
    // A dropped poll is not worth a toast; the next one is 800ms away.
  }
}

/**
 * Refresh the account summary, positions and orders.
 * @param {HTMLElement} root
 */
async function refreshAccount(root) {
  const account = root.dataset.account;
  if (!account) return;
  try {
    const [state, history] = await Promise.all([
      api(`/v1/trading-accounts/${encodeURIComponent(account)}/state`),
      api(`/v1/orders?account=${encodeURIComponent(account)}`),
    ]);
    renderSummary(root, state.valuation);
    renderPositions(root, state.valuation?.positions ?? []);
    renderOrders(root, history.orders ?? []);
  } catch {
    /* leave the last good figures on screen rather than blanking them */
  }
}

/**
 * @param {HTMLElement} root
 * @param {Record<string, string|null|undefined>|undefined} valuation
 */
function renderSummary(root, valuation) {
  if (!valuation) return;
  /** @type {[string, string|null|undefined][]} */
  const fields = [
    ["balance", valuation.balance],
    ["equity", valuation.equity],
    ["unrealised", valuation.unrealised],
    ["used-margin", valuation.usedMargin],
    ["free-margin", valuation.freeMargin],
    // null is rendered as a dash, never as a zero (INV-183).
    ["margin-level", valuation.marginLevel],
  ];
  for (const [key, value] of fields) {
    const el = $(`[data-${key}]`, root);
    if (el) el.textContent = value ?? "—";
  }
}

/**
 * @param {HTMLElement} root
 * @param {{symbol: string, side: string, volume: string, openPrice: string, mark: string, unrealised: string}[]} positions
 */
function renderPositions(root, positions) {
  const body = $("[data-positions]", root);
  const count = $("[data-positions-count]", root);
  if (!body) return;
  if (count) count.textContent = `${positions.length} open`;

  if (positions.length === 0) {
    body.innerHTML =
      '<tr data-positions-empty><td colspan="7" class="small muted" style="text-align:center;padding:var(--s-6)">No open positions.</td></tr>';
    return;
  }
  // Built as nodes rather than markup: every value here came over the network.
  body.replaceChildren(
    ...positions.map((position) => {
      const row = document.createElement("tr");
      row.dataset.position = position.symbol;
      const losing = position.unrealised.startsWith("-");

      const cells = [
        cell(position.symbol, "mono"),
        badgeCell(position.side),
        cell(position.volume, "mono"),
        cell(position.openPrice, "mono"),
        cell(position.mark, "mono", "positionMark"),
        cell(position.unrealised, `mono ${losing ? "figure-down" : "figure-up"}`, "positionPnl"),
      ];
      const action = document.createElement("td");
      action.style.textAlign = "right";
      const close = document.createElement("button");
      close.className = "btn btn-sm";
      close.type = "button";
      close.dataset.closePosition = position.symbol;
      close.textContent = "Close";
      action.append(close);

      row.append(...cells, action);
      return row;
    }),
  );
}

/**
 * @param {string} text
 * @param {string} [className]
 * @param {string} [dataKey]
 */
function cell(text, className = "", dataKey = "") {
  const td = document.createElement("td");
  if (className) td.className = className;
  if (dataKey) td.dataset[dataKey] = "";
  td.textContent = text;
  return td;
}

/** @param {string} side */
function badgeCell(side) {
  const td = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `badge ${side === "BUY" ? "badge-positive" : "badge-danger"}`;
  badge.textContent = side;
  td.append(badge);
  return td;
}

/**
 * @param {HTMLElement} root
 * @param {{orderId: string, state: string, symbol: string, side: string, volume: string, deal: {price: string, realised: string}|null, rejection: {detail: string}|null}[]} orders
 */
function renderOrders(root, orders) {
  const body = $("[data-orders]", root);
  if (!body) return;
  if (orders.length === 0) {
    body.innerHTML =
      '<tr data-orders-empty><td colspan="6" class="small muted" style="text-align:center;padding:var(--s-6)">No orders yet.</td></tr>';
    return;
  }
  body.replaceChildren(
    ...orders.slice(0, 25).map((order) => {
      const row = document.createElement("tr");
      row.dataset.order = order.orderId;
      const state = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `badge ${order.state === "FILLED" ? "badge-positive" : "badge-warning"}`;
      badge.dataset.orderState = "";
      badge.textContent = order.state;
      state.append(badge);
      if (order.rejection) {
        const why = document.createElement("span");
        why.className = "micro muted";
        why.style.display = "block";
        why.textContent = order.rejection.detail;
        state.append(why);
      }
      row.append(
        cell(order.symbol, "mono"),
        badgeCell(order.side),
        cell(order.volume, "mono"),
        cell(order.deal ? order.deal.price : "—", "mono"),
        cell(order.deal ? order.deal.realised : "—", "mono"),
        state,
      );
      return row;
    }),
  );
}

/**
 * @param {HTMLElement} root
 * @param {string} message
 * @param {"ok"|"error"|""} tone
 */
function note(root, message, tone) {
  const el = $("[data-ticket-note]", root);
  if (!el) return;
  el.textContent = message;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

/**
 * The sentence to show a client whose order was refused.
 *
 * The gateway lifts the core's reason to the top level; the nested `outcome` is
 * read as a fallback so an older reply shape still explains itself rather than
 * degrading to "something went wrong".
 *
 * @param {{detail?: string, error?: string, outcome?: {detail?: string, error?: string}}} body
 */
function refusalText(body) {
  return (
    body.detail ||
    body.outcome?.detail ||
    body.error ||
    body.outcome?.error ||
    "The order was refused."
  );
}

/** Volume is three decimal places at most, and never a Number. */
const VOLUME = /^\d{1,6}(\.\d{1,3})?$/;

function initTerminal() {
  const root = $("[data-terminal]");

  // The no-account state is its own page; wire only the button it has.
  $("[data-open-demo]")?.addEventListener("click", async (event) => {
    const button = /** @type {HTMLButtonElement} */ (event.currentTarget);
    button.disabled = true;
    try {
      await api("/v1/trading-accounts", {
        method: "POST",
        headers: { "idempotency-key": newKey() },
        body: JSON.stringify({ nickname: "Demo account", leverage: 500 }),
      });
      globalThis.location.reload();
    } catch (error) {
      button.disabled = false;
      toast(asApiError(error).body.detail || "Could not open a demo account.", "error");
    }
  });

  if (!root) return;

  chart.symbol = root.dataset.symbol || "EURUSD";
  chart.interval = root.dataset.interval || "1m";
  chart.digits = globalThis.parseInt(root.dataset.digits || "5", 10);

  const canvas = /** @type {HTMLCanvasElement|null} */ ($("[data-chart]", root));

  // ---- instrument and interval -------------------------------------------
  $("[data-symbol-select]", root)?.addEventListener("change", (event) => {
    const select = /** @type {HTMLSelectElement} */ (event.currentTarget);
    chart.symbol = select.value;
    root.dataset.symbol = select.value;
    const option = select.selectedOptions[0];
    if (option) canvas?.setAttribute("aria-label", `Candlestick chart for ${option.value}`);
    const hours = $("[data-session-hours-text]", root);
    if (hours && option) hours.textContent = option.dataset.hours ?? "";
    void loadCandles(root);
    void refreshQuote(root);
  });

  $$("[data-interval-btn]", root).forEach((button) => {
    button.addEventListener("click", () => {
      chart.interval = button.dataset.intervalBtn || "1m";
      root.dataset.interval = chart.interval;
      $$("[data-interval-btn]", root).forEach((other) =>
        other.setAttribute("aria-pressed", String(other === button)),
      );
      void loadCandles(root);
    });
  });

  $("[data-account-select]", root)?.addEventListener("change", (event) => {
    const select = /** @type {HTMLSelectElement} */ (event.currentTarget);
    root.dataset.account = select.value;
    void refreshAccount(root);
  });

  // ---- the ticket ---------------------------------------------------------
  const ticket = /** @type {HTMLFormElement|null} */ ($("[data-ticket]", root));
  ticket?.addEventListener("submit", async (event) => {
    event.preventDefault();
    // Which button was pressed decides the side. `submitter` is typed as a
    // generic element, so the value is read off it only once it is known to be
    // a button — a form can be submitted by other things.
    const submitter = event instanceof SubmitEvent ? event.submitter : null;
    const side =
      submitter instanceof HTMLButtonElement && submitter.value === "SELL" ? "SELL" : "BUY";
    const input = /** @type {HTMLInputElement|null} */ ($("[data-volume]", root));
    const volume = (input?.value ?? "").trim();

    if (!VOLUME.test(volume)) {
      note(root, "Volume must be a decimal with up to three places, such as 0.10.", "error");
      input?.focus();
      return;
    }

    const buttons = $$("[data-buy], [data-sell]", root);
    buttons.forEach((b) => b.setAttribute("disabled", "true"));
    note(root, `Placing ${side.toLowerCase()} ${volume}…`, "");

    try {
      const result = await api("/v1/orders", {
        method: "POST",
        // A fresh key per attempt: a retry of *this* submission is safe, and a
        // second deliberate order is a second order (INV-181).
        headers: { "idempotency-key": newKey() },
        body: JSON.stringify({
          account: root.dataset.account,
          symbol: chart.symbol,
          side,
          volume,
        }),
      });
      note(root, `${side} ${volume} ${chart.symbol} — ${result.state ?? "sent"}.`, "ok");
      await refreshAccount(root);
    } catch (error) {
      const { body } = asApiError(error);
      // The core's own words: it names the rule that refused, and that is the
      // only part a client can act on.
      note(root, refusalText(body), "error");
    } finally {
      // Re-enabled only while the market is open; a closed one stays closed.
      if (root.dataset.sessionOpen !== "false") {
        buttons.forEach((b) => b.removeAttribute("disabled"));
      }
    }
  });

  // ---- closing a position -------------------------------------------------
  root.addEventListener("click", async (event) => {
    const button = eventTarget(event)?.closest("[data-close-position]");
    if (!(button instanceof HTMLElement)) return;
    const symbol = button.dataset.closePosition;
    if (!symbol) return;

    button.setAttribute("disabled", "true");
    try {
      await api("/v1/positions/close", {
        method: "POST",
        headers: { "idempotency-key": newKey() },
        body: JSON.stringify({ account: root.dataset.account, symbol }),
      });
      note(root, `Closed ${symbol}.`, "ok");
      await refreshAccount(root);
    } catch (error) {
      const { body } = asApiError(error);
      toast(refusalText(body) || "Could not close the position.", "error");
      button.removeAttribute("disabled");
    }
  });

  // ---- the live loops -----------------------------------------------------
  void loadCandles(root);
  void refreshQuote(root);
  void refreshAccount(root);

  // Quotes move every 250ms at the source; polling faster than that only makes
  // work. The candle history is refetched less often — the growing candle is
  // what changes, and a whole window every second is wasteful.
  setInterval(() => void refreshQuote(root), 800);
  setInterval(() => void loadCandles(root), 3000);
  setInterval(() => void refreshAccount(root), 2000);

  if (canvas) {
    globalThis.addEventListener("resize", () => drawChart(canvas));
  }
}

/* ------------------------------------------------------------------- auth */

/**
 * The one icon this file draws itself.
 *
 * `icons.js` is a server module and importing it here would ship the whole set
 * to the browser for a single glyph in a panel most people never open.
 */
const ALERT_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/></svg>';

/**
 * Escape text destined for `innerHTML`.
 *
 * The rule in this file is that nothing interpolated into markup goes in raw,
 * even when today's source is a hex string the server generated. The value that
 * gets interpolated tomorrow is the one nobody re-checks.
 *
 * @param {unknown} value
 */
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/**
 * Attach an error to one field.
 *
 * Sets `aria-invalid` as well as filling the message, because a red border is
 * not an error to anyone who cannot see it, and the message element is already
 * wired into `aria-describedby` by the server-rendered markup.
 *
 * @param {string} id The input's id. The error element is `${id}-error`.
 * @param {string} message Empty string clears it.
 */
function setFieldError(id, message) {
  const input = document.getElementById(id);
  const error = document.getElementById(`${id}-error`);
  if (input) {
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

/**
 * The form-level banner, for a failure that belongs to no single field.
 * @param {HTMLElement|null} host
 * @param {string} message
 */
function setFormError(host, message) {
  if (!host) return;
  const text = host.querySelector("[data-error-text]");
  if (text) text.textContent = message;
  else host.textContent = message;
  host.hidden = !message;
  if (message) host.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/**
 * Put a submit button into its busy state and prevent a second submission.
 *
 * A double-submitted registration is two accounts or a confusing duplicate-email
 * error; a double-submitted login is two sessions. Disabling the button is the
 * cheap half — the guard on `dataset.busy` is what actually holds when the
 * Enter key arrives twice before the first response.
 *
 * @param {HTMLFormElement} form
 * @param {boolean} on
 */
function setBusy(form, on) {
  form.dataset.busy = on ? "true" : "";
  const button = /** @type {HTMLButtonElement|null} */ (form.querySelector("[data-submit]"));
  if (!button) return;
  button.disabled = on;
  const label = button.querySelector("[data-submit-label]");
  const busy = button.querySelector("[data-submit-busy]");
  if (label instanceof HTMLElement) label.hidden = on;
  if (busy instanceof HTMLElement) busy.hidden = !on;
}

/** Show/hide toggles on password inputs. */
function initPasswordReveal() {
  $$("[data-reveal]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = /** @type {HTMLInputElement|null} */ (
        document.getElementById(String(button.dataset.reveal))
      );
      if (!input) return;
      const shown = input.type === "text";
      input.type = shown ? "password" : "text";
      button.setAttribute("aria-pressed", shown ? "false" : "true");
      button.setAttribute("aria-label", shown ? "Show password" : "Hide password");
      $$("[data-reveal-icon]", button).forEach((el) => {
        el.hidden = el.dataset.revealIcon === (shown ? "hide" : "show");
      });
      // Keep the caret where it was. Retyping from the start because you wanted
      // to check a character is its own small insult.
      const { selectionStart, selectionEnd } = input;
      input.focus();
      if (selectionStart !== null && selectionEnd !== null) {
        input.setSelectionRange(selectionStart, selectionEnd);
      }
    });
  });
}

/**
 * The strength meter and the requirement checklist.
 *
 * This mirrors `passwordScore` and `passwordProblems` in the API, deliberately
 * and knowingly: the server is the authority, and this is the advice shown
 * while typing. The two are kept honest by the API's own test, which asserts
 * that nothing the policy refuses can ever score above zero — so the worst this
 * can do is be pessimistic, never permissive.
 */
function initPasswordMeter() {
  const input = /** @type {HTMLInputElement|null} */ ($("#register-password"));
  const meter = $("[data-meter]");
  if (!input || !meter) return;

  const label = $("[data-meter-label]", meter);
  const rules = $$("[data-rule]");
  const LABELS = ["Too weak", "Weak", "Fair", "Good", "Strong"];

  const assess = () => {
    const value = input.value;
    const name = /** @type {HTMLInputElement|null} */ ($("#register-name"))?.value ?? "";
    const email = /** @type {HTMLInputElement|null} */ ($("#register-email"))?.value ?? "";

    meter.hidden = value.length === 0;

    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
    const local = email.split("@")[0]?.toLowerCase() ?? "";
    const lower = value.toLowerCase();

    const met = {
      length: value.length >= 10,
      variety: classes >= 2,
      personal:
        value.length > 0 &&
        !(local.length >= 3 && lower.includes(local)) &&
        !(name.trim().length >= 3 && lower.includes(name.trim().toLowerCase())),
    };
    rules.forEach((rule) => {
      const key = /** @type {"length"|"variety"|"personal"} */ (rule.dataset.rule ?? "length");
      rule.dataset.met = met[key] ? "true" : "false";
    });

    let score = 0;
    if (value.length >= 10) score += 1;
    if (value.length >= 14) score += 1;
    if (value.length >= 20) score += 1;
    if (classes >= 2) score += 1;
    if (classes >= 3) score += 1;
    if (/^(.)\1*$/.test(value)) score = 1;
    score = Math.max(0, Math.min(4, score - 1));
    if (!met.personal) score = Math.min(score, 1);

    meter.dataset.score = String(score);
    if (label) label.textContent = value.length === 0 ? "" : (LABELS[score] ?? "");
  };

  input.addEventListener("input", assess);
  $$("#register-name, #register-email").forEach((el) => el.addEventListener("input", assess));
  assess();
}

/** Sign in, including the second-factor step. */
function initLoginForm() {
  const form = /** @type {HTMLFormElement|null} */ ($("[data-login-form]"));
  if (!form) return;

  const banner = $("#login-error");
  const totpStep = $("[data-totp-step]");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.busy) return;

    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const totp = String(data.get("totp") ?? "").trim();

    setFormError(banner, "");
    setFieldError("login-email", "");
    setFieldError("login-password", "");
    setFieldError("login-totp", "");

    // Checked here only to save a round trip. The API validates the same things
    // and is the one that decides.
    if (!email) return setFieldError("login-email", "Enter your email address.");
    if (!password) return setFieldError("login-password", "Enter your password.");

    setBusy(form, true);
    try {
      await api("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email, password,
          totp: totp || undefined,
          remember: data.get("remember") === "true",
        }),
      });
      // The session cookie is set by the proxy on the way back. A full
      // navigation rather than a client-side render, so the next page is
      // server-rendered with the identity already resolved.
      globalThis.location.assign(String(data.get("next") || "/"));
    } catch (error) {
      const failure = asApiError(error);

      if (failure.body.error === "two_factor_required") {
        if (totpStep) totpStep.hidden = false;
        setFormError(banner, "");
        setFieldError("login-totp", "");
        const field = /** @type {HTMLInputElement|null} */ ($("#login-totp"));
        field?.focus();
        toast("Enter the code from your authenticator app.");
        return;
      }

      const message = failure.body.detail || failure.body.error || "Could not sign you in.";
      setFormError(banner, message);
      // Announced as well as shown: the banner is above the fold on this form,
      // but the toast is what a screen reader reaches without moving focus.
      toast(message, "error");
      if (totp) setFieldError("login-totp", message);
    } finally {
      setBusy(form, false);
    }
  });
}

/** Create an account. */
function initRegisterForm() {
  const form = /** @type {HTMLFormElement|null} */ ($("[data-register-form]"));
  if (!form) return;

  const banner = $("#register-error");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.busy) return;

    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const confirm = String(data.get("confirmPassword") ?? "");
    const country = String(data.get("country") ?? "");

    setFormError(banner, "");
    for (const id of [
      "register-name", "register-email", "register-password",
      "register-confirm", "register-country", "register-terms",
    ]) setFieldError(id, "");

    // Every check that can be made locally is made before the request, and each
    // one names its own field — so the first thing wrong is the first thing
    // pointed at, rather than a single banner listing four problems at once.
    let firstBad = "";
    /** @param {string} id @param {string} message */
    const bad = (id, message) => {
      setFieldError(id, message);
      if (!firstBad) firstBad = id;
    };

    if (name.length < 2) bad("register-name", "Enter your full name.");
    if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
      bad("register-email", "Enter a valid email address.");
    }
    if (password.length < 10) {
      bad("register-password", `Use at least 10 characters — this one has ${password.length}.`);
    }
    if (confirm !== password) bad("register-confirm", "Those two passwords do not match.");
    if (!country) bad("register-country", "Choose your country of residence.");
    if (data.get("acceptedTerms") !== "true") {
      bad("register-terms", "You must accept the client agreement and risk disclosure.");
    }

    if (firstBad) {
      document.getElementById(firstBad)?.focus();
      return;
    }

    setBusy(form, true);
    try {
      await api("/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({
          name, email, password, country,
          baseCurrency: String(data.get("baseCurrency") ?? "USD"),
          acceptedTerms: true,
        }),
      });
      globalThis.location.assign("/");
    } catch (error) {
      const failure = asApiError(error);
      const message = failure.body.error || failure.body.detail || "Could not create your account.";

      // A duplicate address is about one field, and saying so next to that
      // field saves the reader from re-reading the whole form.
      if (failure.status === 409) {
        setFieldError("register-email", message);
        document.getElementById("register-email")?.focus();
      } else if (/password/i.test(message)) {
        setFieldError("register-password", message);
        document.getElementById("register-password")?.focus();
      }
      setFormError(banner, message);
      toast(message, "error");
    } finally {
      setBusy(form, false);
    }
  });
}

/** Change password, from the security page. */
function initPasswordChange() {
  const form = /** @type {HTMLFormElement|null} */ ($("[data-password-form]"));
  if (!form) return;

  const banner = $("#password-form-error");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.busy) return;

    const data = new FormData(form);
    const current = String(data.get("currentPassword") ?? "");
    const next = String(data.get("newPassword") ?? "");
    const confirm = String(data.get("confirmPassword") ?? "");

    setFormError(banner, "");
    for (const id of ["current-password", "new-password", "confirm-new-password"]) {
      setFieldError(id, "");
    }

    if (!current) return setFieldError("current-password", "Enter your current password.");
    if (next.length < 10) {
      return setFieldError("new-password", `Use at least 10 characters — this one has ${next.length}.`);
    }
    if (next === current) {
      return setFieldError("new-password", "Your new password must be different from your current one.");
    }
    if (confirm !== next) {
      return setFieldError("confirm-new-password", "Those two passwords do not match.");
    }

    setBusy(form, true);
    try {
      const result = await api("/v1/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      form.reset();
      toast(result.detail || "Your password was changed.");
      // Other sessions were revoked, so the list beside the form is now stale.
      await refreshSessions();
    } catch (error) {
      const failure = asApiError(error);
      const message = failure.body.error || failure.body.detail || "Could not change your password.";
      if (failure.status === 403) {
        setFieldError("current-password", message);
        document.getElementById("current-password")?.focus();
      } else {
        setFieldError("new-password", message);
      }
      setFormError(banner, message);
      toast(message, "error");
    } finally {
      setBusy(form, false);
    }
  });
}

/**
 * Two-factor enrolment.
 *
 * Three states in one panel: off, enrolling (secret shown, code awaited), and
 * on. The secret arrives from the API when enrolment starts and is never in the
 * page before that — see the note on the server-rendered panel.
 */
function initTwoFactor() {
  const toggle = $("[data-totp-toggle]");
  const panel = $("[data-totp-panel]");
  if (!toggle || !panel) return;

  const state = $("[data-totp-state]");
  const detail = $("[data-totp-detail]");

  /** @param {string} html */
  const fill = (html) => {
    panel.innerHTML = html;
    panel.hidden = !html;
  };

  const showEnabled = (/** @type {number} */ remaining) => {
    toggle.dataset.enabled = "true";
    toggle.textContent = "Turn off";
    toggle.classList.remove("btn-primary");
    toggle.classList.add("btn-secondary");
    if (state) state.textContent = "Enabled";
    if (detail) {
      detail.textContent = `${remaining} recovery code${remaining === 1 ? "" : "s"} remaining.`;
    }
  };

  const showDisabled = () => {
    toggle.dataset.enabled = "false";
    toggle.textContent = "Enable";
    toggle.classList.remove("btn-secondary");
    toggle.classList.add("btn-primary");
    if (state) state.textContent = "Not enabled";
    if (detail) detail.textContent = "Your password alone is enough to sign in to this account.";
    fill("");
  };

  toggle.addEventListener("click", async () => {
    // ---- turning it off ----
    if (toggle.dataset.enabled === "true") {
      fill(`<p class="small muted" style="margin-bottom:var(--s-3)">
          Turning off two-factor authentication needs your password. Without that,
          a borrowed session would be enough to remove the thing that makes a
          borrowed session useless.</p>
        <div class="field">
          <label class="label" for="totp-disable-password">Password</label>
          <input class="input" type="password" id="totp-disable-password"
                 autocomplete="current-password" aria-describedby="totp-disable-password-error">
          <p class="field-error" id="totp-disable-password-error" role="alert" hidden></p>
        </div>
        <div style="display:flex;gap:var(--s-3)">
          <button class="btn btn-secondary btn-sm" type="button" data-totp-cancel>Cancel</button>
          <button class="btn btn-primary btn-sm" type="button" data-totp-confirm-disable>
            Turn off two-factor
          </button>
        </div>`);
      $("#totp-disable-password")?.focus();
      return;
    }

    // ---- turning it on ----
    try {
      const enrolment = await api("/v1/auth/totp/begin", { method: "POST" });
      fill(`<h3 class="h3" style="margin-bottom:var(--s-2)">Add this account to your authenticator</h3>
        <p class="small muted">Enter this key in your authenticator app, then type the
        six-digit code it produces. The key is shown once.</p>
        <code class="totp-secret" data-totp-secret>${escapeHtml(enrolment.formattedSecret)}</code>
        <button class="btn btn-secondary btn-sm" type="button"
                data-copy="${escapeHtml(enrolment.secret)}">Copy key</button>
        <div class="field" style="margin-top:var(--s-4)">
          <label class="label" for="totp-confirm-code">Six-digit code</label>
          <input class="input input-code" type="text" id="totp-confirm-code"
                 inputmode="numeric" maxlength="6" autocomplete="one-time-code"
                 placeholder="000000" aria-describedby="totp-confirm-code-error">
          <p class="field-error" id="totp-confirm-code-error" role="alert" hidden></p>
        </div>
        <div style="display:flex;gap:var(--s-3)">
          <button class="btn btn-secondary btn-sm" type="button" data-totp-cancel>Cancel</button>
          <button class="btn btn-primary btn-sm" type="button" data-totp-confirm>
            Verify and turn on
          </button>
        </div>`);
      $("#totp-confirm-code")?.focus();
    } catch (error) {
      toast(asApiError(error).body.error || "Could not start two-factor setup.", "error");
    }
  });

  // Delegated, because the panel's contents are replaced on every state change
  // and listeners bound to the old markup would go with it.
  panel.addEventListener("click", async (event) => {
    const target = eventTarget(event);
    if (!target) return;

    if (target.closest("[data-totp-cancel]")) {
      fill("");
      return;
    }

    if (target.closest("[data-totp-confirm]")) {
      const input = /** @type {HTMLInputElement|null} */ ($("#totp-confirm-code"));
      const code = input?.value.trim() ?? "";
      setFieldError("totp-confirm-code", "");
      if (!/^\d{6}$/.test(code)) {
        setFieldError("totp-confirm-code", "Enter the six digits your app is showing.");
        return;
      }
      try {
        const result = await api("/v1/auth/totp/confirm", {
          method: "POST",
          body: JSON.stringify({ code }),
        });
        // Recovery codes are shown exactly once, so they get the whole panel
        // rather than a toast that disappears after six seconds.
        fill(`<div class="notice notice-warning" style="margin-bottom:var(--s-4)">
            <span class="notice-icon">${ALERT_SVG}</span>
            <div class="notice-body">
              <div class="notice-title">Save these recovery codes now</div>
              <div class="notice-text">Each one works once, in place of a code from
              your app. They are not shown again.</div>
            </div>
          </div>
          <div class="code-grid">
            ${/* Server-generated hex, but escaped anyway: the rule is that nothing
                 reaches innerHTML unescaped, so that it stays true when the shape
                 of what the API returns changes. */ ""}
            ${result.recoveryCodes
              .map((/** @type {string} */ c) => `<span>${escapeHtml(c)}</span>`)
              .join("")}
          </div>
          <div style="display:flex;gap:var(--s-3);margin-top:var(--s-4)">
            <button class="btn btn-secondary btn-sm" type="button"
                    data-copy="${escapeHtml(result.recoveryCodes.join(" "))}">Copy all</button>
            <button class="btn btn-primary btn-sm" type="button" data-totp-cancel>
              I have saved them
            </button>
          </div>`);
        showEnabled(result.recoveryCodes.length);
        toast("Two-factor authentication is on.");
      } catch (error) {
        const message = asApiError(error).body.error || "That code is not valid.";
        setFieldError("totp-confirm-code", message);
        toast(message, "error");
      }
      return;
    }

    if (target.closest("[data-totp-confirm-disable]")) {
      const input = /** @type {HTMLInputElement|null} */ ($("#totp-disable-password"));
      const password = input?.value ?? "";
      setFieldError("totp-disable-password", "");
      if (!password) {
        setFieldError("totp-disable-password", "Enter your password.");
        return;
      }
      try {
        await api("/v1/auth/totp/disable", {
          method: "POST",
          body: JSON.stringify({ password }),
        });
        showDisabled();
        toast("Two-factor authentication is off.");
      } catch (error) {
        const message = asApiError(error).body.error || "Could not turn off two-factor.";
        setFieldError("totp-disable-password", message);
        toast(message, "error");
      }
    }
  });
}

/** Ask for a reset link. */
function initForgotForm() {
  const form = /** @type {HTMLFormElement|null} */ ($("[data-forgot-form]"));
  if (!form) return;

  const banner = $("#forgot-error");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.busy) return;

    const email = String(new FormData(form).get("email") ?? "").trim();
    setFormError(banner, "");
    setFieldError("forgot-email", "");
    if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
      return setFieldError("forgot-email", "Enter a valid email address.");
    }

    setBusy(form, true);
    try {
      await api("/v1/auth/password/forgot", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      // Reloaded rather than swapped in place: the confirmation carries the
      // development link, which only the server can read out of the outbox.
      globalThis.location.assign(`/forgot-password?sent=1&email=${encodeURIComponent(email)}`);
    } catch (error) {
      const message = asApiError(error).body.detail || asApiError(error).body.error
        || "Could not create a reset link.";
      setFormError(banner, message);
      toast(message, "error");
      setBusy(form, false);
    }
  });
}

/** Set a new password from a reset link. */
function initResetForm() {
  const form = /** @type {HTMLFormElement|null} */ ($("[data-reset-form]"));
  if (!form) return;

  const banner = $("#reset-error");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.busy) return;

    const data = new FormData(form);
    const next = String(data.get("newPassword") ?? "");
    const confirm = String(data.get("confirmPassword") ?? "");

    setFormError(banner, "");
    setFieldError("reset-password", "");
    setFieldError("reset-confirm", "");

    if (next.length < 10) {
      return setFieldError("reset-password", `Use at least 10 characters — this one has ${next.length}.`);
    }
    if (next !== confirm) {
      return setFieldError("reset-confirm", "Those two passwords do not match.");
    }

    setBusy(form, true);
    try {
      await api("/v1/auth/password/reset", {
        method: "POST",
        body: JSON.stringify({ token: String(data.get("token") ?? ""), newPassword: next }),
      });
      // Every session was revoked, including any this browser held.
      globalThis.location.assign("/login?passwordChanged=1");
    } catch (error) {
      const failure = asApiError(error);
      const message = failure.body.error || failure.body.detail || "Could not set that password.";
      setFieldError("reset-password", message);
      setFormError(banner, message);
      toast(message, "error");
      setBusy(form, false);
    }
  });
}

/**
 * Re-render the active-sessions list in place.
 *
 * Called after anything that changes which sessions exist. Reloading the page
 * would also work and would be less code, but it throws away scroll position
 * and anything half-typed in the password form next to it.
 */
async function refreshSessions() {
  const host = $("[data-sessions]");
  if (!host) return;
  try {
    const { sessions } = await api("/v1/auth/sessions");
    if (sessions.length === 0) {
      host.innerHTML = '<div class="card-pad small muted">No other sessions.</div>';
      return;
    }
    host.textContent = "";
    for (const session of sessions) {
      const row = document.createElement("div");
      row.className = "setting-row";
      row.dataset.session = session.sessionId;

      const main = document.createElement("div");
      main.className = "setting-main";

      const label = document.createElement("div");
      label.className = "setting-label";
      // textContent throughout: the device string is derived from a User-Agent
      // header, which is attacker-controlled on any request that created a
      // session. innerHTML here would make the sessions list an XSS sink.
      label.textContent = session.device;
      if (session.current) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "This device";
        label.append(" ", tag);
      }

      const detail = document.createElement("div");
      detail.className = "setting-detail";
      detail.textContent = `${session.ip} · last seen ${new Date(session.lastSeenAt)
        .toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;

      main.append(label, detail);

      const action = document.createElement(session.current ? "a" : "button");
      action.className = "btn btn-secondary btn-sm";
      if (action instanceof HTMLAnchorElement) {
        action.href = "/signout";
        action.textContent = "Sign out";
      } else {
        /** @type {HTMLButtonElement} */ (action).type = "button";
        action.dataset.revokeSession = session.sessionId;
        action.textContent = "End";
      }

      row.append(main, action);
      host.append(row);
    }
  } catch {
    // The list is a view of something the page already showed once; failing to
    // refresh it is not worth interrupting anyone over.
  }
}

/** Ask for a fresh address-confirmation link. */
function initEmailVerification() {
  const button = $("[data-verify-email]");
  if (!button) return;

  button.addEventListener("click", async () => {
    /** @type {HTMLButtonElement} */ (button).disabled = true;
    try {
      const result = await api("/v1/auth/email/verify/request", { method: "POST" });
      toast(result.detail || "A confirmation link has been created.");
      const detail = $("[data-email-detail]");
      // Says where the link went, because it did not go to an inbox.
      if (detail) {
        detail.textContent =
          "A confirmation link was created. There is no email provider, so it is " +
          "waiting in the outbox rather than in your inbox.";
      }
    } catch (error) {
      toast(asApiError(error).body.error || "Could not create a confirmation link.", "error");
      /** @type {HTMLButtonElement} */ (button).disabled = false;
    }
  });
}

/** Ending other sessions. */
function initSessionActions() {
  document.addEventListener("click", async (event) => {
    const target = eventTarget(event);
    if (!target) return;

    const one = target.closest("[data-revoke-session]");
    if (one instanceof HTMLElement) {
      const sessionId = String(one.dataset.revokeSession);
      try {
        const result = await api("/v1/auth/sessions/revoke", {
          method: "POST",
          body: JSON.stringify({ sessionId }),
        });
        toast(result.detail || "That session was signed out.");
        await refreshSessions();
      } catch (error) {
        toast(asApiError(error).body.error || "Could not end that session.", "error");
      }
      return;
    }

    if (target.closest("[data-revoke-all]")) {
      try {
        const result = await api("/v1/auth/sessions/revoke", {
          method: "POST",
          body: JSON.stringify({ all: true }),
        });
        toast(result.detail || "Other sessions ended.");
        await refreshSessions();
      } catch (error) {
        toast(asApiError(error).body.error || "Could not end those sessions.", "error");
      }
    }
  });
}

/* ------------------------------------------------------------------- boot */

initTheme();
initSidebar();
initMenus();
initModal();
initAccountActions();
initFunding();
initTerminal();

initPasswordReveal();
initPasswordMeter();
initLoginForm();
initRegisterForm();
initPasswordChange();
initForgotForm();
initResetForm();
initTwoFactor();
initEmailVerification();
initSessionActions();

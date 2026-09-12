/**
 * Console behaviour, served at /console.js.
 *
 * The page is complete before this runs. Every button here is a real form post,
 * so the console works with scripting off — this adds the three things a server
 * render cannot: a confirmation before something irreversible, a toast after it,
 * and a countdown on the pages that refresh themselves.
 */

/** @param {string} sel @param {ParentNode} [root] */
const $ = (sel, root = document) =>
  /** @type {HTMLElement | null} */ (root.querySelector(sel));

/** @param {string} sel @param {ParentNode} [root] */
const $$ = (sel, root = document) =>
  /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)]);

/** @param {string} message @param {"info"|"error"} [tone] */
function toast(message, tone = "info") {
  const host = $("[data-toasts]");
  if (!host) return;

  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", tone === "error" ? "alert" : "status");

  // Built as nodes. The text can carry an API error, and an API error is where
  // somebody else's input ends up quoted back.
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
  setTimeout(() => el.remove(), 7000);
}

/* ------------------------------------------------------------------ theme */

function initTheme() {
  const root = document.documentElement;
  const sync = () => {
    const dark = root.dataset.theme !== "light";
    // Show the theme you would switch to, not the one you are in.
    $$("[data-theme-icon]").forEach((el) => {
      el.hidden = el.dataset.themeIcon === (dark ? "light" : "dark");
    });
  };
  sync();
  $$("[data-theme-toggle]").forEach((button) =>
    button.addEventListener("click", () => {
      const next = root.dataset.theme === "light" ? "dark" : "light";
      root.dataset.theme = next;
      try { localStorage.setItem("px-ops-theme", next); } catch {}
      sync();
    }),
  );
}

/* ---------------------------------------------------------- confirmations */

/**
 * A confirmation before anything that affects a real person.
 *
 * The prompt carries the specific sentence the server rendered — "Remove
 * two-factor authentication from ada@example.com?" rather than "Are you sure?".
 * A confirmation that does not say what it is confirming is a confirmation
 * people learn to click through.
 */
function initConfirmations() {
  $$("form[data-confirm]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      const question = form.dataset.confirm ?? "Are you sure?";
      if (!globalThis.confirm(question)) {
        event.preventDefault();
        return;
      }
      // Disable on the way out, so a double click is not two requests.
      const button = /** @type {HTMLButtonElement|null} */ (form.querySelector("button[type=submit]"));
      if (button) {
        button.disabled = true;
        button.textContent = "Working…";
      }
    });
  });
}

/* ----------------------------------------------------------------- result */

/**
 * Report what the last action did.
 *
 * The server redirects with `?done=` or `?error=` rather than rendering a
 * message into the page, so a refresh does not repeat the action. This turns
 * that into a toast and then removes it from the URL — otherwise the message
 * reappears every time the tab is restored.
 */
function initActionResult() {
  const params = new URLSearchParams(location.search);
  const done = params.get("done");
  const failed = params.get("error");
  if (!done && !failed) return;

  const readable = /** @type {Record<string, string>} */ ({
    "revoke-sessions": "Sessions ended.",
    unlock: "Lockout cleared.",
    suspend: "Account suspended.",
    restore: "Account restored.",
    "clear-two-factor": "Two-factor authentication removed.",
    expired: "That form had expired. Nothing was changed.",
  });

  if (done) toast(readable[done] ?? "Done.");
  if (failed) toast(readable[failed] ?? `Could not complete: ${failed}`, "error");

  params.delete("done");
  params.delete("error");
  const rest = params.toString();
  history.replaceState({}, "", location.pathname + (rest ? `?${rest}` : ""));
}

/* ---------------------------------------------------------------- refresh */

/**
 * Auto-refresh, with the wait visible.
 *
 * A page that reloads under somebody mid-read is worse than a stale one, so the
 * countdown is shown and hovering the page postpones it. An operator reading a
 * failure has not asked for it to be replaced.
 */
function initRefresh() {
  const seconds = Number(document.body.dataset.refresh ?? 0);
  const label = $("[data-countdown]");
  if (!seconds || !label) return;

  let remaining = seconds;
  let paused = false;

  // Hovering anything interactive postpones the reload.
  document.addEventListener("mouseenter", () => { paused = true; }, true);
  document.addEventListener("mouseleave", () => { paused = false; }, true);
  document.addEventListener("focusin", () => { paused = true; });

  setInterval(() => {
    if (paused || document.hidden) {
      label.textContent = "refresh paused";
      return;
    }
    remaining -= 1;
    if (remaining <= 0) {
      location.reload();
      return;
    }
    label.textContent = `refreshing in ${remaining}s`;
  }, 1000);
}

/* ------------------------------------------------------------------- boot */

initTheme();
initConfirmations();
initActionResult();
initRefresh();

/* ---------------------------------------------------------- telemetry */

/**
 * The telemetry page stays live: the table is re-rendered from each event
 * on the operator stream. Built as nodes — every cell is somebody's request
 * path, which is somebody's input.
 */
function initTelemetry() {
  const host = $("[data-telemetry]");
  const state = $("[data-telemetry-state]");
  if (!host) return;
  const stream = new EventSource("/telemetry/stream");
  stream.addEventListener("open", () => { if (state) state.textContent = "live"; });
  stream.addEventListener("error", () => { if (state) state.textContent = "reconnecting…"; });
  stream.addEventListener("telemetry", (event) => {
    /** @type {{users: any[], tracked: number, at: string}} */
    let data;
    try { data = JSON.parse(/** @type {MessageEvent} */ (event).data); } catch { return; }
    if (state) state.textContent = `live · ${new Date(data.at).toLocaleTimeString("en-GB")}`;
    renderTelemetry(host, data);
    const kpis = $$("[data-telemetry-kpis] .kpi-value");
    const sum = (/** @type {string} */ key) => data.users.reduce((n, u) => n + (Number(u[key]) || 0), 0);
    if (kpis[0]) kpis[0].textContent = String(data.users.length);
    if (kpis[1]) kpis[1].textContent = String(sum("requestsPerMinute"));
    if (kpis[2]) kpis[2].textContent = String(sum("ordersPerMinute"));
  });
}

/**
 * @param {HTMLElement} host
 * @param {{users: any[]}} data
 */
function renderTelemetry(host, data) {
  const table = host.querySelector("tbody");
  if (!table) { location.reload(); return; }
  const cell = (/** @type {string} */ text, /** @type {string} */ cls = "") => {
    const td = document.createElement("td");
    td.className = cls;
    td.textContent = text;
    return td;
  };
  const rows = data.users.map((u) => {
    const tr = document.createElement("tr");
    const who = document.createElement("td");
    who.className = "small";
    if (u.authenticated && String(u.owner).includes("-")) {
      const a = document.createElement("a");
      a.className = "row-link";
      a.href = `/users/${encodeURIComponent(u.owner)}`;
      a.textContent = `${String(u.owner).slice(0, 8)}…`;
      who.append(a);
    } else {
      who.textContent = String(u.owner);
      who.classList.add("muted", "mono");
    }
    const accounts = document.createElement("td");
    accounts.className = "small";
    for (const a of u.accounts ?? []) {
      const line = document.createElement("div");
      line.className = "mono";
      line.textContent = `${a.accountNumber} eq ${a.equity ?? "—"} ml ${a.marginLevel ?? "—"}${a.openPositions ? ` (${a.openPositions} open)` : ""}`;
      accounts.append(line);
    }
    if (!accounts.childElementCount) accounts.textContent = "—";
    tr.append(
      who,
      cell(String(u.requestsPerMinute), "num mono small"),
      cell(String(u.errorsPerMinute), `num mono small${u.errorsPerMinute ? " is-negative" : ""}`),
      cell(String(u.throttledPerMinute), `num mono small${u.throttledPerMinute ? " is-negative" : ""}`),
      cell(`${u.ordersPerMinute} / ${u.orders}`, "num mono small"),
      cell(`${u.meanMs} ms`, "num mono small"),
      cell(`${u.lastPath} ${u.lastStatus}`, "small mono truncate"),
      accounts,
      cell("just now", "num small muted"),
    );
    return tr;
  });
  table.replaceChildren(...rows);
}

initTelemetry();

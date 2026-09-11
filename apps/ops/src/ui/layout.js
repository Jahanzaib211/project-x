/**
 * The console shell and the pieces every page is built from.
 *
 * Server-rendered like the client area, and for the same reason: the page
 * arrives complete, and `console.js` only upgrades the parts that need to act.
 * An operator console that shows spinners during an incident is a console that
 * is unusable exactly when it matters.
 */

/** @param {unknown} s */
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/* ------------------------------------------------------------------ icons */

/**
 * @param {string} paths
 * @param {number} size
 */
const svg = (paths, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icon = {
  overview: (s = 16) => svg('<rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/>', s),
  users: (s = 16) => svg('<path d="M15.5 20v-1.5a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 20v-1.5a4 4 0 0 0-3-3.87"/><path d="M16 4.13a4 4 0 0 1 0 7.75"/>', s),
  gates: (s = 16) => svg('<path d="m4.5 12.5 5 5 10-11"/>', s),
  modules: (s = 16) => svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h4a2 2 0 0 1 2 2v5.5"/>', s),
  infra: (s = 16) => svg('<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>', s),
  audit: (s = 16) => svg('<path d="M12 3 5 5.8v5.6c0 4.2 2.9 8.1 7 9.1 4.1-1 7-4.9 7-9.1V5.8L12 3Z"/><path d="m9.2 12 2 2 3.6-3.8"/>', s),
  mail: (s = 16) => svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>', s),
  logs: (s = 16) => svg('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>', s),
  accounts: (s = 16) => svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 10h17M7 14.5h4"/>', s),
  database: (s = 16) => svg('<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>', s),
  logout: (s = 16) => svg('<path d="M10 20.5H6.5A2.5 2.5 0 0 1 4 18V6a2.5 2.5 0 0 1 2.5-2.5H10"/><path d="m15 16.5 4.5-4.5L15 7.5M19.5 12H9"/>', s),
  refresh: (s = 16) => svg('<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 4v5h-5"/>', s),
  play: (s = 16) => svg('<path d="M7 4.5v15l13-7.5Z"/>', s),
  alert: (s = 16) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>', s),
  info: (s = 16) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 16v-5M12 8h.01"/>', s),
  check: (s = 16) => svg('<path d="m4.5 12.5 5 5 10-11"/>', s),
  sun: (s = 16) => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', s),
  moon: (s = 16) => svg('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>', s),
  back: (s = 16) => svg('<path d="M15 5.5 8.5 12l6.5 6.5"/>', s),
};

/* ------------------------------------------------------------ components */

/**
 * A headline number.
 * @param {{label: string, value: string|number, note?: string, tone?: "positive"|"warning"|"danger"}} options
 */
export function kpi({ label, value, note = "", tone }) {
  return `<div class="card kpi">
    <span class="kpi-label">${esc(label)}</span>
    <span class="kpi-value${tone ? ` is-${tone}` : ""}">${esc(value)}</span>
    ${note ? `<span class="kpi-note">${esc(note)}</span>` : ""}
  </div>`;
}

/**
 * @param {string} text
 * @param {"positive"|"warning"|"danger"|"accent"|""} [tone]
 */
export const badge = (text, tone = "") =>
  `<span class="badge${tone ? ` badge-${tone}` : ""}">${esc(text)}</span>`;

/** @param {string} tier */
export const tierBadge = (tier) =>
  `<span class="tier tier-${esc(tier)}">${esc(tier)}</span>`;

/**
 * A table, or an honest empty state.
 *
 * The empty message is required rather than optional: a table that renders
 * nothing without saying why reads as a loading state that never finished.
 *
 * @param {{columns: Array<{label: string, align?: "num"}>, rows: string[], empty: string}} options
 */
export function table({ columns, rows, empty }) {
  if (rows.length === 0) {
    return `<div class="table-empty small">${esc(empty)}</div>`;
  }
  return `<div class="table-wrap"><table class="table">
    <thead><tr>${columns.map((c) => `<th${c.align === "num" ? ' class="num"' : ""}>${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table></div>`;
}

/**
 * A panel whose data source failed.
 *
 * Named rather than blank. "docker is not available to this process" is
 * actionable; an empty card is a bug report.
 *
 * @param {string} what
 * @param {string} why
 */
export const unavailable = (what, why) =>
  `<div class="notice notice-warning">
    <span class="notice-icon">${icon.alert(16)}</span>
    <div class="notice-body">
      <div class="notice-title">${esc(what)} unavailable</div>
      <div class="notice-text">${esc(why)}</div>
    </div>
  </div>`;

/**
 * Relative time, in the coarse words an operator actually reasons in.
 * @param {string|null|undefined} iso
 */
export function ago(iso) {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** @param {number} ms */
export function duration(ms) {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/* ----------------------------------------------------------------- shell */

/**
 * @typedef {object} NavEntry
 * @property {string} href
 * @property {string} label
 * @property {keyof typeof icon} icon
 * @property {string|number} [count]
 */

/** @type {NavEntry[]} */
export const NAV = [
  { href: "/", label: "Overview", icon: "overview" },
  { href: "/users", label: "Users", icon: "users" },
  { href: "/accounts", label: "Accounts", icon: "accounts" },
  { href: "/gates", label: "Gates", icon: "gates" },
  { href: "/modules", label: "Modules", icon: "modules" },
  { href: "/infra", label: "Infrastructure", icon: "infra" },
  { href: "/database", label: "Database", icon: "database" },
  { href: "/audit", label: "Audit", icon: "audit" },
  { href: "/outbox", label: "Outbox", icon: "mail" },
  { href: "/logs", label: "Logs", icon: "logs" },
];

/**
 * @param {string} href
 * @param {string} path
 */
function isCurrent(href, path) {
  if (href === "/") return path === "/";
  return path === href || path.startsWith(`${href}/`);
}

/**
 * The full console page.
 *
 * @param {{
 *   title: string, path: string, body: string, operator: string,
 *   csrf: string, counts?: Record<string, string|number>, refresh?: number
 * }} options
 */
export function page({ title, path, body, operator, csrf, counts = {}, refresh = 0 }) {
  const nav = NAV.map((entry) => {
    const current = isCurrent(entry.href, path);
    const count = counts[entry.href];
    return `<a class="nav-item" href="${esc(entry.href)}"${current ? ' aria-current="page"' : ""}>
      ${icon[entry.icon](16)}
      <span>${esc(entry.label)}</span>
      ${count !== undefined && count !== "" ? `<span class="count">${esc(count)}</span>` : ""}
    </a>`;
  }).join("");

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${esc(title)} · Project X Ops</title>
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%234d8dff"/><text x="16" y="21" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="%23fff" text-anchor="middle">PX</text></svg>',
  )}">
<script>
  (function () {
    try {
      var stored = localStorage.getItem("px-ops-theme");
      if (stored) document.documentElement.dataset.theme = stored;
    } catch (e) {}
  })();
</script>
</head>
<body data-csrf="${esc(csrf)}"${refresh ? ` data-refresh="${refresh}"` : ""}>
<a href="#main" class="sr-only">Skip to content</a>
<div class="app">
  <aside class="sidebar">
    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true">PX</span>
      <span>
        <span class="brand-name">Project X</span><br>
        <span class="brand-sub">Ops</span>
      </span>
    </a>
    <nav aria-label="Console">${nav}</nav>
    <div class="sidebar-foot">
      <div class="small muted truncate" title="${esc(operator)}">Signed in as ${esc(operator)}</div>
      <form method="post" action="/logout" style="margin-top:var(--s-2)">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <button class="btn btn-sm btn-block" type="submit">${icon.logout(14)} Sign out</button>
      </form>
    </div>
  </aside>

  <div class="main">
    <header class="topbar">
      <span class="eyebrow">${esc(title)}</span>
      <span class="grow"></span>
      ${refresh ? `<span class="small muted" data-countdown="${refresh}">refreshing…</span>` : ""}
      <button class="btn btn-sm" type="button" data-theme-toggle aria-label="Switch theme">
        <span data-theme-icon="dark">${icon.moon(14)}</span>
        <span data-theme-icon="light" hidden>${icon.sun(14)}</span>
      </button>
      <button class="btn btn-sm" type="button" onclick="location.reload()">${icon.refresh(14)} Refresh</button>
    </header>
    <main class="page" id="main">${body}</main>
  </div>
</div>
<div class="toasts" data-toasts aria-live="polite"></div>
<script type="module" src="/console.js"></script>
</body>
</html>`;
}

/**
 * The sign-in page.
 *
 * Deliberately says nothing about the system behind it: no version, no module
 * list, no hostname. An unauthenticated page is a page an attacker reads.
 *
 * @param {{error?: string, csrf: string, retryAfter?: number}} options
 */
export function loginPage({ error = "", csrf, retryAfter = 0 }) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>Sign in · Project X Ops</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="login-shell">
  <div class="login-card">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">PX</span>
      <span>
        <span class="brand-name">Project X</span><br>
        <span class="brand-sub">Ops</span>
      </span>
    </div>

    ${error ? `<div class="notice notice-danger" style="margin-bottom:var(--s-4)">
      <span class="notice-icon">${icon.alert(16)}</span>
      <div class="notice-body">
        <div class="notice-text">${esc(error)}</div>
      </div>
    </div>` : ""}

    <form method="post" action="/login">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <div class="field">
        <label class="label" for="passcode">Operator passcode</label>
        <input class="input" type="password" id="passcode" name="passcode"
               autocomplete="current-password" required autofocus
               ${retryAfter ? "disabled" : ""}>
      </div>
      <div class="field">
        <label class="label" for="operator">Your name <span class="muted">(for the audit trail)</span></label>
        <input class="input" type="text" id="operator" name="operator"
               maxlength="60" placeholder="e.g. jahanzaib" autocomplete="username"
               ${retryAfter ? "disabled" : ""}>
      </div>
      <button class="btn btn-primary btn-block" type="submit" ${retryAfter ? "disabled" : ""}>
        ${retryAfter ? `Locked for ${retryAfter}s` : "Sign in"}
      </button>
    </form>

    <p class="micro muted" style="margin-top:var(--s-4);line-height:1.6">
      Every action taken here is recorded against the account it affects, with
      the name above attached to it.
    </p>
  </div>
</div>
</body>
</html>`;
}

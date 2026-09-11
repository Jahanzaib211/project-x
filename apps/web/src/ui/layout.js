/**
 * The application shell: topbar, sidebar, page slot, footer.
 *
 * Server-rendered. The page arrives complete and readable before any script
 * runs; `client.js` then upgrades the interactive parts. That ordering is why
 * navigation works with JavaScript disabled and why nothing flashes on load.
 */

import { glyph, icon } from "./icons.js";

/** @param {unknown} s */
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/**
 * A single navigation entry.
 * @typedef {object} NavItem
 * @property {string} href
 * @property {string} label
 * @property {string} icon       Glyph name. Required: the collapsed rail shows
 *                               only icons, so an item without one is invisible.
 * @property {string} [tag]      Small badge, e.g. "New".
 * @property {boolean} [external] Opens in a new tab.
 */

/**
 * A navigation group.
 * @typedef {object} NavGroup
 * @property {string} id
 * @property {string} label
 * @property {string} icon
 * @property {NavItem[]} items
 */

/**
 * Navigation. Mirrors how a client actually thinks about the product: what I
 * trade with, how money gets in and out, what I can learn, what I earn.
 *
 * @type {NavGroup[]}
 */
export const NAV = [
  {
    id: "trading",
    label: "Trading",
    icon: "candles",
    items: [
      { href: "/", label: "Accounts", icon: "rows" },
      { href: "/instruments", label: "Instruments", icon: "chart" },
      { href: "/performance", label: "Performance", icon: "gauge" },
      { href: "/orders", label: "History of orders", icon: "list" },
      { href: "/terminal", label: "Trading terminal", icon: "candles", external: true },
    ],
  },
  {
    id: "payments",
    label: "Payments & wallet",
    icon: "wallet",
    items: [
      { href: "/deposit", label: "Deposit", icon: "arrowDownCircle" },
      { href: "/withdraw", label: "Withdraw", icon: "arrowUpCircle" },
      { href: "/transfer", label: "Transfer", icon: "transfer", tag: "New" },
      { href: "/transactions", label: "Transaction history", icon: "receipt" },
      { href: "/funding-wallet", label: "Funding wallet", icon: "wallet", tag: "New" },
      { href: "/crypto-wallet", label: "Crypto wallet", icon: "bitcoin" },
      { href: "/verification", label: "Verification", icon: "shield" },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    icon: "chart",
    items: [
      { href: "/insights", label: "Market overview", icon: "sparkline" },
      { href: "/insights/calendar", label: "Economic calendar", icon: "calendar" },
    ],
  },
  {
    id: "benefits",
    label: "Benefits",
    icon: "gift",
    items: [{ href: "/rewards", label: "Trading credits", icon: "coins" }],
  },
];

/**
 * @param {{path: string, rail: boolean}} ctx
 */
function sidebar({ path, rail }) {
  const groups = NAV.map((group) => {
    const open = group.items.some((i) => isCurrent(i.href, path)) || group.id !== "insights";
    const items = group.items
      .map((item) => {
        const current = isCurrent(item.href, path);
        return `<li>
          <a class="nav-item" href="${esc(item.href)}"${current ? ' aria-current="page"' : ""}${
            item.external ? ' target="_blank" rel="noopener"' : ""
          } title="${esc(item.label)}">
            <span class="nav-icon">${glyph(item.icon, 18)}</span>
            <span class="nav-label">${esc(item.label)}</span>
            ${item.tag ? `<span class="tag">${esc(item.tag)}</span>` : ""}
            ${item.external ? `<span class="ext">${icon.external(14)}</span>` : ""}
          </a>
        </li>`;
      })
      .join("");

    return `<div class="nav-group" data-open="${open}" data-group="${esc(group.id)}" style="--tint: var(--tint-${esc(group.id)})">
      <button class="nav-group-head" type="button" data-toggle-group aria-expanded="${open}">
        ${glyph(group.icon, 18)}
        <span class="nav-label">${esc(group.label)}</span>
        <span class="chev">${icon.chevronDown(16)}</span>
      </button>
      <ul class="nav-items">${items}</ul>
    </div>`;
  }).join("");

  return `<aside class="sidebar" id="sidebar">
    <nav class="nav" aria-label="Main">
      ${groups}
      <a class="nav-cta" href="/referrals">
        ${icon.users(18)}
        <span>Refer traders,<br>earn commission</span>
      </a>
    </nav>
    <div class="sidebar-foot">
      <button class="collapse-btn" type="button" data-collapse aria-label="${
        rail ? "Expand sidebar" : "Collapse sidebar"
      }">
        ${icon.chevronsLeft(18)}
        <span>Collapse</span>
      </button>
    </div>
  </aside>`;
}

/**
 * @param {string} href
 * @param {string} path
 */
function isCurrent(href, path) {
  if (href === "/") return path === "/";
  return path === href || path.startsWith(`${href}/`);
}

/**
 * The signed-in identity, as the shell needs it.
 *
 * @typedef {object} SessionUser
 * @property {string} name
 * @property {string} email
 * @property {boolean} [twoFactorEnabled]
 */

/**
 * @param {{balance: string|null, unavailableReason: string|null}} wallet
 * @param {SessionUser|null} [user] Null when signed out.
 */
function topbar(wallet, user = null) {
  const balanceLabel = wallet.balance ? `${wallet.balance} USD` : "Balance unavailable";

  return `<header class="topbar">
    <button class="icon-btn menu-toggle" type="button" data-drawer-toggle aria-label="Open navigation" style="display:none">
      ${icon.menu(20)}
    </button>

    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true">PX</span>
      <span class="brand-name">Project X</span>
    </a>

    <div class="topbar-spacer"></div>

    <a class="balance-chip" href="/funding-wallet" title="${esc(
      wallet.unavailableReason ?? "Funding wallet",
    )}">
      ${icon.wallet(16)}
      <span class="num" data-wallet-balance>${esc(balanceLabel)}</span>
    </a>

    <button class="icon-btn" type="button" data-theme-toggle aria-label="Switch theme">
      <span data-theme-icon="light">${icon.sun(19)}</span>
      <span data-theme-icon="dark" hidden>${icon.moon(19)}</span>
    </button>

    <button class="icon-btn" type="button" aria-label="Language">${icon.globe(19)}</button>
    <a class="icon-btn" href="/help" aria-label="Help">${icon.help(19)}</a>

    <div class="has-menu">
      <button class="icon-btn" type="button" data-menu="notifications" aria-expanded="false" aria-haspopup="true" aria-label="Notifications">
        ${icon.bell(19)}<span class="dot"></span>
      </button>
      <div class="menu" data-menu-panel="notifications" hidden>
        <div class="menu-head">
          <div class="h3">Notifications</div>
        </div>
        <div style="padding:var(--s-3)" class="small muted" data-notifications>Loading…</div>
        <div class="menu-sep"></div>
        <a class="menu-item" href="/notifications">${icon.bell(16)} All notifications</a>
      </div>
    </div>

    <button class="icon-btn" type="button" aria-label="Apps">${icon.apps(19)}</button>

    ${user ? `<div class="has-menu">
      <button class="icon-btn avatar-btn" type="button" data-menu="profile" aria-expanded="false" aria-haspopup="true" aria-label="Account menu">
        <span class="avatar" aria-hidden="true">${esc(initials(user.name))}</span>
      </button>
      <div class="menu" data-menu-panel="profile" hidden>
        <div class="menu-head">
          <div class="h3" data-profile-name>${esc(user.name)}</div>
          <div class="micro muted" data-profile-email>${esc(user.email)}</div>
        </div>
        <a class="menu-item" href="/profile">${icon.user(16)} Profile</a>
        <a class="menu-item" href="/security">${icon.shield(16)} Security</a>
        <a class="menu-item" href="/settings">${icon.settings(16)} Settings</a>
        <div class="menu-sep"></div>
        <a class="menu-item" href="/signout">${icon.logout(16)} Sign out</a>
      </div>
    </div>` : `<div class="topbar-auth">
      <a class="btn btn-ghost btn-sm" href="/login">Sign in</a>
      <a class="btn btn-primary btn-sm" href="/register">Create account</a>
    </div>`}
  </header>`;
}

/**
 * Initials for the avatar.
 *
 * First and last, which is what people recognise themselves by. A single-word
 * name gives one letter rather than a padded pair, and anything unparseable
 * falls back to a glyph rather than rendering an empty circle.
 *
 * @param {string} name
 */
export function initials(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  const first = [...(parts[0] ?? "")][0] ?? "";
  const last = parts.length > 1 ? [...(parts[parts.length - 1] ?? "")][0] ?? "" : "";
  return (first + last).toUpperCase() || "·";
}

/**
 * Site footer.
 *
 * Three bands, each separated by a rule: navigation, the risk and status
 * disclosure, then the legal line. A brokerage footer carries the whole
 * document suite — a single row of four links reads as an unfinished site, and
 * on a financial site the absence of those documents is itself a signal.
 */
const FOOTER_COLUMNS = [
  {
    heading: "Trading",
    links: [
      { href: "/", label: "Accounts" },
      { href: "/instruments", label: "Instruments" },
      { href: "/fees", label: "Fees and charges" },
      { href: "/orders", label: "Order history" },
      { href: "/performance", label: "Performance" },
    ],
  },
  {
    heading: "Platforms",
    links: [
      { href: "/terminal", label: "Web terminal" },
      { href: "/platforms", label: "All platforms" },
      { href: "/api-access", label: "API access" },
      { href: "/insights", label: "Market overview" },
      { href: "/insights/calendar", label: "Economic calendar" },
    ],
  },
  {
    heading: "Funding",
    links: [
      { href: "/deposit", label: "Deposit" },
      { href: "/withdraw", label: "Withdraw" },
      { href: "/transfer", label: "Transfer" },
      { href: "/transactions", label: "Transaction history" },
      { href: "/verification", label: "Verification" },
    ],
  },
  {
    heading: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
      { href: "/docs/regulation", label: "Regulatory status" },
      { href: "/status", label: "Platform status" },
      { href: "/help", label: "Help centre" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/docs/terms", label: "Client agreement" },
      { href: "/docs/risk", label: "Risk disclosure" },
      { href: "/docs/execution", label: "Order execution" },
      { href: "/docs/privacy", label: "Privacy policy" },
      { href: "/docs", label: "All documents" },
    ],
  },
];

const FOOTER_BOTTOM = [
  { href: "/docs/cookies", label: "Cookies" },
  { href: "/docs/complaints", label: "Complaints" },
  { href: "/docs/conflicts", label: "Conflicts of interest" },
  { href: "/docs/aml", label: "AML policy" },
  { href: "/docs/compensation", label: "Client funds" },
  { href: "/docs/accessibility", label: "Accessibility" },
  { href: "/docs/disclosure", label: "Responsible disclosure" },
];

function footer() {
  const columns = FOOTER_COLUMNS.map((col) => `<div class="footer-col">
    <h2 class="footer-heading">${esc(col.heading)}</h2>
    <ul>
      ${col.links.map((l) => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`).join("")}
    </ul>
  </div>`).join("");

  return `<footer class="footer">
    <div class="footer-band">
      <div class="footer-inner footer-top">
        <div class="footer-brand">
          <span class="brand">
            <span class="brand-mark" aria-hidden="true">PX</span>
            <span class="brand-name">Project X</span>
          </span>
          <p>A reference implementation of a brokerage platform, built in
          dependency order with every financial law enforced as a test.</p>
          <a class="footer-status" href="/status">
            <span class="footer-status-dot"></span> Platform status
          </a>
        </div>
        <nav class="footer-cols" aria-label="Footer">${columns}</nav>
      </div>
    </div>

    <div class="footer-band">
      <div class="footer-inner footer-risk">
        <p><strong>Risk warning.</strong> Trading leveraged products carries a high
        risk of loss. Leverage magnifies both gains and losses, and losses can exceed
        the amount deposited. Prices gap, and a stop is an instruction to execute at
        the next available price rather than a guarantee of that price. Read the
        <a href="/docs/risk">risk disclosure</a> before trading.</p>
        <p><strong>Not a regulated firm.</strong> Project X is not authorised by any
        financial authority, holds no client money, and executes no orders on any
        market. Do not deposit funds — there is nowhere for them to go. Where a real
        firm publishes a licence number, this platform publishes
        <a href="/docs/regulation">this</a>.</p>
        <p><strong>Demo capital is not money.</strong> A demo account is funded from
        the ledger's demo capital pot and settles through the same journal, risk engine
        and execution path as a real one. No payment rail is involved, nothing can be
        withdrawn, and no position is placed on any market.</p>
        <p><strong>Figures shown as unavailable are unavailable.</strong> Where the core
        has no figure — an account with nothing open has no margin level — the interface
        says so and names the module responsible, rather than displaying a zero.</p>
      </div>
    </div>

    <div class="footer-band">
      <div class="footer-inner footer-bottom">
        <p class="footer-copy">© ${new Date().getFullYear()} Project X · Reference software · No client funds held</p>
        <nav class="footer-mini" aria-label="Policies">
          ${FOOTER_BOTTOM.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join("")}
        </nav>
      </div>
    </div>
  </footer>`;
}


/**
 * The document head, shared by every shell.
 *
 * Kept in one place because the theme bootstrap has to run before first paint
 * on *every* page, including the auth screens. Duplicating it was how the login
 * page ended up flashing white for a frame on a dark-themed browser.
 *
 * @param {string} title
 */
function head(title) {
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · Project X</title>
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="%2314171c"/><text x="16" y="21" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="%23fff" text-anchor="middle">PX</text></svg>',
  )}">
<script>
  // Applied before first paint so the correct theme is never repainted.
  (function () {
    try {
      var stored = localStorage.getItem("px-theme");
      var theme = stored || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      document.documentElement.dataset.theme = theme;
      if (localStorage.getItem("px-rail") === "true") document.documentElement.dataset.rail = "true";
    } catch (e) {}
  })();
</script>
</head>`;
}

/**
 * Render a full page.
 * @param {{
 *   title: string, path: string, body: string,
 *   wallet?: {balance: string|null, unavailableReason: string|null},
 *   user?: SessionUser|null,
 *   rail?: boolean, modal?: string
 * }} options
 */
export function page({
  title, path, body,
  wallet = { balance: null, unavailableReason: null },
  user = null, rail = false, modal = "",
}) {
  // The chart suite is loaded on the terminal alone. It is a quarter of a
  // megabyte the accounts page has no use for.
  const chartScripts = path === "/terminal"
    ? `<script src="/vendor/klinecharts.min.js"></script>
<script type="module" src="/chart.js"></script>`
    : "";
  return `<!doctype html>
<html lang="en" data-theme="light">
${head(title)}
<body>
<a href="#main" class="sr-only">Skip to content</a>
<!-- Rail state is carried on <html> by the inline head script, not here: the
     server cannot know it, and reading it after paint would flash. -->
<div class="app">
  ${topbar(wallet, user)}
  ${sidebar({ path, rail })}
  <div class="main">
    <main class="page" id="main">${body}</main>
    ${footer()}
  </div>
</div>
${modal}
<div class="toasts" data-toasts aria-live="polite"></div>
${chartScripts}
<script type="module" src="/client.js"></script>
</body>
</html>`;
}

/**
 * The shell for signed-out screens.
 *
 * No sidebar and no balance chip, because neither means anything without a
 * session — a navigation rail full of links that all bounce back to /login is
 * worse than no rail. The footer stays: the risk warning and the regulatory
 * position are exactly what somebody deciding whether to register needs, and
 * hiding them until after they have signed up would be the wrong way round.
 *
 * @param {{title: string, body: string}} options
 */
export function authLayout({ title, body }) {
  return `<!doctype html>
<html lang="en" data-theme="light">
${head(title)}
<body class="auth-body">
<a href="#main" class="sr-only">Skip to content</a>
<div class="auth-shell">
  <header class="auth-topbar">
    <a class="brand" href="/login">
      <span class="brand-mark" aria-hidden="true">PX</span>
      <span class="brand-name">Project X</span>
    </a>
    <div class="topbar-spacer"></div>
    <button class="icon-btn" type="button" data-theme-toggle aria-label="Switch theme">
      <span data-theme-icon="light">${icon.sun(19)}</span>
      <span data-theme-icon="dark" hidden>${icon.moon(19)}</span>
    </button>
    <a class="icon-btn" href="/help" aria-label="Help">${icon.help(19)}</a>
  </header>

  <main class="auth-page" id="main">${body}</main>
  ${footer()}
</div>
<div class="toasts" data-toasts aria-live="polite"></div>
<script type="module" src="/client.js"></script>
</body>
</html>`;
}

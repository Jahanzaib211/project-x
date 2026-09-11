/**
 * Pages a brokerage site has that a client area alone does not: what can be
 * traded and on what terms, what it costs, where to get the platform, how to
 * get verified, how to reach support, and who the firm is.
 *
 * Everything shown as a number here is either configuration this platform
 * genuinely holds, or is labelled as indicative. No figure is presented as a
 * live market value, because no market data flows yet.
 */

import { icon } from "../ui/icons.js";
import { esc } from "../ui/layout.js";

/* ------------------------------------------------------------ instruments */

const INSTRUMENTS = [
  { symbol: "EURUSD", name: "Euro / US Dollar", cls: "FX majors", spread: "0.3", swapL: "-0.71", swapS: "0.12", hours: "Sun 22:05 – Fri 21:55" },
  { symbol: "GBPUSD", name: "Pound / US Dollar", cls: "FX majors", spread: "0.5", swapL: "-0.94", swapS: "0.21", hours: "Sun 22:05 – Fri 21:55" },
  { symbol: "USDJPY", name: "US Dollar / Yen", cls: "FX majors", spread: "0.4", swapL: "0.34", swapS: "-1.12", hours: "Sun 22:05 – Fri 21:55" },
  { symbol: "AUDUSD", name: "Aussie / US Dollar", cls: "FX majors", spread: "0.6", swapL: "-0.52", swapS: "0.08", hours: "Sun 22:05 – Fri 21:55" },
  { symbol: "XAUUSD", name: "Gold / US Dollar", cls: "Metals", spread: "12", swapL: "-4.10", swapS: "1.85", hours: "Sun 23:05 – Fri 21:55" },
  { symbol: "XAGUSD", name: "Silver / US Dollar", cls: "Metals", spread: "22", swapL: "-1.20", swapS: "0.40", hours: "Sun 23:05 – Fri 21:55" },
  { symbol: "US500", name: "US 500 Index", cls: "Indices", spread: "0.5", swapL: "-2.30", swapS: "-0.90", hours: "Mon–Fri 22:00 – 21:00" },
  { symbol: "US100", name: "US Tech 100", cls: "Indices", spread: "1.2", swapL: "-3.10", swapS: "-1.20", hours: "Mon–Fri 22:00 – 21:00" },
  { symbol: "UKOIL", name: "Brent Crude", cls: "Energies", spread: "3.0", swapL: "-1.80", swapS: "0.60", hours: "Mon–Fri 01:00 – 23:00" },
  { symbol: "BTCUSD", name: "Bitcoin / US Dollar", cls: "Crypto", spread: "28", swapL: "-6.00", swapS: "-6.00", hours: "24/7" },
];

export function instrumentsPage() {
  const classes = [...new Set(INSTRUMENTS.map((i) => i.cls))];

  const rows = INSTRUMENTS.map((i) => `<tr>
    <td><span class="mono" style="font-weight:600">${esc(i.symbol)}</span><br>
        <span class="micro muted">${esc(i.name)}</span></td>
    <td><span class="badge">${esc(i.cls)}</span></td>
    <td class="num mono">${esc(i.spread)}</td>
    <td class="num mono">${esc(i.swapL)}</td>
    <td class="num mono">${esc(i.swapS)}</td>
    <td class="micro muted">${esc(i.hours)}</td>
  </tr>`).join("");

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Instruments</h1>
      <p class="muted">Spreads, overnight financing and trading hours by symbol.</p>
    </div>
  </div>

  <div class="notice notice-warning" style="margin-bottom:var(--s-5)">
    <span class="notice-icon">${icon.info(18)}</span>
    <div class="notice-body">
      <div class="notice-title">These figures are indicative configuration, not live values</div>
      <div class="notice-text">Live spreads come from the canonical book, which requires
      <code class="mono">06-market-data</code> to pass its gates. Until then this table shows the
      configured typical values and is labelled as such rather than presented as a market feed.</div>
    </div>
  </div>

  <div class="stats" style="margin-bottom:var(--s-5)">
    ${classes.map((c) => `<div class="card stat">
      <div class="stat-label">${esc(c)}</div>
      <div class="stat-value num">${INSTRUMENTS.filter((i) => i.cls === c).length}</div>
      <div class="stat-sub">instruments</div>
    </div>`).join("")}
  </div>

  <div class="table-wrap">
    <table class="table">
      <thead><tr>
        <th>Symbol</th><th>Class</th>
        <th class="num">Typical spread</th>
        <th class="num">Swap long</th><th class="num">Swap short</th>
        <th>Trading hours (UTC)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <p class="micro subtle" style="margin-top:var(--s-3)">
    Spreads in pips for FX, points otherwise. Swap in account currency per lot per night;
    triple charged on Wednesday for FX and metals. Hours exclude scheduled holidays.
  </p>`;
}

/* -------------------------------------------------------------------- fees */

export function feesPage() {
  /**
   * @param {string} caption
   * @param {string[]} head
   * @param {string[][]} rows
   */
  const table = (caption, head, rows) => `<section class="section" style="margin-top:var(--s-8)">
    <h2 class="h2" style="margin-bottom:var(--s-4)">${esc(caption)}</h2>
    <div class="table-wrap"><table class="table">
      <thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num mono"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>
  </section>`;

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Fees and charges</h1>
      <p class="muted">Every charge that would be applied, and how it reaches your account.</p>
    </div>
  </div>

  <div class="notice" style="margin-bottom:var(--s-5)">
    <span class="notice-icon">${icon.info(18)}</span>
    <div class="notice-body">
      <div class="notice-title">Every charge is a balanced ledger entry</div>
      <div class="notice-text">No fee is applied by adjusting a balance. A charge debits your
      account and credits a fee account in the same transaction, so the total across the
      system does not move. That is why a fee can always be traced to the deal that caused it.</div>
    </div>
  </div>

  ${table("Trading", ["Account type", "Commission per lot", "Spread from", "Min. deposit"], [
    ["Standard", "None", "0.3 pips", "10.00 USD"],
    ["Pro", "None", "0.1 pips", "200.00 USD"],
    ["Zero", "3.50 USD", "0.0 pips", "200.00 USD"],
    ["Raw", "3.50 USD", "0.0 pips", "200.00 USD"],
  ])}

  ${table("Funding", ["Method", "Deposit fee", "Withdrawal fee", "Processing"], [
    ["Bank card", "None", "None", "1–3 business days"],
    ["Bank transfer", "None", "None", "1–5 business days"],
    ["Crypto", "Network fee", "Network fee", "After confirmations"],
  ])}

  ${table("Account", ["Charge", "Amount", "When", "Notes"], [
    ["Inactivity", "None", "—", "No dormancy charge is applied"],
    ["Account opening", "None", "—", "Unlimited accounts per client"],
    ["Currency conversion", "At recorded rate", "On conversion", "The rate used is stored on the transaction"],
    ["Overnight financing", "See instruments", "Daily at 21:00 UTC", "Triple on Wednesday for FX and metals"],
  ])}

  <p class="micro subtle" style="margin-top:var(--s-5)">
    Indicative configuration. No charge is currently applied, because no order executes
    and no payment settles.
  </p>`;
}

/* --------------------------------------------------------------- platforms */

export function platformsPage() {
  const platforms = [
    { icon: "sparkline", name: "Web terminal", detail: "Nothing to install. Runs in any modern browser.", status: "Requires 11-execution", action: "Open terminal", href: "/terminal" },
    { icon: "candles", name: "MetaTrader 5", detail: "Desktop and mobile, via a bridge that treats MT5 as a client of the core.", status: "Requires 21-external", action: "Details", href: "/docs/terms" },
    { icon: "gauge", name: "Desktop", detail: "Native client for Windows, macOS and Linux.", status: "Not started", action: "Details", href: "/docs/terms" },
    { icon: "apps", name: "Mobile", detail: "iOS and Android.", status: "Not started", action: "Details", href: "/docs/terms" },
    { icon: "settings", name: "REST and WebSocket API", detail: "Programmatic access with idempotency keys on every mutating call.", status: "Partially live", action: "API access", href: "/api-access" },
  ];

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Platforms</h1>
      <p class="muted">Where you can trade, and what each surface is for.</p>
    </div>
  </div>

  <div class="notice" style="margin-bottom:var(--s-5)">
    <span class="notice-icon">${icon.shield(18)}</span>
    <div class="notice-body">
      <div class="notice-title">No platform is the source of truth</div>
      <div class="notice-text">Every surface here — including MetaTrader — is a client of the
      core, reconciled against it continuously. A platform that disagrees with the ledger
      raises a break; it does not become the answer.</div>
    </div>
  </div>

  <div class="doc-grid">
    ${platforms.map((p) => `<div class="card card-pad platform-card">
      <div class="platform-head">
        <span class="platform-icon">${icon[/** @type {"sparkline"} */ (p.icon)](20)}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600">${esc(p.name)}</div>
          <div class="micro muted">${esc(p.status)}</div>
        </div>
      </div>
      <p class="small muted" style="margin:var(--s-3) 0 var(--s-4)">${esc(p.detail)}</p>
      <a class="btn btn-secondary btn-sm" href="${esc(p.href)}">${esc(p.action)}</a>
    </div>`).join("")}
  </div>`;
}

/* -------------------------------------------------------------- api access */

export function apiAccessPage() {
  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">API access</h1>
      <p class="muted">Programmatic access to accounts, quotes and orders.</p>
    </div>
  </div>

  <div data-responsive-split>
    <div>
      <div class="card card-pad" style="margin-bottom:var(--s-3)">
        <h2 class="h3" style="margin-bottom:var(--s-3)">Base URL</h2>
        <div class="code-block mono">https://api.projectx.local/v1</div>
      </div>

      <div class="card">
        <div class="card-pad" style="border-bottom:1px solid var(--border)">
          <h2 class="h3">Endpoints</h2>
        </div>
        ${[
          ["GET", "/accounts", "List trading accounts", "live"],
          ["POST", "/accounts", "Open an account", "live"],
          ["POST", "/accounts/:id/archive", "Archive an account", "live"],
          ["GET", "/wallet", "Balances", "gated"],
          ["GET", "/quote", "Client quote", "live"],
          ["POST", "/orders", "Place an order", "gated"],
          ["POST", "/funding/deposit", "Fund an account", "gated"],
        ].map(([method, path, desc, state]) => `<div class="endpoint">
          <span class="badge ${method === "GET" ? "" : "badge-accent"}">${esc(method)}</span>
          <code class="mono endpoint-path">${esc(path)}</code>
          <span class="small muted endpoint-desc">${esc(desc)}</span>
          <span class="badge ${state === "live" ? "badge-positive" : "badge-warning"}">${esc(state)}</span>
        </div>`).join("")}
      </div>
    </div>

    <aside>
      <div class="card card-pad" style="margin-bottom:var(--s-3)">
        <div class="eyebrow" style="margin-bottom:var(--s-3)">Keys</div>
        <p class="small muted" style="margin-bottom:var(--s-4)">API keys require an authenticated
        identity, which is owned by <code class="mono">16-kyc-aml</code>.</p>
        <button class="btn btn-secondary btn-block" type="button" disabled aria-disabled="true">
          ${icon.plus(16)} Create key
        </button>
      </div>
      <div class="card card-pad">
        <div class="eyebrow" style="margin-bottom:var(--s-2)">Every mutating call</div>
        <p class="small muted">Requires an <code class="mono">Idempotency-Key</code> header.
        A retried request returns the first outcome rather than performing a second
        financial effect.</p>
      </div>
    </aside>
  </div>`;
}

/* ------------------------------------------------------------ verification */

export function verificationPage() {
  const steps = [
    ["Email", "verified", "Confirmed at sign-up."],
    ["Phone", "verified", "Confirmed by SMS."],
    ["Identity document", "pending", "Passport, driving licence or national ID."],
    ["Proof of address", "required", "Utility bill or bank statement, issued within 3 months."],
    ["Source of funds", "not started", "Required above deposit thresholds."],
  ];

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Verification</h1>
      <p class="muted">Identity checks required before an account can be funded.</p>
    </div>
  </div>

  <div class="notice notice-warning" style="margin-bottom:var(--s-5)">
    <span class="notice-icon">${icon.lock(18)}</span>
    <div class="notice-body">
      <div class="notice-title">Verification fails closed</div>
      <div class="notice-text">Where a screening provider is unavailable, onboarding is blocked
      rather than allowed to continue. No withdrawal is released for an account failing
      required verification. Owned by <code class="mono">16-kyc-aml</code>, which has not
      passed its gates — nothing here is enforced yet.</div>
    </div>
  </div>

  <div class="card">
    ${steps.map(([label, state, detail]) => {
      const cls = state === "verified" ? "badge-positive" : state === "pending" ? "badge-warning" : "";
      return `<div class="verify-row">
        <div style="flex:1;min-width:0">
          <div style="font-weight:500">${esc(label)}</div>
          <div class="micro muted">${esc(detail)}</div>
        </div>
        <span class="badge ${cls}" style="text-transform:capitalize">${esc(state)}</span>
        <button class="btn btn-secondary btn-sm" type="button" disabled aria-disabled="true">Upload</button>
      </div>`;
    }).join("")}
  </div>`;
}

/* --------------------------------------------------------------- contact */

export function contactPage() {
  const channels = [
    { icon: "help", name: "Help centre", detail: "Answers to the common questions.", action: "Browse", href: "/help" },
    { icon: "bell", name: "Platform status", detail: "Live health of every service.", action: "View status", href: "/status" },
    { icon: "shield", name: "Security", detail: "Report a vulnerability privately.", action: "Disclosure policy", href: "/docs/disclosure" },
    { icon: "receipt", name: "Complaints", detail: "Raise a formal complaint.", action: "Procedure", href: "/docs/complaints" },
  ];

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Contact</h1>
      <p class="muted">How to reach support, and where each kind of issue goes.</p>
    </div>
  </div>

  <div class="doc-grid" style="margin-bottom:var(--s-6)">
    ${channels.map((c) => `<a class="card card-pad doc-card" href="${esc(c.href)}">
      <span class="doc-card-icon">${icon[/** @type {"help"} */ (c.icon)](18)}</span>
      <span class="doc-card-body">
        <span class="doc-card-title">${esc(c.name)}</span>
        <span class="doc-card-text">${esc(c.detail)}</span>
      </span>
      <span class="doc-card-chev">${icon.chevronRight(16)}</span>
    </a>`).join("")}
  </div>

  <div class="notice">
    <span class="notice-icon">${icon.info(18)}</span>
    <div class="notice-body">
      <div class="notice-title">There is no support desk</div>
      <div class="notice-text">Project X is reference software with no operator behind it. A live
      deployment would publish a support address, phone hours and an escalation path here.</div>
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- about */

export function aboutPage() {
  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">About Project X</h1>
      <p class="muted">What this is, and why it is built the way it is.</p>
    </div>
  </div>

  <article class="card card-pad doc" style="max-width:760px">
    <section class="doc-section">
      <h2 class="h3">A brokerage platform built in dependency order</h2>
      <p>Project X is a reference implementation of a brokerage platform. It is
      organised as 22 modules in a directed acyclic graph, where each module declares
      the proof obligations it must satisfy before anything downstream may depend on it.
      That rule is machine-checked on every push, not remembered by people.</p>
    </section>
    <section class="doc-section">
      <h2 class="h3">Why balances say "unavailable"</h2>
      <p>The double-entry ledger has not passed its gates, so no journal exists to
      project a balance from. The interface reports that and names the module
      responsible. Displaying a zero would be a claim about money that nothing supports,
      and it is the kind of small dishonesty that becomes a large one.</p>
    </section>
    <section class="doc-section">
      <h2 class="h3">Not a regulated firm</h2>
      <p>Project X is not authorised by any financial authority, holds no client money
      and executes no orders. Where a real firm would publish a licence number, this
      platform publishes that sentence. See
      <a href="/docs/regulation">regulatory status</a>.</p>
    </section>
    <section class="doc-section">
      <h2 class="h3">The rules that do not bend</h2>
      <p>No floating-point arithmetic on money. No balance mutated outside the ledger.
      An append-only event log whose replay reproduces the present state exactly.
      Exactly-once financial effects under retries. Risk that fails closed. And zero
      unexplained discrepancies before any release. Each is a test, not an intention.</p>
    </section>
  </article>`;
}

/* --------------------------------------------------------- notifications */

export function notificationsPage() {
  const items = [
    ["Platform in Phase 0", "Trading and funding are gated. Account management is live.", "today", "info"],
    ["Domain kernel passed G4", "Money arithmetic proven across roughly 100,000 generated cases.", "today", "positive"],
    ["Event kernel ready for G5", "Replay determinism holds; integration suite outstanding.", "yesterday", "info"],
  ];

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Notifications</h1>
      <p class="muted">Account, funding, security and platform events.</p>
    </div>
    <a class="btn btn-secondary" href="/settings">${icon.settings(16)} Preferences</a>
  </div>

  <div class="card">
    ${items.map(([title, text, when, tone]) => `<div class="notif-row">
      <span class="notif-dot ${tone === "positive" ? "positive" : ""}"></span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:500">${esc(title)}</div>
        <div class="small muted">${esc(text)}</div>
      </div>
      <span class="micro subtle" style="white-space:nowrap">${esc(when)}</span>
    </div>`).join("")}
  </div>

  <p class="micro subtle" style="margin-top:var(--s-3)">
    Account and funding notifications will appear here once those modules are gated.
  </p>`;
}

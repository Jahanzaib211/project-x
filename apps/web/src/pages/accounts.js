/**
 * Accounts — the page a client lands on.
 *
 * Design notes worth stating, because they are decisions rather than defaults:
 *
 * - **Balances are the ledger's strings, or shown as unavailable — never zero.**
 *   A zero balance is a claim about money. Where the ledger supplied a figure it
 *   is rendered verbatim; where it did not, the card says why (INV-183).
 * - **Archived accounts are a peer section, not a hidden tab.** People come
 *   here to restore them, so they get the same visual weight.
 * - **The empty state does the job the page cannot.** With no accounts there is
 *   nothing to look at, so the state carries the next action instead.
 */

import { glyph, icon } from "../ui/icons.js";
import { esc } from "../ui/layout.js";

const PROMOS = [
  {
    icon: "coins",
    title: "Trading credits",
    text: "Earn credits on every closed position once execution is live.",
    href: "/rewards",
  },
  {
    icon: "sparkline",
    title: "One view for everything",
    text: "Funding, analysis and execution on a single screen.",
    href: "/terminal",
  },
  {
    icon: "gauge",
    title: "Raw spreads",
    text: "Interbank pricing with a flat per-lot commission.",
    href: "/insights",
  },
  {
    icon: "users",
    title: "Refer and earn",
    text: "Commission on every trade your referrals make.",
    href: "/referrals",
  },
];

/**
 * Switching Real/Demo is a filter change, not a reset — it must not silently
 * discard the sort order and view the person already chose.
 * @param {string} mode
 * @param {string} sort
 * @param {string} view
 */
function modeHref(mode, sort, view) {
  const params = new URLSearchParams({ mode });
  if (sort && sort !== "newest") params.set("sort", sort);
  if (view && view !== "list") params.set("view", view);
  return `/?${params}`;
}

const SORTS = {
  newest: "Newest first",
  oldest: "Oldest first",
  number: "Account number",
  type: "Account type",
};

function promos() {
  const cards = PROMOS.map(
    (p) => `<a class="promo" href="${esc(p.href)}">
      <span class="promo-art">${glyph(p.icon, 20)}</span>
      <span class="promo-body">
        <span class="promo-title">${esc(p.title)}</span>
        <span class="promo-text">${esc(p.text)}</span>
      </span>
    </a>`,
  ).join("");
  return `<section class="promos" aria-label="Announcements">
    <div class="promo-track" data-promo-track>${cards}</div>
  </section>`;
}

/**
 * @param {import("../types.js").Account} account
 * @param {boolean} archived
 */
function accountCard(account, archived) {
  const archivedOn = account.archivedAt
    ? new Date(account.archivedAt).toLocaleString("en-GB", {
        day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false,
      })
    : null;

  const hasFigure = typeof account.balance === "string";
  const figure = archived
    ? `<div class="account-balance unavailable">${
         hasFigure ? `<span class="num" data-balance>${esc(account.balance ?? "")}</span> <span class="small">${esc(account.currency)}</span>` : "Balance unavailable"
       }</div>
       <div class="small muted">${
         archivedOn ? `Archived on ${esc(archivedOn)}` : "Archived"
       }</div>`
    : hasFigure
      ? `<div class="account-balance"><span class="num" data-balance>${esc(account.balance ?? "")}</span> <span class="small muted">${esc(account.currency)}</span></div>
         <div class="small muted">Equity <span class="num" data-equity>${esc(account.equity ?? "—")}</span>${
           account.openPositions ? ` · ${account.openPositions} open position${account.openPositions === 1 ? "" : "s"}` : ""
         }</div>`
      : `<div class="account-balance unavailable">Balance unavailable</div>
         <div class="small muted">${esc(account.balanceUnavailableReason ?? "")}</div>`;

  const actions = archived
    ? `<button class="btn btn-secondary btn-sm" type="button" data-restore="${esc(account.accountNumber)}">
         ${icon.restore(16)} Restore
       </button>
       <a class="btn btn-secondary btn-sm" href="/statements/${esc(account.accountNumber)}">
         ${icon.download(16)} Statements
       </a>`
    : `<a class="btn btn-secondary btn-sm" href="/deposit?account=${esc(account.accountNumber)}">
         ${icon.arrowDownCircle(16)} Deposit
       </a>
       <a class="btn btn-primary btn-sm" href="/terminal?account=${esc(account.accountNumber)}">Trade</a>
       <div class="has-menu">
         <button class="icon-btn" type="button" data-menu="acct-${esc(account.accountNumber)}"
                 aria-expanded="false" aria-haspopup="true" aria-label="More actions">
           ${icon.more(18)}
         </button>
         <div class="menu" data-menu-panel="acct-${esc(account.accountNumber)}" hidden>
           <a class="menu-item" href="/transfer?from=${esc(account.accountNumber)}">${icon.transfer(16)} Transfer</a>
           <a class="menu-item" href="/statements/${esc(account.accountNumber)}">${icon.receipt(16)} Statements</a>
           <button class="menu-item" type="button" data-copy="${esc(account.accountNumber)}">${icon.copy(16)} Copy number</button>
           ${account.mode === "demo" ? `<button class="menu-item" type="button" data-demo-reset="${esc(account.accountNumber)}">${icon.restore(16)} Reset demo balance</button>` : ""}
           <div class="menu-sep"></div>
           <button class="menu-item" type="button" data-archive="${esc(account.accountNumber)}">${icon.archive(16)} Archive account</button>
         </div>
       </div>`;

  return `<article class="card account" data-account="${esc(account.accountNumber)}" data-mode="${esc(account.mode)}">
    <div class="account-main">
      <div class="account-meta">
        <span class="badge">${esc(account.platform)}</span>
        <span class="badge badge-type" data-type="${esc(account.accountType)}">${esc(account.accountType)}</span>
        ${account.mode === "demo" ? '<span class="badge badge-accent">Demo</span>' : ""}
        <span class="account-id">#${esc(account.accountNumber)}</span>
        <span class="account-nick">${esc(account.nickname)}</span>
      </div>
      <div class="account-figure"><div>${figure}</div></div>
    </div>
    <div class="account-actions">${actions}</div>
  </article>`;
}

/** @param {string} mode */
function emptyState(mode) {
  return `<div class="card empty">
    <div class="empty-icon">${icon.candles(22)}</div>
    <h3 class="h3">No active ${esc(mode)} accounts</h3>
    <p>${mode === "demo"
      ? "A demo account is funded with 10,000.00 USD of demo capital and trades through the same ledger, risk engine and execution path as a real one."
      : "Open an account to get started, or restore one you archived earlier."}</p>
    <button class="btn btn-primary" type="button" data-open-account>${icon.plus(16)} Open ${esc(mode)} account</button>
  </div>`;
}

/**
 * @param {{accounts: import("../types.js").Account[],
 *          archived: import("../types.js").Account[],
 *          mode: string, sort: string, view: string}} data
 */
export function accountsPage({ accounts, archived, mode, sort, view }) {
  const sortOptions = Object.entries(SORTS)
    .map(([value, label]) =>
      `<option value="${value}"${value === sort ? " selected" : ""}>${esc(label)}</option>`)
    .join("");

  const list = accounts.length
    ? `<div class="${view === "grid" ? "accounts-grid" : ""}" data-account-list>
         ${accounts.map((a) => accountCard(a, false)).join("")}
       </div>`
    : emptyState(mode);

  const archivedSection = archived.length
    ? `<section class="section" data-archived-section>
        <div class="section-head">
          <h2 class="h2 grow">Archived accounts</h2>
          <button class="btn btn-ghost btn-sm" type="button" data-toggle-archived aria-expanded="true">
            <span data-archived-label>Hide accounts</span>
            <span class="chev">${icon.chevronDown(16)}</span>
          </button>
        </div>
        <div data-archived-list>
          ${archived.map((a) => accountCard(a, true)).join("")}
        </div>
      </section>`
    : "";

  return `${promos()}

  <div class="page-head">
    <div class="grow">
      <h1 class="h1">My accounts</h1>
      <p class="muted">Open, fund and manage your trading accounts.</p>
    </div>
    <button class="btn btn-primary" type="button" data-open-account>${icon.plus(16)} Open account</button>
  </div>

  <div class="section-head">
    <div class="segmented grow" role="tablist" aria-label="Account mode" style="flex:none">
      <a role="tab" href="${modeHref("real", sort, view)}" aria-selected="${mode === "real"}">Real</a>
      <a role="tab" href="${modeHref("demo", sort, view)}" aria-selected="${mode === "demo"}">Demo</a>
    </div>
    <div class="grow"></div>
    <label class="sr-only" for="sort">Sort accounts</label>
    <select class="select" id="sort" data-sort style="width:auto">${sortOptions}</select>
    <div class="viewtoggle" role="group" aria-label="View">
      <button type="button" data-view="list" aria-pressed="${view === "list"}" aria-label="List view">${icon.rows(18)}</button>
      <button type="button" data-view="grid" aria-pressed="${view === "grid"}" aria-label="Grid view">${icon.grid(18)}</button>
    </div>
  </div>

  ${list}
  ${archivedSection}`;
}

/**
 * The open-account dialog.
 *
 * The mode defaults to the tab the person is looking at. Defaulting to "real"
 * from the Demo tab created an account that then appeared on the other tab —
 * which reads, correctly, as the account having vanished.
 *
 * @param {{types: Record<string, any>, leverages: number[], currencies: string[], platforms: string[]}} meta
 * @param {"real"|"demo"} [mode]
 */
export function openAccountModal(meta, mode = "real") {
  const types = Object.entries(meta.types)
    .map(([key, t], i) => `<label class="choice">
      <input type="radio" name="accountType" value="${esc(key)}"${i === 0 ? " checked" : ""}>
      <span class="choice-body">
        <span class="choice-title">${esc(t.label)}</span>
        <span class="choice-desc">${esc(t.description)}</span>
        <span class="choice-meta">
          <div><dt>Min. deposit</dt><dd>${esc(t.minDeposit)} USD</dd></div>
          <div><dt>Spread from</dt><dd>${esc(t.spreadFrom)}</dd></div>
          <div><dt>Commission</dt><dd>${esc(t.commission)}</dd></div>
        </span>
      </span>
    </label>`).join("");

  /**
   * @param {string|number} v
   * @param {boolean} [sel]
   */
  const opt = (v, sel = false) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(v)}</option>`;

  return `<div class="modal-backdrop" data-modal="open-account" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="open-account-title">
      <form data-open-account-form>
        <div class="modal-head">
          <div class="grow">
            <h2 class="h2" id="open-account-title">Open an account</h2>
            <p class="small muted">You can change the nickname and leverage later.</p>
          </div>
          <button class="icon-btn" type="button" data-close-modal aria-label="Close">${icon.close(18)}</button>
        </div>

        <div class="modal-body">
          <div class="field">
            <span class="label">Account type</span>
            <div class="choice-grid">${types}</div>
          </div>

          <div class="field">
            <span class="label">Mode</span>
            <div class="segmented" role="group">
              <button type="button" data-mode-pick="real" aria-selected="${mode === "real"}">Real</button>
              <button type="button" data-mode-pick="demo" aria-selected="${mode === "demo"}">Demo</button>
            </div>
            <input type="hidden" name="mode" value="${esc(mode)}">
            <span class="hint" data-mode-hint>${mode === "demo"
              ? "Funded with 10,000.00 USD of demo capital on opening. Trades settle through the real ledger; only the money is not real."
              : "Opens unfunded. Real deposits wait on 17-payments; demo capital is never issued to a real account."}</span>
          </div>

          <div style="display:grid;gap:var(--s-4);grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
            <label class="field">
              <span class="label">Platform</span>
              <select class="select" name="platform">${meta.platforms.map((p) => opt(p, p === "MT5")).join("")}</select>
            </label>
            <label class="field">
              <span class="label">Currency</span>
              <select class="select" name="currency">${meta.currencies.map((c) => opt(c, c === "USD")).join("")}</select>
            </label>
            <label class="field">
              <span class="label">Leverage</span>
              <select class="select" name="leverage">${meta.leverages.map((l) => `<option value="${l}"${l === 200 ? " selected" : ""}>1:${l}</option>`).join("")}</select>
            </label>
          </div>

          <label class="field">
            <span class="label">Nickname <span class="muted" style="font-weight:400">(optional)</span></span>
            <input class="input" name="nickname" maxlength="40" placeholder="e.g. Swing trading" autocomplete="off">
            <span class="hint">Helps you tell accounts apart. Visible only to you.</span>
          </label>

          <div class="notice">
            <span class="notice-icon">${icon.info(18)}</span>
            <div class="notice-body">
              <div class="notice-title">One account, one number</div>
              <div class="notice-text">The number is issued by the ledger, and the same account is
              what the terminal, the deposit page and your statements refer to.</div>
            </div>
          </div>
        </div>

        <div class="modal-foot">
          <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
          <button class="btn btn-primary" type="submit" data-submit>Open account</button>
        </div>
      </form>
    </div>
  </div>`;
}

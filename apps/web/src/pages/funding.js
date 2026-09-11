/**
 * Money in, money out, and the record of both.
 *
 * Real money stops at the point where it would actually move, because
 * `17-payments` and `15-reconciliation` have not passed their gates. The
 * request is recorded as an intent and the interface says exactly what is
 * blocking it. That is a deliberate choice over a form that pretends to work.
 *
 * Demo capital is different: no payment rail is involved, the ledger issues it
 * from the demo pot, and the deposit settles immediately (INV-034). The page
 * switches between the two on the selected account's mode, so the same form
 * is honest about both.
 */

import { glyph, icon } from "../ui/icons.js";
import { esc } from "../ui/layout.js";

const METHODS = {
  demo: [
    { id: "demo", icon: "coins", name: "Demo capital", detail: "Issued from the ledger's demo pot", time: "Instant", fee: "No fee" },
  ],
  deposit: [
    { id: "card", icon: "card", name: "Bank card", detail: "Visa · Mastercard", time: "Instant", fee: "No fee" },
    { id: "bank", icon: "bank", name: "Bank transfer", detail: "SEPA · SWIFT", time: "1–3 business days", fee: "No fee" },
    { id: "crypto", icon: "bitcoin", name: "Crypto", detail: "USDT · BTC · ETH", time: "After confirmations", fee: "Network fee" },
  ],
  withdrawal: [
    { id: "card", icon: "card", name: "Bank card", detail: "Back to the funding card", time: "1–3 business days", fee: "No fee" },
    { id: "bank", icon: "bank", name: "Bank transfer", detail: "SEPA · SWIFT", time: "1–5 business days", fee: "No fee" },
    { id: "crypto", icon: "bitcoin", name: "Crypto", detail: "USDT · BTC · ETH", time: "After confirmations", fee: "Network fee" },
  ],
};

const GATE_NOTE = {
  title: "Real-money funding is not live yet",
  text: `Moving real money requires <code class="mono">15-reconciliation</code>
         and <code class="mono">17-payments</code> to pass their gates. A request on a real account is
         recorded as an intent and creates no ledger effect. Run
         <code class="mono">python3 scripts/check_gates.py 17-payments</code> to see the chain.`,
};

const DEMO_NOTE = {
  title: "Demo capital settles instantly",
  text: `The ledger draws the amount from its demo capital pot and credits the account in one
         balanced transaction. A demo account may hold up to 1,000,000.00 USD.`,
};

/** @param {boolean} demo */
function gateNotice(demo) {
  return `<div class="notice ${demo ? "" : "notice-warning"}" style="margin-bottom:var(--s-5)" data-funding-notice data-real${demo ? " hidden" : ""}>
    <span class="notice-icon">${icon.lock(18)}</span>
    <div class="notice-body">
      <div class="notice-title">${GATE_NOTE.title}</div>
      <div class="notice-text">${GATE_NOTE.text}</div>
    </div>
  </div>
  <div class="notice" style="margin-bottom:var(--s-5)" data-funding-notice data-demo${demo ? "" : " hidden"}>
    <span class="notice-icon">${icon.coins(18)}</span>
    <div class="notice-body">
      <div class="notice-title">${DEMO_NOTE.title}</div>
      <div class="notice-text">${DEMO_NOTE.text}</div>
    </div>
  </div>`;
}

/**
 * @param {{id:string,icon:string,name:string,detail:string,time:string,fee:string}[]} methods
 */
function methodChoices(methods) {
  return methods
    .map(
      (m, i) => `<label class="choice">
      <input type="radio" name="method" value="${esc(m.id)}"${i === 0 ? " checked" : ""}>
      <span class="choice-body">
        <span class="choice-title">
          <span style="display:flex;align-items:center;gap:var(--s-2)">${glyph(m.icon, 18)} ${esc(m.name)}</span>
        </span>
        <span class="choice-desc">${esc(m.detail)}</span>
        <span class="choice-meta">
          <div><dt>Processing</dt><dd>${esc(m.time)}</dd></div>
          <div><dt>Fee</dt><dd>${esc(m.fee)}</dd></div>
        </span>
      </span>
    </label>`,
    )
    .join("");
}

/**
 * @param {import("../types.js").Account[]} accounts
 * @param {string} name
 * @param {string} label
 * @param {string} [selected]
 */
function accountSelect(accounts, name, label, selected) {
  if (!accounts.length) {
    return `<label class="field">
      <span class="label">${esc(label)}</span>
      <select class="select" name="${esc(name)}" disabled>
        <option>No active accounts</option>
      </select>
      <span class="hint">Open an account first.</span>
    </label>`;
  }
  const options = accounts
    .map(
      (a) =>
        `<option value="${esc(a.accountNumber)}" data-mode="${esc(a.mode)}"${a.accountNumber === selected ? " selected" : ""}>
          #${esc(a.accountNumber)} · ${esc(a.accountType)}${a.mode === "demo" ? " · Demo" : ""} · ${esc(a.currency)}${
            typeof a.balance === "string" ? ` · ${esc(a.balance)}` : ""
          }
        </option>`,
    )
    .join("");
  return `<label class="field">
    <span class="label">${esc(label)}</span>
    <select class="select" name="${esc(name)}" data-account-pick>${options}</select>
  </label>`;
}

/**
 * @param {{kind:"deposit"|"withdrawal", accounts:import("../types.js").Account[], selected?:string|undefined}} ctx
 */
export function fundingPage({ kind, accounts, selected }) {
  const isDeposit = kind === "deposit";
  const title = isDeposit ? "Deposit" : "Withdraw";
  const verb = isDeposit ? "Deposit" : "Withdraw";
  // Demo accounts are only *funded* here; a withdrawal from demo capital is
  // meaningless, so the withdraw page lists real accounts alone.
  const listed = isDeposit ? accounts : accounts.filter((a) => a.mode !== "demo");
  const chosen = listed.find((a) => a.accountNumber === selected) ?? listed[0];
  const demo = isDeposit && chosen?.mode === "demo";

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">${esc(title)}</h1>
      <p class="muted">${
        isDeposit
          ? "Add funds to a trading account."
          : "Withdraw to the method you funded with."
      }</p>
    </div>
  </div>

  ${gateNotice(Boolean(demo))}

  <div data-responsive-split>
    <form class="card card-pad" data-funding-form data-kind="${esc(kind)}" data-demo="${demo ? "true" : "false"}">
      ${accountSelect(listed, isDeposit ? "toAccount" : "fromAccount",
        isDeposit ? "Deposit to" : "Withdraw from", chosen?.accountNumber)}

      <div class="field" data-methods data-real${demo ? " hidden" : ""}>
        <span class="label">Method</span>
        <div class="choice-grid">${methodChoices(METHODS[kind])}</div>
      </div>
      ${isDeposit ? `<div class="field" data-methods data-demo${demo ? "" : " hidden"}>
        <span class="label">Method</span>
        <div class="choice-grid">${methodChoices(METHODS.demo).replace('name="method"', 'name="demoMethod"')}</div>
        <div class="segmented" role="group" aria-label="Preset amounts" style="margin-top:var(--s-3)">
          ${["1000.00", "10000.00", "100000.00"].map((v) => `<button type="button" data-preset="${v}">${v.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}</button>`).join("")}
        </div>
      </div>` : ""}

      <label class="field">
        <span class="label">Amount</span>
        <span class="input-affix">
          <input class="input num" name="amount" inputmode="decimal" placeholder="0.00"
                 autocomplete="off" data-money-input>
          <span class="affix">USD</span>
        </span>
        <span class="hint" data-amount-hint>Enter an exact amount. Money is handled as a decimal
        string end to end and never as a floating-point number.</span>
      </label>

      <button class="btn btn-primary btn-lg btn-block" type="submit" data-funding-submit${
        listed.length ? "" : " disabled"
      }>${demo ? "Add demo capital" : esc(verb)}</button>
      <p class="hint" data-funding-result role="status" aria-live="polite" style="margin-top:var(--s-3)"></p>
    </form>

    <aside style="display:grid;gap:var(--s-3)">
      <div class="card card-pad">
        <div class="eyebrow" style="margin-bottom:var(--s-3)">Summary</div>
        <dl style="display:grid;gap:var(--s-2);font-size:13px">
          <div style="display:flex;justify-content:space-between"><dt class="muted">Amount</dt><dd class="num" data-summary-amount>—</dd></div>
          <div style="display:flex;justify-content:space-between"><dt class="muted">Fee</dt><dd class="num" data-summary-fee>—</dd></div>
          <div style="display:flex;justify-content:space-between;padding-top:var(--s-2);border-top:1px solid var(--border)">
            <dt style="font-weight:600">Total</dt><dd class="num" style="font-weight:600" data-summary-total>—</dd>
          </div>
        </dl>
      </div>
      <div class="card card-pad">
        <div class="eyebrow" style="margin-bottom:var(--s-2)">Before you ${esc(verb.toLowerCase())}</div>
        <ul style="display:grid;gap:var(--s-2);font-size:12.5px;color:var(--text-muted)">
          <li>${isDeposit
            ? "Funds must come from an account in your own name."
            : "Withdrawals return to the method you funded with, in the same proportion."}</li>
          <li>${isDeposit
            ? "Deposits are credited once the ledger records them, not when the provider confirms."
            : "Identity verification must be complete before a withdrawal is released."}</li>
        </ul>
      </div>
    </aside>
  </div>`;
}

/**
 * @param {{accounts:import("../types.js").Account[], from?:string|undefined}} ctx
 */
export function transferPage({ accounts, from }) {
  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Transfer</h1>
      <p class="muted">Move funds between your own accounts.</p>
    </div>
  </div>

  ${gateNotice(false)}

  <form class="card card-pad" data-funding-form data-kind="transfer" style="max-width:560px">
    ${accountSelect(accounts, "fromAccount", "From", from)}
    <div style="display:flex;justify-content:center;margin:calc(var(--s-2) * -1) 0 var(--s-2)">
      <span class="icon-btn" aria-hidden="true">${icon.transfer(18)}</span>
    </div>
    ${accountSelect(accounts, "toAccount", "To")}

    <label class="field">
      <span class="label">Amount</span>
      <span class="input-affix">
        <input class="input num" name="amount" inputmode="decimal" placeholder="0.00"
               autocomplete="off" data-money-input>
        <span class="affix">USD</span>
      </span>
      <span class="hint">Internal transfers settle as a single balanced ledger transaction —
      one debit, one credit, never a balance edit.</span>
    </label>

    <button class="btn btn-primary btn-lg btn-block" type="submit"${
      accounts.length > 1 ? "" : " disabled"
    }>Transfer</button>
    ${accounts.length > 1 ? "" : '<p class="hint" style="margin-top:var(--s-2)">You need at least two active accounts to transfer.</p>'}
  </form>`;
}

/**
 * @param {{history:import("../types.js").FundingIntent[]}} ctx
 */
export function transactionsPage({ history }) {
  if (!history.length) {
    return `<div class="page-head">
      <div class="grow">
        <h1 class="h1">Transaction history</h1>
        <p class="muted">Every deposit, withdrawal and transfer.</p>
      </div>
    </div>
    <div class="card empty">
      <div class="empty-icon">${icon.receipt(22)}</div>
      <h3 class="h3">No transactions yet</h3>
      <p>Once funding is live, every movement appears here with the ledger
      transaction that produced it.</p>
      <a class="btn btn-primary" href="/deposit">${icon.arrowDownCircle(16)} Make a deposit</a>
    </div>`;
  }

  const rows = history
    .map((t) => {
      const when = new Date(t.createdAt).toLocaleString("en-GB", {
        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
      });
      const badge = t.status === "blocked_by_gate"
        ? '<span class="badge badge-warning">Blocked by gate</span>'
        : t.status === "settled"
          ? '<span class="badge badge-positive">Settled</span>'
          : `<span class="badge">${esc(t.status)}</span>`;
      const account = t.toAccount ?? t.fromAccount;
      return `<tr>
        <td class="mono">${esc(when)}</td>
        <td style="text-transform:capitalize">${esc(t.kind)}</td>
        <td>${esc(t.method)}</td>
        <td class="mono">${account ? `#${esc(account)}` : "—"}</td>
        <td class="num mono">${esc(t.amount)} ${esc(t.currency)}</td>
        <td>${badge}</td>
      </tr>`;
    })
    .join("");

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Transaction history</h1>
      <p class="muted">Every deposit, withdrawal and transfer.</p>
    </div>
  </div>

  <div class="notice" style="margin-bottom:var(--s-4)">
    <span class="notice-icon">${icon.info(18)}</span>
    <div class="notice-body">
      <div class="notice-title">Settled rows are ledger transactions; blocked rows are intents</div>
      <div class="notice-text">A demo deposit settles in the ledger the moment it is made. A real-money
      request is held as an intent until the payments module passes its gates.</div>
    </div>
  </div>

  <div class="table-wrap">
    <table class="table">
      <thead><tr>
        <th>Date</th><th>Type</th><th>Method</th><th>Account</th>
        <th class="num">Amount</th><th>Status</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/**
 * @param {{crypto?: boolean}} ctx
 */
export function walletPage({ crypto = false } = {}) {
  const title = crypto ? "Crypto wallet" : "Funding wallet";
  const blurb = crypto
    ? "Hold and convert crypto before funding a trading account."
    : "A single balance you can move into any trading account instantly.";

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">${esc(title)}</h1>
      <p class="muted">${esc(blurb)}</p>
    </div>
  </div>

  <div class="stats" style="margin-bottom:var(--s-5)">
    <div class="card stat">
      <div class="stat-label">Available</div>
      <div class="stat-value na">Unavailable</div>
      <div class="stat-sub">Requires 03-ledger</div>
    </div>
    <div class="card stat">
      <div class="stat-label">Pending in</div>
      <div class="stat-value na">Unavailable</div>
      <div class="stat-sub">Requires 17-payments</div>
    </div>
    <div class="card stat">
      <div class="stat-label">Reserved</div>
      <div class="stat-value na">Unavailable</div>
      <div class="stat-sub">Requires 04-account</div>
    </div>
  </div>

  <div class="notice notice-warning">
    <span class="notice-icon">${icon.lock(18)}</span>
    <div class="notice-body">
      <div class="notice-title">No balance is shown because none exists</div>
      <div class="notice-text">The wallet is a projection over the ledger journal.
      Until <code class="mono">03-ledger</code> passes its gates there is no journal to
      project, so the interface reports the figure as unavailable rather than showing
      zero — zero would be a claim about money.</div>
    </div>
  </div>`;
}

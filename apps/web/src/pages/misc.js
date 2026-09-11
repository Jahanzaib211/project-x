/**
 * The remaining client-area pages.
 *
 * Each one is built to the same rule as the rest: show what is real, say what
 * is not, and never fill a figure with a plausible-looking number.
 */

import { icon } from "../ui/icons.js";
import { esc } from "../ui/layout.js";

/** @param {{title:string, blurb:string, module:string, what:string[]}} ctx */
function gatedPage({ title, blurb, module: mod, what }) {
  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">${esc(title)}</h1>
      <p class="muted">${esc(blurb)}</p>
    </div>
  </div>

  <div class="card empty">
    <div class="empty-icon">${icon.lock(22)}</div>
    <h3 class="h3">Waiting on <span class="mono">${esc(mod)}</span></h3>
    <p>This page has nothing truthful to display until that module passes its
    gates. It will show real data the moment it does.</p>
    <a class="btn btn-secondary" href="/status">${icon.gauge(16)} See platform status</a>
  </div>

  <section class="section">
    <h2 class="h2" style="margin-bottom:var(--s-4)">What will be here</h2>
    <div class="stats">
      ${what.map((item) => `<div class="card card-pad">
        <div style="display:flex;gap:var(--s-3);align-items:flex-start">
          <span class="muted" style="margin-top:2px">${icon.chevronRight(16)}</span>
          <div class="small">${esc(item)}</div>
        </div>
      </div>`).join("")}
    </div>
  </section>`;
}

export const performancePage = () =>
  gatedPage({
    title: "Performance",
    blurb: "Realised and unrealised results across your accounts.",
    module: "08-pnl-margin",
    what: [
      "Equity curve per account, rebuilt from the event log rather than cached",
      "Realised P&L reconciled against ledger postings, not computed separately",
      "Unrealised P&L stamped with the exact quote and policy version used",
      "Win rate, average hold time, and drawdown by symbol",
    ],
  });

export const ordersPage = () =>
  gatedPage({
    title: "History of orders",
    blurb: "Every order, and the decision that allowed or refused it.",
    module: "10-oms",
    what: [
      "Full order lifecycle with every recorded state transition",
      "The risk decision behind each order, with the policy version",
      "Fills, partial fills and the deal each one produced",
      "Rejection reasons in plain language, not error codes",
    ],
  });

export const insightsPage = () =>
  gatedPage({
    title: "Market overview",
    blurb: "Prices, spreads and session activity.",
    module: "06-market-data",
    what: [
      "Canonical prices with an explicit freshness age on every quote",
      "Spread history by symbol and session",
      "Provider health, so a degraded feed is visible rather than silent",
      "Stale state marked as stale — never served as live",
    ],
  });

export const calendarPage = () =>
  gatedPage({
    title: "Economic calendar",
    blurb: "Scheduled releases that move the instruments you trade.",
    module: "06-market-data",
    what: [
      "Releases filtered to the symbols on your accounts",
      "Previous, forecast and actual once published",
      "Expected volatility windows around each release",
    ],
  });

export function rewardsPage() {
  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Trading credits</h1>
      <p class="muted">Credits earned on closed positions, usable against commission.</p>
    </div>
  </div>

  <div class="stats" style="margin-bottom:var(--s-5)">
    <div class="card stat">
      <div class="stat-label">Available credits</div>
      <div class="stat-value na">Unavailable</div>
      <div class="stat-sub">Requires 11-execution</div>
    </div>
    <div class="card stat">
      <div class="stat-label">Earned this month</div>
      <div class="stat-value na">Unavailable</div>
      <div class="stat-sub">Requires 11-execution</div>
    </div>
    <div class="card stat">
      <div class="stat-label">Lifetime</div>
      <div class="stat-value na">Unavailable</div>
      <div class="stat-sub">Requires 03-ledger</div>
    </div>
  </div>

  <div class="card card-pad">
    <h2 class="h2" style="margin-bottom:var(--s-3)">How credits work</h2>
    <ol style="display:grid;gap:var(--s-3);counter-reset:step">
      ${[
        "Close a position. The deal it produces is recorded in the ledger like any other.",
        "A credit is posted as its own balanced ledger transaction — credits are money, so they move the way money moves.",
        "Credits offset commission on future trades, applied at execution and recorded on the deal.",
        "Unused credits expire after 60 days, and the expiry is itself a posted transaction.",
      ].map((t, i) => `<li style="display:flex;gap:var(--s-3)">
        <span class="badge" style="flex:none">${i + 1}</span>
        <span class="small">${esc(t)}</span>
      </li>`).join("")}
    </ol>
  </div>`;
}

export function referralsPage() {
  const code = "PX-REF-4820";
  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Refer traders, earn commission</h1>
      <p class="muted">Earn a share of the commission generated by traders you refer.</p>
    </div>
  </div>

  <div class="card card-pad" style="margin-bottom:var(--s-5)">
    <div class="eyebrow" style="margin-bottom:var(--s-3)">Your referral link</div>
    <div style="display:flex;gap:var(--s-2);flex-wrap:wrap">
      <input class="input mono" readonly value="https://projectx.local/r/${code}"
             style="flex:1;min-width:240px" aria-label="Referral link">
      <button class="btn btn-primary" type="button" data-copy="https://projectx.local/r/${code}">
        ${icon.copy(16)} Copy link
      </button>
    </div>
  </div>

  <div class="stats" style="margin-bottom:var(--s-5)">
    <div class="card stat"><div class="stat-label">Referred traders</div><div class="stat-value num">0</div><div class="stat-sub">Signed up via your link</div></div>
    <div class="card stat"><div class="stat-label">Active this month</div><div class="stat-value num">0</div><div class="stat-sub">Traded at least once</div></div>
    <div class="card stat"><div class="stat-label">Commission earned</div><div class="stat-value na">Unavailable</div><div class="stat-sub">Requires 11-execution</div></div>
  </div>

  <div class="notice">
    <span class="notice-icon">${icon.info(18)}</span>
    <div class="notice-body">
      <div class="notice-title">Referral counts are real; commission is not yet</div>
      <div class="notice-text">Sign-ups are recorded by the client area, so those numbers are
      accurate. Commission depends on executed trades, which requires
      <code class="mono">11-execution</code>.</div>
    </div>
  </div>`;
}

/**
 * Profile.
 *
 * The verification panel here used to show a fabricated set of states — email
 * and phone "verified", a document "pending", an address "required" — none of
 * which anything had checked. It was the one screen in the client area that
 * invented its own contents, and it invented exactly the thing a person uses to
 * decide whether their account is ready to withdraw from.
 *
 * It now reports what is actually known. Signing in is a real fact and is shown
 * as one. Everything else is honestly `not started`, and names the module that
 * would own it.
 *
 * @param {{profile: import("../types.js").Profile & {
 *   authenticated?: boolean, emailVerified?: boolean, twoFactorEnabled?: boolean,
 *   lastLoginAt?: string|null, recoveryCodesRemaining?: number
 * }}} ctx
 */
export function profilePage({ profile }) {
  const signedIn = profile.authenticated === true;

  const rows = [
    ["Name", profile.name],
    ["Email", profile.email],
    ["Client ID", profile.clientId],
    ["Country", profile.country],
    ["Account currency", profile.baseCurrency],
    [
      signedIn ? "Registered" : "Member since",
      new Date(profile.since).toLocaleDateString("en-GB", {
        day: "numeric", month: "long", year: "numeric",
      }),
    ],
  ];

  /**
   * One verification line: what it is, where it stands, and who owns it.
   * @type {Array<[string, "done"|"not started"|"unavailable", string]>}
   */
  const checks = [
    [
      "Password sign-in",
      signedIn ? "done" : "not started",
      signedIn
        ? "You are signed in, so you hold this account's password."
        : "No session. Sign in to establish who you are.",
    ],
    [
      "Two-factor authentication",
      profile.twoFactorEnabled ? "done" : "not started",
      profile.twoFactorEnabled
        ? `Enabled, with ${profile.recoveryCodesRemaining ?? 0} recovery code${
            (profile.recoveryCodesRemaining ?? 0) === 1 ? "" : "s"
          } left.`
        : "Optional, and not enabled on this account.",
    ],
    [
      "Email address",
      "unavailable",
      "Confirming an address means sending to it, and this platform sends no email.",
    ],
    [
      "Identity document",
      "unavailable",
      "Owned by 16-kyc-aml, which has not passed its gates. No document is collected.",
    ],
    [
      "Proof of address",
      "unavailable",
      "Owned by 16-kyc-aml. Nothing is collected and nothing is checked.",
    ],
  ];

  const badge = {
    done: "badge-positive",
    "not started": "",
    unavailable: "",
  };

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Profile</h1>
      <p class="muted">Your details, and what has actually been verified.</p>
    </div>
    ${signedIn ? `<a class="btn btn-secondary btn-sm" href="/security">${icon.shield(16)} Security</a>` : ""}
  </div>

  ${signedIn ? "" : `<div class="notice notice-quiet" style="margin-bottom:var(--s-5)">
    <span class="notice-icon">${icon.info(18)}</span>
    <div class="notice-body">
      <div class="notice-title">This is the shared development identity</div>
      <div class="notice-text">You are not signed in, so these details belong to the
      identity every anonymous request is attributed to — not to you.
      <a href="/login?next=%2Fprofile">Sign in</a> to see your own.</div>
    </div>
  </div>`}

  <div data-responsive-split>
    <div class="card">
      <div class="card-pad" style="border-bottom:1px solid var(--border)">
        <h2 class="h3">Personal details</h2>
      </div>
      <dl style="display:grid">
        ${rows.map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:var(--s-4);padding:var(--s-4) var(--s-5);border-bottom:1px solid var(--border)">
          <dt class="muted">${esc(k)}</dt>
          <dd style="margin:0;font-weight:500" class="${k === "Client ID" ? "mono" : ""}">${esc(v)}</dd>
        </div>`).join("")}
      </dl>
    </div>

    <aside class="card card-pad">
      <div class="eyebrow" style="margin-bottom:var(--s-3)">Verification</div>
      <div style="display:grid;gap:var(--s-4)">
        ${checks.map(([label, state, detail]) => `<div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:var(--s-3)">
            <span class="small" style="font-weight:500">${esc(label)}</span>
            <span class="badge ${badge[state]}">${esc(state)}</span>
          </div>
          <p class="micro muted" style="margin:var(--s-1) 0 0;line-height:1.55">${esc(detail)}</p>
        </div>`).join("")}
      </div>
      <p class="hint" style="margin-top:var(--s-5)">Withdrawals would require completed
      verification, enforced by <code class="mono">16-kyc-aml</code>. That module has not
      passed its gates, and funding is blocked for that reason among others — so nothing
      here is standing between you and money that could move.</p>
    </aside>
  </div>`;
}

/** @param {{core: Record<string, string>, tradable: boolean}} ctx */
export function statusPage({ core, tradable }) {
  const services = Object.entries(core);
  const rows = services
    .map(([name, state]) => {
      const ok = state === "healthy";
      return `<tr>
        <td class="mono">${esc(name)}</td>
        <td><span class="badge ${ok ? "badge-positive" : "badge-danger"}">${esc(state)}</span></td>
      </tr>`;
    })
    .join("");

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Platform status</h1>
      <p class="muted">Live health of the services behind this interface.</p>
    </div>
  </div>

  <div class="notice ${tradable ? "" : "notice-warning"}" style="margin-bottom:var(--s-5)">
    <span class="notice-icon">${tradable ? icon.shield(18) : icon.info(18)}</span>
    <div class="notice-body">
      <div class="notice-title">${tradable ? "All core services responding" : "Degraded — the platform fails closed"}</div>
      <div class="notice-text">${
        tradable
          ? "Every Tier 0 and Tier 1 service is answering its health check."
          : "One or more core services are unreachable. Rather than serving stale or invented data, the platform refuses. This is the designed behaviour."
      }</div>
    </div>
  </div>

  <div class="table-wrap" style="margin-bottom:var(--s-6)">
    <table class="table">
      <thead><tr><th>Service</th><th>State</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="2" class="muted">No services reachable</td></tr>'}</tbody>
    </table>
  </div>

  <section class="section" style="margin-top:0">
    <h2 class="h2" style="margin-bottom:var(--s-4)">Why figures show as unavailable</h2>
    <div class="card card-pad">
      <p class="small muted" style="margin-bottom:var(--s-3)">
        Every module declares the gates it must pass before anything downstream may
        use it. Balances, P&amp;L and order history depend on modules that have not
        passed theirs, so this interface reports them as unavailable rather than
        estimating.
      </p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Module</th><th>State</th><th>Blocking</th></tr></thead>
          <tbody>
            <tr><td class="mono">01-domain-kernel</td><td><span class="badge badge-positive">Green</span></td><td class="muted">—</td></tr>
            <tr><td class="mono">02-event-kernel</td><td><span class="badge badge-warning">Ready</span></td><td class="muted">G5 integration</td></tr>
            <tr><td class="mono">03-ledger</td><td><span class="badge">Blocked</span></td><td class="muted">02-event-kernel G5</td></tr>
            <tr><td class="mono">09-risk</td><td><span class="badge">Blocked</span></td><td class="muted">Upstream chain</td></tr>
            <tr><td class="mono">11-execution</td><td><span class="badge">Blocked</span></td><td class="muted">Upstream chain</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>`;
}

/** @param {{account:string}} ctx */
export function statementsPage({ account }) {
  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Statements</h1>
      <p class="muted">Account <span class="mono">#${esc(account)}</span></p>
    </div>
  </div>
  <div class="card empty">
    <div class="empty-icon">${icon.receipt(22)}</div>
    <h3 class="h3">No statements available</h3>
    <p>A statement is generated from ledger postings. This account has none,
    because the ledger has not begun recording.</p>
    <a class="btn btn-secondary" href="/">${icon.chevronLeft(16)} Back to accounts</a>
  </div>`;
}

export function helpPage() {
  const faqs = [
    ["Why does every balance say unavailable?", "Because none exists yet. Balances are projections over the ledger journal, and 03-ledger has not passed its gates. Showing zero would be a claim about money that nothing supports."],
    ["Can I trade right now?", "No. Order execution requires 09-risk and 11-execution to pass their gates. The interface refuses rather than accepting an order it cannot honour."],
    ["Is my account real?", "Accounts created here are real records in the account registry, but they hold no funds and cannot execute orders."],
    ["What is a gate?", "A named, machine-checked proof obligation. A module cannot be used by anything downstream until it passes the gates it declares. See docs/04-gates.md."],
  ];

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Help</h1>
      <p class="muted">Common questions about what works and what does not.</p>
    </div>
  </div>
  <div class="card">
    ${faqs.map(([q, a], i) => `<details${i === 0 ? " open" : ""} style="border-bottom:1px solid var(--border)">
      <summary style="padding:var(--s-4) var(--s-5);cursor:pointer;font-weight:500;list-style:none;display:flex;justify-content:space-between;gap:var(--s-3)">
        ${esc(q)} <span class="muted">${icon.chevronDown(16)}</span>
      </summary>
      <div style="padding:0 var(--s-5) var(--s-4)" class="small muted">${esc(a)}</div>
    </details>`).join("")}
  </div>`;
}

export function notFoundPage() {
  return `<div class="card empty" style="margin-top:var(--s-16)">
    <div class="empty-icon">${icon.search(22)}</div>
    <h3 class="h3">Page not found</h3>
    <p>The page you asked for does not exist.</p>
    <a class="btn btn-primary" href="/">Back to accounts</a>
  </div>`;
}

/* -------------------------------------------------------------------------
 * Screens reachable from the profile menu and the footer.
 * These existed as links before they existed as pages; the screen test in
 * apps/web/tests/screens.test.js now fails the build on any href without a
 * route behind it.
 * ---------------------------------------------------------------------- */

/**
 * Security events, in words rather than in identifiers.
 *
 * The raw event name is kept in the database because that is what a query
 * filters on; this is what a person reads. An unknown event falls back to its
 * identifier rather than being hidden — an audit trail that silently omits what
 * it does not recognise is worse than one that shows an ugly string.
 *
 * @type {Record<string, string>}
 */
const EVENT_LABELS = {
  registered: "Account created",
  signed_in: "Signed in",
  sign_in_failed: "Failed sign-in attempt",
  locked_out: "Account locked after failed attempts",
  password_changed: "Password changed",
  password_reset_requested: "Password reset requested",
  password_reset_completed: "Password reset completed",
  two_factor_enabled: "Two-factor authentication turned on",
  two_factor_disabled: "Two-factor authentication turned off",
  email_verification_requested: "Confirmation link created",
  email_verified: "Email address confirmed",
};

/**
 * Security.
 *
 * Every control on this page used to be disabled with a note explaining that
 * authentication had not been built. They are live now, and the page is built
 * around the three questions somebody actually opens it to answer: can I change
 * my password, can I add a second factor, and where am I signed in?
 *
 * The two-factor panel is rendered but empty; `client.js` fills it from the
 * enrolment endpoint. The secret is deliberately never server-rendered into the
 * page — a secret in the initial HTML is a secret in the browser's back/forward
 * cache, in any proxy that logs bodies, and in the page source someone screen-
 * shares.
 *
 * @param {{
 *   user?: {name: string, email: string}|null,
 *   sessions?: Array<{sessionId: string, current: boolean, device: string, ip: string,
 *                     createdAt: string, lastSeenAt: string}>,
 *   twoFactorEnabled?: boolean,
 *   recoveryCodesRemaining?: number,
 *   emailVerified?: boolean,
 *   events?: Array<{event: string, detail: string|null, ip: string, device: string, at: string}>
 * }} [options]
 */
export function securityPage({
  user = null, sessions = [], twoFactorEnabled = false, recoveryCodesRemaining = 0,
  emailVerified = false, events = [],
} = {}) {
  const head = `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Security</h1>
      <p class="muted">Sign-in, two-factor authentication and active sessions.</p>
    </div>
  </div>`;

  // Signed out there is nothing here to secure, and an empty sessions table
  // would read as "you are signed in nowhere" rather than "we cannot tell".
  if (!user) {
    return `${head}
    <div class="card empty" style="max-width:520px">
      <div class="empty-icon">${icon.lock(22)}</div>
      <h3 class="h3">Sign in to manage security</h3>
      <p>Your password, second factor and active sessions belong to an account.
      Sign in and this page will show all three.</p>
      <a class="btn btn-primary" href="/login?next=%2Fsecurity">${icon.login(16)} Sign in</a>
    </div>`;
  }

  /** @param {string} iso */
  const when = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? "—"
      : date.toLocaleString("en-GB", {
          day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
        });
  };

  return `${head}

  <div data-responsive-split>
    <div>
      <!-- ---- password ---- -->
      <div class="card">
        <div class="card-pad" style="border-bottom:1px solid var(--border)">
          <h2 class="h3">Password</h2>
          <p class="small muted" style="margin-top:var(--s-1)">
            Changing your password signs out every other device.</p>
        </div>

        <form class="card-pad" method="post" action="/security" data-password-form novalidate>
          <p class="form-error" id="password-form-error" role="alert" hidden>
            <span class="form-error-icon">${icon.alert(16)}</span>
            <span data-error-text></span>
          </p>

          <div class="field">
            <label class="label" for="current-password">Current password</label>
            <input class="input" type="password" id="current-password" name="currentPassword"
                   autocomplete="current-password" required
                   aria-describedby="current-password-error">
            <p class="field-error" id="current-password-error" role="alert" hidden></p>
          </div>

          <div class="field">
            <label class="label" for="new-password">New password</label>
            <input class="input" type="password" id="new-password" name="newPassword"
                   autocomplete="new-password" required
                   aria-describedby="new-password-hint new-password-error" data-password>
            <span class="hint" id="new-password-hint">At least 10 characters, and not
            your name or email address.</span>
            <p class="field-error" id="new-password-error" role="alert" hidden></p>
          </div>

          <div class="field">
            <label class="label" for="confirm-new-password">Confirm new password</label>
            <input class="input" type="password" id="confirm-new-password" name="confirmPassword"
                   autocomplete="new-password" required
                   aria-describedby="confirm-new-password-error">
            <p class="field-error" id="confirm-new-password-error" role="alert" hidden></p>
          </div>

          <button class="btn btn-primary" type="submit" data-submit>
            <span data-submit-label>${icon.key(16)} Change password</span>
            <span data-submit-busy hidden>Changing…</span>
          </button>
        </form>
      </div>

      <!-- ---- email address ---- -->
      <div class="card" style="margin-top:var(--s-5)">
        <div class="card-pad" style="border-bottom:1px solid var(--border)">
          <h2 class="h3">Email address</h2>
          <p class="small muted" style="margin-top:var(--s-1)">
            Where account and security notices would be sent.</p>
        </div>
        <div class="setting-row">
          <div class="setting-main">
            <div class="setting-label">
              ${esc(user.email)}
              <span class="badge ${emailVerified ? "badge-positive" : ""}">${
                emailVerified ? "confirmed" : "unconfirmed"
              }</span>
            </div>
            <div class="setting-detail" data-email-detail>
              ${emailVerified
                ? "You have followed a confirmation link from this address."
                : "Nothing has confirmed that this address reaches you."}
            </div>
          </div>
          ${emailVerified ? "" : `<button class="btn btn-secondary btn-sm" type="button" data-verify-email>
            Send a link
          </button>`}
        </div>
        ${emailVerified ? "" : `<div class="card-pad" style="border-top:1px solid var(--border)">
          <p class="small muted">This platform has no email provider, so a
          confirmation link is written to an outbox rather than delivered.
          Nothing depends on confirmation — it is recorded, not enforced.</p>
        </div>`}
      </div>

      <!-- ---- two-factor ---- -->
      <div class="card" style="margin-top:var(--s-5)">
        <div class="card-pad" style="border-bottom:1px solid var(--border)">
          <h2 class="h3">Two-factor authentication</h2>
          <p class="small muted" style="margin-top:var(--s-1)">
            A six-digit code from an authenticator app, in addition to your password.</p>
        </div>

        <div class="setting-row">
          <div class="setting-main">
            <div class="setting-label" data-totp-state>
              ${twoFactorEnabled ? "Enabled" : "Not enabled"}
            </div>
            <div class="setting-detail" data-totp-detail>
              ${twoFactorEnabled
                ? `${recoveryCodesRemaining} recovery code${
                    recoveryCodesRemaining === 1 ? "" : "s"
                  } remaining.`
                : "Your password alone is enough to sign in to this account."}
            </div>
          </div>
          <button class="btn ${twoFactorEnabled ? "btn-secondary" : "btn-primary"} btn-sm"
                  type="button" data-totp-toggle
                  data-enabled="${twoFactorEnabled ? "true" : "false"}">
            ${twoFactorEnabled ? "Turn off" : "Enable"}
          </button>
        </div>

        <!-- Filled by client.js from /api/auth/totp/begin. Never server-rendered:
             a secret in the initial HTML is a secret in the bfcache. -->
        <div class="card-pad" data-totp-panel hidden></div>
      </div>
    </div>

    <!-- ---- sessions ---- -->
    <aside>
      <div class="card">
        <div class="card-pad" style="border-bottom:1px solid var(--border);display:flex;align-items:center;gap:var(--s-3)">
          <div class="grow">
            <h2 class="h3">Active sessions</h2>
            <p class="small muted" style="margin-top:var(--s-1)">Signed in on ${
              sessions.length
            } device${sessions.length === 1 ? "" : "s"}.</p>
          </div>
        </div>

        <div data-sessions>
          ${sessions.length === 0
            ? `<div class="card-pad small muted">No other sessions.</div>`
            : sessions.map((session) => `<div class="setting-row" data-session="${esc(session.sessionId)}">
                <span class="session-icon">${icon.monitor(18)}</span>
                <div class="setting-main">
                  <div class="setting-label">
                    ${esc(session.device)}
                    ${session.current ? `<span class="tag">This device</span>` : ""}
                  </div>
                  <div class="setting-detail">
                    ${esc(session.ip)} · last seen ${esc(when(session.lastSeenAt))}
                  </div>
                </div>
                ${session.current
                  ? `<a class="btn btn-secondary btn-sm" href="/signout">Sign out</a>`
                  : `<button class="btn btn-secondary btn-sm" type="button"
                             data-revoke-session="${esc(session.sessionId)}">End</button>`}
              </div>`).join("")}
        </div>

        ${sessions.length > 1 ? `<div class="card-pad" style="border-top:1px solid var(--border)">
          <button class="btn btn-secondary btn-sm btn-block" type="button" data-revoke-all>
            ${icon.logout(16)} Sign out of every other device
          </button>
        </div>` : ""}
      </div>

      <div class="card" style="margin-top:var(--s-5)">
        <div class="card-pad" style="border-bottom:1px solid var(--border)">
          <h2 class="h3">Recent activity</h2>
          <p class="small muted" style="margin-top:var(--s-1)">
            What has happened to this account, newest first.</p>
        </div>
        ${events.length === 0
          ? `<div class="card-pad small muted">Nothing recorded yet.</div>`
          : `<div>${events.slice(0, 8).map((entry) => `<div class="setting-row">
              <div class="setting-main">
                <div class="setting-label">${esc(EVENT_LABELS[entry.event] ?? entry.event)}</div>
                <div class="setting-detail">
                  ${esc(when(entry.at))} · ${esc(entry.device)}${
                    entry.detail ? ` · ${esc(entry.detail)}` : ""
                  }
                </div>
              </div>
            </div>`).join("")}</div>`}
      </div>

      <div class="notice notice-quiet" style="margin-top:var(--s-5)">
        <span class="notice-icon">${icon.info(18)}</span>
        <div class="notice-body">
          <div class="notice-title">Signing in is not identity verification</div>
          <div class="notice-text">A session proves you own this account. Verifying
          who you are belongs to <code class="mono">16-kyc-aml</code>, which has not
          passed its gates, so no document is collected and none is checked.</div>
        </div>
      </div>
    </aside>
  </div>`;
}

export function settingsPage() {
  /**
   * @param {string} label
   * @param {string} detail
   * @param {string} control
   */
  const row = (label, detail, control) =>
    `<div style="display:flex;align-items:center;gap:var(--s-4);padding:var(--s-4) var(--s-5);border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-weight:500">${esc(label)}</div>
        <div class="small muted">${esc(detail)}</div>
      </div>
      ${control}
    </div>`;

  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Settings</h1>
      <p class="muted">Appearance, language and notifications.</p>
    </div>
  </div>

  <div class="card" style="max-width:720px">
    ${row("Theme", "Follows your system setting until you choose one.",
      `<button class="btn btn-secondary btn-sm" type="button" data-theme-toggle>
         <span data-theme-icon="light">${icon.sun(16)}</span>
         <span data-theme-icon="dark" hidden>${icon.moon(16)}</span>
         Switch theme
       </button>`)}
    ${row("Sidebar", "Collapse the navigation to icons only.",
      `<button class="btn btn-secondary btn-sm" type="button" data-collapse>
         ${icon.chevronsLeft(16)} <span>Toggle</span>
       </button>`)}
    ${row("Language", "English (United Kingdom)",
      `<select class="select" style="width:auto" aria-label="Language" disabled>
         <option>English (UK)</option>
       </select>`)}
    ${row("Email notifications", "Account, funding and security events.",
      `<button class="btn btn-secondary btn-sm" type="button" disabled aria-disabled="true">Configure</button>`)}
  </div>

  <div class="notice" style="margin-top:var(--s-5);max-width:720px">
    <span class="notice-icon">${icon.info(18)}</span>
    <div class="notice-body">
      <div class="notice-title">Theme and sidebar are stored on this device</div>
      <div class="notice-text">They live in <code class="mono">localStorage</code>, not on your
      account, so they do not follow you to another browser. Preferences that
      belong to an account need an authenticated identity.</div>
    </div>
  </div>`;
}

/**
 * Sign out.
 *
 * A confirmation rather than an action, and the form posts rather than links.
 * A GET that ends a session can be triggered by anything that fetches a URL —
 * a prefetch, an image tag on another site, an over-eager link checker — and
 * the person is signed out without ever having clicked anything.
 *
 * @param {{user?: {name: string, email: string}|null}} [options]
 */
export function signOutPage({ user = null } = {}) {
  if (!user) {
    return `<div class="card empty" style="margin-top:var(--s-12);max-width:520px;margin-left:auto;margin-right:auto">
      <div class="empty-icon">${icon.logout(22)}</div>
      <h3 class="h3">You are not signed in</h3>
      <p>There is no session to end on this device.</p>
      <a class="btn btn-primary" href="/login">${icon.login(16)} Sign in</a>
    </div>`;
  }

  return `<div class="card empty" style="margin-top:var(--s-12);max-width:520px;margin-left:auto;margin-right:auto">
    <div class="empty-icon">${icon.logout(22)}</div>
    <h3 class="h3">Sign out?</h3>
    <p>You are signed in as <strong>${esc(user.name)}</strong>
    (${esc(user.email)}). Signing out ends the session on this device only —
    anywhere else you are signed in stays signed in.</p>

    <form method="post" action="/signout" style="margin-top:var(--s-5);display:flex;gap:var(--s-3);justify-content:center">
      <a class="btn btn-secondary" href="/">Stay signed in</a>
      <button class="btn btn-primary" type="submit">${icon.logout(16)} Sign out</button>
    </form>
  </div>`;
}

/**
 * Legal documents. Deliberately plain: this platform is not a licensed firm,
 * and the text says so rather than imitating the language of one.
 * @param {"terms"|"risk"|"privacy"} which
 */
export function legalPage(which) {
  const DOCS = {
    terms: {
      title: "Client agreement",
      blurb: "What this software is, and what it is not.",
      sections: [
        ["Status of this platform", "Project X is a reference implementation of a brokerage platform. It is not a licensed financial institution, holds no client funds, and executes no orders on any market. No agreement here creates a client relationship or a financial obligation."],
        ["No advice", "Nothing presented in this interface is financial, investment, tax or legal advice, and nothing here is an offer or solicitation to trade."],
        ["Accounts", "Trading accounts created in this platform are records in an account registry. They carry no balance and cannot execute orders. Balances are reported as unavailable because no ledger has recorded any."],
        ["Availability", "The platform fails closed. When a component that protects money is unavailable, requests are refused rather than served from stale or estimated data."],
      ],
    },
    risk: {
      title: "Risk disclosure",
      blurb: "The risks that would apply if this platform were live.",
      sections: [
        ["Leverage", "Trading leveraged products carries a high risk of loss. Leverage magnifies both gains and losses, and losses can exceed the amount deposited unless negative balance protection applies."],
        ["Market risk", "Prices can gap. A position may be closed at a price materially worse than the level of any stop, particularly around scheduled economic releases or when a market reopens."],
        ["Liquidation", "Positions may be closed automatically when the margin level of an account breaches policy. Liquidation is not discretionary and may occur without prior notice."],
        ["Counterparty and operational risk", "Execution depends on liquidity providers, payment providers and infrastructure, each of which can fail or degrade."],
        ["Not currently applicable", "None of the above is presently in force, because this platform executes no orders and holds no funds. It is stated so the disclosure is complete rather than added later."],
      ],
    },
    privacy: {
      title: "Privacy policy",
      blurb: "What this platform stores, and where.",
      sections: [
        ["What is stored", "Trading account metadata — platform, type, mode, nickname, currency, leverage and status — and funding requests recorded as intents. No balances, no financial values, and no identity documents."],
        ["What is not stored", "There is no authentication, so no credentials are held. No production or third-party personal data is used anywhere in this platform, including in tests and fixtures."],
        ["Local storage", "Theme and sidebar preferences are kept in your browser's local storage. They never reach the server."],
        ["Retention", "All data lives in a local development database and is destroyed with the container volume."],
      ],
    },
  };

  const doc = DOCS[which];
  return `<div class="page-head">
    <div class="grow">
      <h1 class="h1">${esc(doc.title)}</h1>
      <p class="muted">${esc(doc.blurb)}</p>
    </div>
  </div>

  <article class="card card-pad" style="max-width:760px">
    ${doc.sections.map(([heading, text], i) => `<section${i ? ' style="margin-top:var(--s-6)"' : ""}>
      <h2 class="h3" style="margin-bottom:var(--s-2)">${esc(heading)}</h2>
      <p class="muted" style="line-height:1.65">${esc(text)}</p>
    </section>`).join("")}
  </article>`;
}

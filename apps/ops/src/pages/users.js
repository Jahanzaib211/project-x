/**
 * Users — the list, and one person in full.
 *
 * The detail page is the console's sharpest surface: it can end somebody's
 * sessions, clear their lockout, suspend them, and remove the second factor
 * protecting their account. Every one of those is a real effect on a real
 * person, so each says plainly what it does before it is pressed, and each
 * leaves a row in that person's own security history naming the operator.
 */

import { ago, badge, esc, icon, kpi, table, unavailable } from "../ui/layout.js";
import { userOrderBook } from "./trading.js";

/**
 * @param {{users: any[], q: string, sort: string, error: string|null}} data
 */
export function usersPage({ users, q, sort, error }) {
  const head = `<div class="page-head">
    <div class="grow">
      <h1 class="h1">Users</h1>
      <p class="muted small">${users.length} shown${q ? ` matching “${esc(q)}”` : ""}.</p>
    </div>
  </div>`;

  if (error) return `${head}${unavailable("The user list", error)}`;

  const sorts = [
    ["recent", "Newest"],
    ["active", "Last seen"],
    ["accounts", "Most accounts"],
    ["name", "Name"],
    ["email", "Email"],
  ];

  const rows = users.map((user) => {
    const locked = user.lockedUntil && new Date(user.lockedUntil) > new Date();
    return `<tr>
      <td>
        <a class="row-link" href="/users/${esc(user.userId)}">${esc(user.name)}</a>
        <div class="micro muted truncate">${esc(user.email)}</div>
      </td>
      <td>
        ${user.status !== "active" ? badge(user.status, "danger") : ""}
        ${locked ? badge("locked", "warning") : ""}
        ${user.twoFactor ? badge("2FA", "accent") : ""}
        ${user.emailVerified ? badge("verified", "positive") : badge("unconfirmed")}
      </td>
      <td class="small muted">${esc(user.country)}</td>
      <td class="num small">${esc(user.accountCount)}</td>
      <td class="num small">${esc(user.liveSessions)}</td>
      <td class="num small muted">${esc(ago(user.lastLoginAt))}</td>
      <td class="num small muted">${esc(ago(user.createdAt))}</td>
    </tr>`;
  });

  return `${head}

  <form class="filter-bar" method="get" action="/users">
    <label class="field">
      <span class="label">Search</span>
      <input class="input" type="search" name="q" value="${esc(q)}"
             placeholder="name or email" autocomplete="off">
    </label>
    <label class="field">
      <span class="label">Sort</span>
      <select class="select" name="sort">
        ${sorts.map(([value, label]) =>
          `<option value="${esc(value)}"${value === sort ? " selected" : ""}>${esc(label)}</option>`).join("")}
      </select>
    </label>
    <button class="btn btn-primary" type="submit">Apply</button>
    ${q ? `<a class="btn" href="/users">Clear</a>` : ""}
  </form>

  <div class="card">
    ${table({
      columns: [
        { label: "Person" }, { label: "State" }, { label: "Country" },
        { label: "Accounts", align: "num" }, { label: "Sessions", align: "num" },
        { label: "Last seen", align: "num" }, { label: "Joined", align: "num" },
      ],
      rows,
      empty: q ? `Nobody matches “${q}”.` : "Nobody has registered yet.",
    })}
  </div>`;
}

/**
 * One person, in full.
 *
 * @param {{detail: any, csrf: string, error: string|null, userId: string}} data
 */
export function userDetailPage({ detail, csrf, error, userId }) {
  if (error) {
    return `<div class="page-head"><div class="grow">
      <a class="small muted" href="/users">${icon.back(12)} All users</a>
      <h1 class="h1">User</h1></div></div>
      ${unavailable("This user", error)}`;
  }

  const user = detail.user;
  const locked = user.lockedUntil && new Date(user.lockedUntil) > new Date();
  const liveSessions = detail.sessions.filter((/** @type {any} */ s) => s.live);

  /**
   * A dangerous button, with what it does written on it.
   * @param {{action: string, label: string, description: string, tone?: string, confirm: string}} options
   */
  const action = ({ action: name, label, description, tone = "", confirm }) => `
    <form method="post" action="/users/${esc(userId)}/${esc(name)}" data-confirm="${esc(confirm)}">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <div class="row">
        <div class="row-main">
          <div class="row-label">${esc(label)}</div>
          <div class="row-detail">${esc(description)}</div>
        </div>
        <button class="btn btn-sm${tone ? ` btn-${tone}` : ""}" type="submit">${esc(label)}</button>
      </div>
    </form>`;

  const sessionRows = detail.sessions.map((/** @type {any} */ s) => `<tr>
    <td class="small">${esc(s.device)}</td>
    <td class="small muted mono">${esc(s.ip)}</td>
    <td>${s.live ? badge("live", "positive") : s.revokedAt ? badge("revoked") : badge("expired")}</td>
    <td class="num small muted">${esc(ago(s.lastSeenAt))}</td>
    <td class="num small muted">${esc(ago(s.createdAt))}</td>
  </tr>`);

  const accountRows = detail.accounts.map((/** @type {any} */ a) => `<tr>
    <td class="mono small">${esc(a.accountNumber)}</td>
    <td class="small">${esc(a.nickname)}</td>
    <td class="small muted">${esc(a.accountType)} · ${esc(a.platform)}</td>
    <td>${a.mode === "demo" ? badge("demo", "accent") : badge("real", "warning")}</td>
    <td>${a.status === "active" ? badge("active", "positive") : badge("archived")}</td>
    <td class="num small muted">1:${esc(a.leverage)}</td>
    <td class="num small muted">${esc(ago(a.createdAt))}</td>
  </tr>`);

  const eventRows = detail.events.map((/** @type {any} */ e) => `<tr>
    <td class="small mono">${esc(e.event)}</td>
    <td class="small muted">${esc(e.detail ?? "—")}</td>
    <td class="small muted truncate">${esc(e.device)}</td>
    <td class="num small muted">${esc(ago(e.at))}</td>
  </tr>`);

  const mailRows = detail.mail.map((/** @type {any} */ m) => `<tr>
    <td class="small">${esc(m.subject)}</td>
    <td class="small muted mono">${esc(m.kind)}</td>
    <td>${m.deliveredAt ? badge("delivered", "positive") : badge("pending", "warning")}</td>
    <td class="num small muted">${esc(ago(m.createdAt))}</td>
  </tr>`);

  return `<div class="page-head">
    <div class="grow">
      <a class="small muted" href="/users">${icon.back(12)} All users</a>
      <h1 class="h1">${esc(user.name)}</h1>
      <p class="muted small mono">${esc(user.email)} · ${esc(user.userId)}</p>
    </div>
    <div class="btn-row">
      ${user.status !== "active" ? badge(user.status, "danger") : ""}
      ${locked ? badge("locked out", "warning") : ""}
      ${user.twoFactor ? badge("2FA on", "accent") : badge("no 2FA")}
    </div>
  </div>

  <div class="grid grid-4">
    ${kpi({ label: "Trading accounts", value: detail.accounts.length })}
    ${kpi({ label: "Live sessions", value: liveSessions.length, note: `${detail.sessions.length} total recorded` })}
    ${kpi({
      label: "Failed attempts",
      value: user.failedAttempts ?? 0,
      note: locked ? "locked until it clears" : "since the last success",
      ...(locked ? { tone: /** @type {const} */ ("warning") } : {}),
    })}
    ${kpi({ label: "Recovery codes", value: user.recoveryCodes ?? 0, note: user.twoFactor ? "remaining" : "2FA is off" })}
  </div>

  <div class="section split">
    <div class="grid" style="gap:var(--s-4)">
      <div class="card">
        <div class="card-head"><h2 class="h2 grow">Sessions</h2></div>
        ${table({
          columns: [{ label: "Device" }, { label: "Address" }, { label: "State" },
                    { label: "Last seen", align: "num" }, { label: "Started", align: "num" }],
          rows: sessionRows,
          empty: "This person has never signed in.",
        })}
      </div>

      <div class="card">
        <div class="card-head"><h2 class="h2 grow">Trading accounts</h2>
          <span class="micro muted">Balances are read from the core, not from here</span></div>
        ${table({
          columns: [{ label: "Number" }, { label: "Nickname" }, { label: "Type" }, { label: "Mode" },
                    { label: "Status" }, { label: "Leverage", align: "num" }, { label: "Opened", align: "num" }],
          rows: accountRows,
          empty: "No trading account has been opened.",
        })}
      </div>

      <!-- The order book: the ledger's own record of this person's accounts,
           valued now — positions, and every order with its outcome. -->
      ${userOrderBook(detail.tradingAccounts ?? [], detail.ledgerReachable !== false)}

      <div class="card">
        <div class="card-head"><h2 class="h2 grow">Security history</h2></div>
        <div class="scroll-y">
          ${table({
            columns: [{ label: "Event" }, { label: "Detail" }, { label: "Device" }, { label: "When", align: "num" }],
            rows: eventRows,
            empty: "Nothing recorded.",
          })}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2 class="h2 grow">Mail</h2>
          <span class="micro muted">Bodies are never shown — they carry reset links</span></div>
        ${table({
          columns: [{ label: "Subject" }, { label: "Kind" }, { label: "State" }, { label: "Queued", align: "num" }],
          rows: mailRows,
          empty: "Nothing has been queued for this address.",
        })}
      </div>
    </div>

    <div class="grid" style="gap:var(--s-4)">
      <div class="card">
        <div class="card-head"><h2 class="h2 grow">Details</h2></div>
        <div class="rows">
          ${[
            ["Country", user.country],
            ["Currency", user.baseCurrency],
            ["Email", user.emailVerified ? "confirmed" : "unconfirmed"],
            ["Joined", new Date(user.createdAt).toLocaleString("en-GB")],
            ["Last seen", user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString("en-GB") : "never"],
            ["Password set", user.passwordChangedAt ? ago(user.passwordChangedAt) : "—"],
          ].map(([label, value]) => `<div class="row">
            <span class="row-main small muted">${esc(label)}</span>
            <span class="small">${esc(value)}</span>
          </div>`).join("")}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2 class="h2 grow">Operator actions</h2></div>
        <div class="notice" style="margin:var(--s-3) var(--s-5) 0">
          <span class="notice-icon">${icon.info(14)}</span>
          <div class="notice-body">
            <div class="notice-text">Each of these is recorded in this person's own
            security history with your name on it.</div>
          </div>
        </div>
        <div class="rows" style="margin-top:var(--s-3)">
          ${action({
            action: "revoke-sessions",
            label: "End sessions",
            description: `Signs out all ${liveSessions.length} live session(s) immediately.`,
            confirm: `End every session for ${user.email}?`,
          })}
          ${locked ? action({
            action: "unlock",
            label: "Clear lockout",
            description: "Lets them try again now rather than waiting fifteen minutes.",
            confirm: `Clear the lockout on ${user.email}?`,
          }) : ""}
          ${user.twoFactor ? action({
            action: "clear-two-factor",
            label: "Remove 2FA",
            description: "Removes the second factor without their password. For somebody who has lost both their authenticator and their recovery codes.",
            tone: "danger",
            confirm: `Remove two-factor authentication from ${user.email}? This proves nothing about who asked.`,
          }) : ""}
          ${user.status === "active" ? action({
            action: "suspend",
            label: "Suspend",
            description: "Ends every session and refuses sign-in. Sign-in fails with the same message as a wrong password, so it does not confirm the account exists.",
            tone: "danger",
            confirm: `Suspend ${user.email}?`,
          }) : action({
            action: "restore",
            label: "Restore",
            description: "Allows sign-in again. They will need to sign in fresh.",
            confirm: `Restore ${user.email}?`,
          })}
        </div>
      </div>
    </div>
  </div>`;
}

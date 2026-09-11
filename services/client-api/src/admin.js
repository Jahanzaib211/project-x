/**
 * The operator surface.
 *
 * Everything an operator console needs, in one place, behind one token. The
 * console (`apps/ops`) never holds a database credential and never reaches a
 * table — it asks here, and here is where "what may an operator see and do" is
 * decided once rather than per screen.
 *
 * ## Why this is separate from the client API it lives inside
 *
 * These handlers deliberately read across every client. That is the opposite of
 * every other read in this service, where row-level security confines a request
 * to one owner's rows — so the two must not be reachable the same way:
 *
 * - **A shared secret, not a session.** No sign-in flow reaches these. A
 *   client's session, however senior the person holding it, is never an
 *   operator credential — privilege escalation by password reset is the whole
 *   attack this forecloses.
 * - **The admin pool, deliberately.** These run as the schema owner, which
 *   bypasses the policies. That is the point of an operator console and is why
 *   the gate is the token rather than a predicate.
 * - **Every mutation is recorded** in `app.security_events` against the person
 *   it affected, with the operator named. An operator action that leaves no
 *   trace is indistinguishable afterwards from the account holder doing it.
 *
 * Nothing here returns credential material. The same rule as everywhere else,
 * and it matters more here: this is the one surface that can read every row.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { adminQuery } from "./db.js";
import { describeUserAgent } from "./auth.js";
import { HttpError } from "./money.js";

/**
 * The operator token.
 *
 * Absent by default, and absence disables the whole surface rather than
 * leaving it open — a console that cannot reach its API is a visible failure,
 * an admin API with no token is an invisible one.
 */
const OPS_TOKEN = process.env.OPS_TOKEN ?? "";

/** Minimum length, so a token that is technically set is not therefore safe. */
const MIN_TOKEN_LENGTH = 24;

/**
 * Is the operator surface available at all?
 *
 * Reported at startup so the log says which of "no token configured" and "token
 * too short" applies, rather than leaving 404s to be diagnosed.
 */
export function opsStatus() {
  if (!OPS_TOKEN) return { enabled: false, reason: "OPS_TOKEN is not set" };
  if (OPS_TOKEN.length < MIN_TOKEN_LENGTH) {
    return { enabled: false, reason: `OPS_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters` };
  }
  return { enabled: true, reason: null };
}

/**
 * Authorise an operator request.
 *
 * Compared in constant time over digests, so neither the comparison nor the
 * length of the supplied value leaks anything about the real token.
 *
 * @param {import("node:http").IncomingMessage} req
 */
export function requireOperator(req) {
  const status = opsStatus();
  if (!status.enabled) {
    // 404, not 403. An operator API that announces itself to an unauthorised
    // caller has told them where to spend their time.
    throw new HttpError(404, "not_found");
  }

  const header = req.headers["x-ops-token"];
  const supplied = typeof header === "string" ? header : "";
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(OPS_TOKEN).digest();
  if (!timingSafeEqual(a, b)) throw new HttpError(404, "not_found");

  const operator = req.headers["x-ops-operator"];
  return typeof operator === "string" && operator ? operator.slice(0, 80) : "operator";
}

/**
 * Record an operator action against the person it affected.
 *
 * @param {string|null} userId
 * @param {string} event
 * @param {string} detail
 * @param {string} operator
 */
async function recordOperatorAction(userId, event, detail, operator) {
  await adminQuery(
    `INSERT INTO app.security_events (user_id, event, detail, ip, user_agent)
     VALUES ($1, $2, $3, NULL, $4)`,
    [userId, event, detail, `operator:${operator}`],
  );
}

/* ------------------------------------------------------------------ reads */

/** Counts the console's overview is built from. */
export async function overview() {
  const [users, accounts, funding, sessions, events, outbox] = await Promise.all([
    adminQuery(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS today,
             count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
             count(*) FILTER (WHERE totp_secret IS NOT NULL)::int AS with_two_factor,
             count(*) FILTER (WHERE email_verified)::int AS verified,
             count(*) FILTER (WHERE locked_until > now())::int AS locked,
             count(*) FILTER (WHERE status <> 'active')::int AS suspended
        FROM app.users`),
    adminQuery(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'active')::int AS active,
             count(*) FILTER (WHERE mode = 'demo')::int AS demo
        FROM app.accounts`),
    adminQuery(`SELECT count(*)::int AS total FROM app.funding_requests`),
    adminQuery(`
      SELECT count(*)::int AS live
        FROM app.sessions
       WHERE revoked_at IS NULL AND expires_at > now()`),
    adminQuery(`
      SELECT count(*) FILTER (WHERE at > now() - interval '24 hours')::int AS today,
             count(*) FILTER (WHERE event = 'sign_in_failed' AND at > now() - interval '24 hours')::int AS failed_today,
             count(*) FILTER (WHERE event = 'locked_out' AND at > now() - interval '24 hours')::int AS lockouts_today
        FROM app.security_events`),
    adminQuery(`
      SELECT count(*) FILTER (WHERE delivered_at IS NULL)::int AS pending,
             count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered
        FROM app.outbox`),
  ]);

  return {
    users: users.rows[0],
    accounts: accounts.rows[0],
    funding: funding.rows[0],
    sessions: sessions.rows[0],
    events: events.rows[0],
    outbox: outbox.rows[0],
  };
}

/**
 * Search users.
 *
 * Matching is on the address and the name, both case-insensitively. The search
 * term is a parameter rather than interpolated — an operator console is exactly
 * where somebody eventually pastes a customer's name containing an apostrophe.
 *
 * @param {{q?: string, limit?: number, sort?: string}} [options]
 */
export async function listUsers({ q = "", limit = 50, sort = "recent" } = {}) {
  const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
  const order = {
    recent: "u.created_at DESC",
    active: "u.last_login_at DESC NULLS LAST",
    name: "u.name ASC",
    email: "u.email ASC",
    accounts: "account_count DESC",
  }[sort] ?? "u.created_at DESC";

  const term = String(q).trim();
  const result = await adminQuery(
    `SELECT u.user_id, u.email, u.name, u.country, u.base_currency, u.status,
            u.email_verified, (u.totp_secret IS NOT NULL) AS two_factor,
            u.failed_attempts, u.locked_until, u.created_at, u.last_login_at,
            (SELECT count(*)::int FROM app.accounts a WHERE a.owner_id = u.user_id::text) AS account_count,
            (SELECT count(*)::int FROM app.sessions s
              WHERE s.user_id = u.user_id AND s.revoked_at IS NULL AND s.expires_at > now()) AS live_sessions
       FROM app.users u
      WHERE ($1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.name ILIKE '%' || $1 || '%')
      ORDER BY ${order}
      LIMIT ${bounded}`,
    [term],
  );
  return result.rows.map(presentUserRow);
}

/** @param {Record<string, any>} row */
function presentUserRow(row) {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    country: row.country,
    baseCurrency: row.base_currency,
    status: row.status,
    emailVerified: row.email_verified,
    twoFactor: row.two_factor,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until ? new Date(row.locked_until).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    accountCount: row.account_count ?? 0,
    liveSessions: row.live_sessions ?? 0,
  };
}

/**
 * Everything about one person.
 * @param {string} userId
 */
export async function userDetail(userId) {
  requireUuid(userId);

  const [user, sessions, accounts, funding, events, mail] = await Promise.all([
    adminQuery(
      `SELECT u.*, (SELECT count(*)::int FROM app.recovery_codes r WHERE r.user_id = u.user_id) AS recovery_codes
         FROM app.users u WHERE u.user_id = $1`,
      [userId],
    ),
    adminQuery(
      `SELECT session_id, created_at, last_seen_at, expires_at, revoked_at, user_agent, ip
         FROM app.sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [userId],
    ),
    adminQuery(
      `SELECT account_number, platform, account_type, mode, nickname, currency,
              leverage, status, created_at, archived_at, archived_reason
         FROM app.accounts WHERE owner_id = $1 ORDER BY created_at DESC`,
      [userId],
    ),
    adminQuery(
      `SELECT request_id, kind, method, amount_decimal, currency, status,
              blocked_reason, created_at
         FROM app.funding_requests WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [userId],
    ),
    adminQuery(
      `SELECT event, detail, ip, user_agent, at
         FROM app.security_events WHERE user_id = $1 ORDER BY at DESC LIMIT 50`,
      [userId],
    ),
    adminQuery(
      `SELECT message_id, kind, subject, created_at, delivered_at, blocked_reason
         FROM app.outbox WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [userId],
    ),
  ]);

  const row = user.rows[0];
  if (!row) throw new HttpError(404, "no such user");

  return {
    user: {
      ...presentUserRow(row),
      recoveryCodes: row.recovery_codes ?? 0,
      passwordChangedAt: row.password_changed_at
        ? new Date(row.password_changed_at).toISOString()
        : null,
    },
    sessions: sessions.rows.map((/** @type {Record<string, any>} */ s) => ({
      sessionId: s.session_id,
      createdAt: new Date(s.created_at).toISOString(),
      lastSeenAt: new Date(s.last_seen_at).toISOString(),
      expiresAt: new Date(s.expires_at).toISOString(),
      revokedAt: s.revoked_at ? new Date(s.revoked_at).toISOString() : null,
      live: !s.revoked_at && new Date(s.expires_at) > new Date(),
      device: describeUserAgent(s.user_agent),
      ip: s.ip ?? "—",
    })),
    accounts: accounts.rows.map((/** @type {Record<string, any>} */ a) => ({
      accountNumber: String(a.account_number),
      platform: a.platform,
      accountType: a.account_type,
      mode: a.mode,
      nickname: a.nickname,
      currency: a.currency,
      leverage: a.leverage,
      status: a.status,
      createdAt: new Date(a.created_at).toISOString(),
      archivedAt: a.archived_at ? new Date(a.archived_at).toISOString() : null,
      archivedReason: a.archived_reason,
      // INV-183/INV-190 bind the operator console too. No balance is invented
      // here; the console reads figures from the core like every other surface.
      balance: null,
      balanceUnavailableReason: "Read from the core, not from this table.",
    })),
    funding: funding.rows.map((/** @type {Record<string, any>} */ f) => ({
      requestId: f.request_id,
      kind: f.kind,
      method: f.method,
      amount: f.amount_decimal,
      currency: f.currency,
      status: f.status,
      blockedReason: f.blocked_reason,
      createdAt: new Date(f.created_at).toISOString(),
    })),
    events: events.rows.map((/** @type {Record<string, any>} */ e) => ({
      event: e.event,
      detail: e.detail,
      ip: e.ip ?? "—",
      device: describeUserAgent(e.user_agent),
      at: new Date(e.at).toISOString(),
    })),
    mail: mail.rows.map((/** @type {Record<string, any>} */ m) => ({
      messageId: m.message_id,
      kind: m.kind,
      subject: m.subject,
      createdAt: new Date(m.created_at).toISOString(),
      deliveredAt: m.delivered_at ? new Date(m.delivered_at).toISOString() : null,
      blockedReason: m.blocked_reason,
    })),
  };
}

/**
 * The audit trail across everybody.
 * @param {{event?: string, limit?: number}} [options]
 */
export async function auditTrail({ event = "", limit = 100 } = {}) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  const result = await adminQuery(
    `SELECT e.event, e.detail, e.ip, e.user_agent, e.at,
            e.user_id, u.email, u.name
       FROM app.security_events e
       LEFT JOIN app.users u ON u.user_id = e.user_id
      WHERE ($1 = '' OR e.event = $1)
      ORDER BY e.at DESC
      LIMIT ${bounded}`,
    [String(event).trim()],
  );
  return result.rows.map((/** @type {Record<string, any>} */ row) => ({
    event: row.event,
    detail: row.detail,
    ip: row.ip ?? "—",
    device: describeUserAgent(row.user_agent),
    at: new Date(row.at).toISOString(),
    userId: row.user_id,
    email: row.email ?? "—",
    name: row.name ?? "—",
  }));
}

/** Distinct event names, for the filter. */
export async function auditEventNames() {
  const result = await adminQuery(
    `SELECT event, count(*)::int AS n FROM app.security_events GROUP BY event ORDER BY n DESC`,
  );
  return result.rows.map((/** @type {Record<string, any>} */ r) => ({ event: r.event, count: r.n }));
}

/**
 * The mail queue.
 * @param {{state?: string, limit?: number}} [options]
 */
export async function outbox({ state = "", limit = 100 } = {}) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  const filter =
    state === "pending" ? "AND o.delivered_at IS NULL"
    : state === "delivered" ? "AND o.delivered_at IS NOT NULL"
    : "";
  const result = await adminQuery(
    `SELECT o.message_id, o.to_address, o.kind, o.subject, o.created_at,
            o.delivered_at, o.blocked_reason
       FROM app.outbox o
      WHERE true ${filter}
      ORDER BY o.created_at DESC
      LIMIT ${bounded}`,
  );
  return result.rows.map((/** @type {Record<string, any>} */ row) => ({
    messageId: row.message_id,
    to: row.to_address,
    kind: row.kind,
    subject: row.subject,
    createdAt: new Date(row.created_at).toISOString(),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    blockedReason: row.blocked_reason,
    // The body is never returned. It carries reset links, and an operator
    // console is not a place to read one out of somebody's mail.
  }));
}

/** Trading accounts across everybody. */
export async function allAccounts({ limit = 200 } = {}) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 200));
  const result = await adminQuery(
    `SELECT a.account_number, a.owner_id, a.platform, a.account_type, a.mode,
            a.nickname, a.currency, a.leverage, a.status, a.created_at,
            u.email, u.name
       FROM app.accounts a
       LEFT JOIN app.users u ON u.user_id::text = a.owner_id
      ORDER BY a.created_at DESC
      LIMIT ${bounded}`,
  );
  return result.rows.map((/** @type {Record<string, any>} */ row) => ({
    accountNumber: String(row.account_number),
    ownerId: row.owner_id,
    email: row.email ?? (row.owner_id === "dev-owner-0001" ? "(development identity)" : "—"),
    name: row.name ?? "—",
    platform: row.platform,
    accountType: row.account_type,
    mode: row.mode,
    nickname: row.nickname,
    currency: row.currency,
    leverage: row.leverage,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/**
 * What the database is actually enforcing.
 *
 * Read from the catalogue rather than from configuration, so the console shows
 * the state of the system rather than the intent of a file somebody edited.
 */
export async function isolation() {
  const [roles, tables, grants, sizes] = await Promise.all([
    adminQuery(
      `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
         FROM pg_roles WHERE rolname LIKE 'projectx%' ORDER BY rolname`,
    ),
    adminQuery(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
              (SELECT n_live_tup FROM pg_stat_user_tables t
                WHERE t.relname = c.relname AND t.schemaname = 'app') AS rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind = 'r'
        ORDER BY c.relname`,
    ),
    adminQuery(
      `SELECT grantee, table_name,
              string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privileges
         FROM information_schema.role_table_grants
        WHERE table_schema = 'app' AND grantee IN ('projectx_app','projectx_auth')
        GROUP BY grantee, table_name ORDER BY grantee, table_name`,
    ),
    adminQuery(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size,
              (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections,
              version() AS version`,
    ),
  ]);

  return {
    roles: roles.rows.map((/** @type {Record<string, any>} */ r) => ({
      role: r.rolname,
      superuser: r.rolsuper,
      bypassRls: r.rolbypassrls,
      canLogin: r.rolcanlogin,
    })),
    tables: tables.rows.map((/** @type {Record<string, any>} */ t) => ({
      table: t.relname,
      rowSecurity: t.relrowsecurity,
      forced: t.relforcerowsecurity,
      policies: t.policies,
      rows: t.rows ?? 0,
    })),
    grants: grants.rows.map((/** @type {Record<string, any>} */ g) => ({
      role: g.grantee,
      table: g.table_name,
      privileges: g.privileges,
    })),
    database: sizes.rows[0],
  };
}

/* ----------------------------------------------------------------- writes */

/** @param {string} value */
function requireUuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))) {
    throw new HttpError(400, "that is not a user identifier");
  }
  return String(value);
}

/**
 * End every session a person has.
 *
 * The operator's name goes on the audit row. "Somebody was signed out" and
 * "Rashid signed them out at 14:02 while investigating a report" are different
 * facts, and only the second is useful a week later.
 *
 * @param {string} userId
 * @param {string} operator
 */
export async function revokeAllSessions(userId, operator) {
  requireUuid(userId);
  const result = await adminQuery(
    `UPDATE app.sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  const count = result.rowCount ?? 0;
  await recordOperatorAction(
    userId, "sessions_revoked_by_operator", `${count} session(s) ended`, operator,
  );
  return { revoked: count };
}

/**
 * Clear a lockout.
 *
 * The counterpart to the automatic lock: somebody who mistyped their password
 * five times and then phoned in should not wait fifteen minutes for a machine
 * to forgive them.
 *
 * @param {string} userId
 * @param {string} operator
 */
export async function unlockUser(userId, operator) {
  requireUuid(userId);
  await adminQuery(
    `UPDATE app.users SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
    [userId],
  );
  await recordOperatorAction(userId, "unlocked_by_operator", "lockout cleared", operator);
  return { unlocked: true };
}

/**
 * Suspend or restore an account.
 *
 * Suspension is not deletion: the rows stay, the sessions stop, and sign-in
 * fails with the same message as a wrong password — an account that announces
 * it has been suspended tells an attacker they found a real one.
 *
 * @param {string} userId
 * @param {"active"|"suspended"} status
 * @param {string} operator
 */
export async function setUserStatus(userId, status, operator) {
  requireUuid(userId);
  if (status !== "active" && status !== "suspended") {
    throw new HttpError(400, "status must be 'active' or 'suspended'");
  }
  await adminQuery(`UPDATE app.users SET status = $2 WHERE user_id = $1`, [userId, status]);
  if (status === "suspended") {
    await adminQuery(
      `UPDATE app.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }
  await recordOperatorAction(
    userId,
    status === "suspended" ? "suspended_by_operator" : "restored_by_operator",
    `status set to ${status}`,
    operator,
  );
  return { status };
}

/**
 * Turn off a second factor an operator cannot otherwise reach.
 *
 * The recovery path of last resort, for somebody who has lost both their
 * authenticator and their recovery codes. It is the single most dangerous
 * action here — it removes a factor without proving anything about who asked —
 * so it is audited like the others and named for what it is.
 *
 * @param {string} userId
 * @param {string} operator
 */
export async function clearTwoFactor(userId, operator) {
  requireUuid(userId);
  await adminQuery(
    `UPDATE app.users SET totp_secret = NULL, totp_pending = NULL WHERE user_id = $1`,
    [userId],
  );
  await adminQuery(`DELETE FROM app.recovery_codes WHERE user_id = $1`, [userId]);
  await recordOperatorAction(
    userId, "two_factor_cleared_by_operator",
    "second factor removed without the account holder's password", operator,
  );
  return { cleared: true };
}

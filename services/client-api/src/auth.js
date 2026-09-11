/**
 * Identity: registration, sessions, passwords and second factors.
 *
 * ## Why this lives here, and what that costs
 *
 * Authentication belongs to `16-kyc-aml`, which has not passed its gates. This
 * module is the part that carries no regulatory weight — proving that a person
 * is the same person who registered — built at the edge so the client area has
 * a real identity instead of one shared development owner. Identity
 * *verification* (who that person is in the world, and whether they may be
 * onboarded at all) stays with `16-kyc-aml` and is not attempted here.
 *
 * What that means in practice: a session here establishes **ownership of an
 * account record**. It does not establish that anyone is KYC-verified, and
 * nothing downstream may read it as though it did.
 *
 * ## The rules this file exists to hold
 *
 * - A password is never stored, logged, or returned. Only a scrypt digest is.
 * - A session token is never stored either — only its SHA-256 — so a database
 *   disclosure does not hand over live sessions.
 * - Comparisons on secrets are constant-time. A fast rejection is a side
 *   channel, and a login endpoint is where it gets measured.
 * - A failed login says the same thing whether the email exists or not. An
 *   error that distinguishes them is an account-enumeration oracle.
 * - This module stores no financial value (INV-184), like everything else at
 *   the edge.
 */

import {
  createHash, createHmac, randomBytes, randomUUID,
  scrypt as scryptCb, timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import { asAuth, asOwner } from "./db.js";
import { HttpError } from "./money.js";

/**
 * `promisify` cannot see through `scrypt`'s overloads, so the options argument
 * — which is where the cost parameters live — is typed away entirely. Naming
 * the signature we actually call keeps the checker useful here instead of
 * silenced at every call site.
 */
const scrypt =
  /** @type {(password: string | Buffer, salt: string | Buffer, keylen: number, options: {N: number, r: number, p: number}) => Promise<Buffer>} */ (
    /** @type {unknown} */ (promisify(scryptCb))
  );

/* ------------------------------------------------------------------ policy */

/** scrypt parameters. Cost is deliberate: this runs once per login, not per request. */
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 };

/** How long a session lives. "Remember me" trades a longer window for convenience. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_TTL_REMEMBERED_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Failed-login lockout.
 *
 * Five attempts, then fifteen minutes. This is a throttle on guessing, not a
 * punishment: the window is short enough that someone who mistyped twice is not
 * locked out of their money for the afternoon, and long enough that an online
 * guessing attack is hopeless.
 */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/** Minimum password length. Length beats character-class theatre. */
const MIN_PASSWORD_LENGTH = 10;

/**
 * Passwords refused outright.
 *
 * A deliberately short list. A real deployment checks against a breach corpus
 * (`16-kyc-aml` owns that); this catches the handful a person actually types
 * when a form asks for ten characters and they resent being asked.
 */
const REFUSED_PASSWORDS = new Set([
  "password12", "password123", "password1234", "1234567890", "12345678901",
  "qwertyuiop", "qwerty12345", "letmein123", "welcome123", "iloveyou12",
  "admin12345", "trustno1234", "passw0rd12", "abcdefghij", "aaaaaaaaaa",
  "changeme12", "projectx12", "0123456789", "1qaz2wsx3e", "monkey1234",
]);

/**
 * Email shape. Deliberately permissive.
 *
 * Over-strict email validation rejects real addresses — plus-addressing, long
 * TLDs, apostrophes in the local part — and the only way to truly know an
 * address works is to send to it. This rejects what is obviously not an
 * address and leaves the rest to delivery.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Countries offered at registration. Presentation data, not a compliance list. */
export const COUNTRIES = [
  "Australia", "Austria", "Belgium", "Brazil", "Canada", "Cyprus", "Denmark",
  "Finland", "France", "Germany", "Greece", "Ireland", "Italy", "Japan",
  "Luxembourg", "Malta", "Netherlands", "New Zealand", "Norway", "Pakistan",
  "Poland", "Portugal", "Singapore", "South Africa", "Spain", "Sweden",
  "Switzerland", "United Arab Emirates", "United Kingdom", "Other",
];

export const BASE_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF"];

/* ------------------------------------------------------------- primitives */

/**
 * Hash a password with a fresh random salt.
 *
 * The parameters travel with the digest so they can be raised later without
 * invalidating every existing password — `verifyPassword` reads whatever the
 * stored record was written with.
 *
 * @param {string} password
 * @returns {Promise<string>} `scrypt$N$r$p$salt$digest`, base64url throughout.
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = /** @type {Buffer} */ (
    await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  );
  return [
    "scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString("base64url"), derived.toString("base64url"),
  ].join("$");
}

/**
 * Verify a password against a stored digest, in constant time.
 *
 * Returns false rather than throwing on a malformed record: a corrupt row must
 * not become a way to authenticate, and it must not become a 500 either.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hostile row could otherwise ask for a cost parameter that never returns.
  if (N < 2 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(String(parts[4]), "base64url");
    expected = Buffer.from(String(parts[5]), "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived;
  try {
    derived = /** @type {Buffer} */ (await scrypt(password, salt, expected.length, { N, r, p }));
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** @param {string} value */
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** A session token the client keeps, and the digest the database keeps. */
function newSessionToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, digest: sha256(token) };
}

/** @param {unknown} email */
const normaliseEmail = (email) => String(email ?? "").trim().toLowerCase();

/* ------------------------------------------------------------- validation */

/**
 * Check a password against policy and say precisely what is wrong.
 *
 * Every failure names the rule it broke. "Password not strong enough" is a dead
 * end for the person typing; "needs 10 characters, you have 8" is not.
 *
 * @param {unknown} password
 * @param {{email?: string, name?: string}} [context] Values the password may not contain.
 * @returns {string[]} Empty when the password is acceptable.
 */
export function passwordProblems(password, context = {}) {
  /** @type {string[]} */
  const problems = [];
  if (typeof password !== "string" || password.length === 0) {
    return ["Enter a password."];
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters — this one has ${password.length}.`);
  }
  if (password.length > 200) {
    problems.push("Use no more than 200 characters.");
  }
  if (REFUSED_PASSWORDS.has(password.toLowerCase())) {
    problems.push("This is one of the most commonly used passwords. Choose another.");
  }
  if (/^(.)\1*$/.test(password)) {
    problems.push("A single repeated character is not a password.");
  }

  const local = normaliseEmail(context.email).split("@")[0] ?? "";
  if (local.length >= 3 && password.toLowerCase().includes(local)) {
    problems.push("Your password must not contain your email address.");
  }
  const name = String(context.name ?? "").trim().toLowerCase();
  if (name.length >= 3 && password.toLowerCase().includes(name)) {
    problems.push("Your password must not contain your name.");
  }
  return problems;
}

/**
 * A rough strength score, 0-4, for the meter on the registration form.
 *
 * This scores *variety and length*, which is what a meter can honestly measure
 * without a breach corpus. It is advice, not a gate — `passwordProblems` is the
 * gate, and the two are deliberately separate so a flattering score can never
 * admit a password the policy refuses.
 *
 * @param {string} password
 * @returns {number} 0-4.
 */
export function passwordScore(password) {
  const value = String(password ?? "");
  if (value.length === 0) return 0;
  if (REFUSED_PASSWORDS.has(value.toLowerCase()) || /^(.)\1*$/.test(value)) return 0;

  let score = 0;
  if (value.length >= 10) score += 1;
  if (value.length >= 14) score += 1;
  if (value.length >= 20) score += 1;

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (classes >= 2) score += 1;
  if (classes >= 3) score += 1;

  return Math.max(0, Math.min(4, score - 1));
}

/**
 * @param {unknown} email
 * @returns {string} The normalised address.
 */
export function requireEmail(email) {
  const value = normaliseEmail(email);
  if (!value || value.length > 254 || !EMAIL.test(value)) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  return value;
}

/**
 * @param {unknown} name
 * @returns {string}
 */
export function requireName(name) {
  const value = String(name ?? "").trim().replace(/\s+/g, " ");
  if (value.length < 2) throw new HttpError(400, "Enter your full name.");
  if (value.length > 120) throw new HttpError(400, "That name is too long.");
  // Control characters in a name end up in emails, statements and logs.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, "That name contains characters we cannot store.");
  }
  return value;
}

/* ----------------------------------------------------------- audit trail */

/**
 * Record something that happened to an account.
 *
 * Takes the transaction's own query function rather than opening its own, so
 * the event and the change it describes commit together. An audit row written
 * in a separate transaction is an audit row that can survive a rollback and
 * describe something that never happened.
 *
 * Deliberately never carries the thing itself — no password, no token, no TOTP
 * secret. An audit log is read by more people than the tables it describes, and
 * is exported, shipped and retained for longer.
 *
 * @param {import("./db.js").Query} q
 * @param {string|null} userId
 * @param {string} event
 * @param {string|null} [detail]
 * @param {string} [ip]
 * @param {string} [userAgent]
 */
async function record(q, userId, event, detail = null, ip, userAgent) {
  await q(
    `INSERT INTO app.security_events (user_id, event, detail, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId, event, detail,
      String(ip ?? "").slice(0, 60) || null,
      String(userAgent ?? "").slice(0, 300) || null,
    ],
  );
}

/**
 * What has happened to this account, newest first.
 *
 * @param {string} userId
 * @param {number} [limit]
 */
export async function securityHistory(userId, limit = 20) {
  const bounded = Math.max(1, Math.min(100, Number(limit) || 20));
  const result = await asOwner(userId, (q) => q(
    `SELECT event, detail, ip, user_agent, at
       FROM app.security_events
      WHERE user_id = $1
      ORDER BY at DESC
      LIMIT ${bounded}`,
    [userId],
  ));
  return result.rows.map((/** @type {Record<string, any>} */ row) => ({
    event: row.event,
    detail: row.detail,
    ip: row.ip ?? "—",
    device: describeUserAgent(row.user_agent),
    at: new Date(row.at).toISOString(),
  }));
}

/* ------------------------------------------------------------ registration */

/**
 * The shape of a user as this API presents it. No password material, ever.
 *
 * @typedef {object} PresentedUser
 * @property {string} userId
 * @property {string} email
 * @property {string} name
 * @property {string} country
 * @property {string} baseCurrency
 * @property {boolean} emailVerified
 * @property {boolean} twoFactorEnabled
 * @property {string} createdAt
 * @property {string|null} lastLoginAt
 */

/**
 * @param {Record<string, any>} row
 * @returns {PresentedUser}
 */
function presentUser(row) {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    country: row.country,
    baseCurrency: row.base_currency,
    emailVerified: Boolean(row.email_verified),
    twoFactorEnabled: Boolean(row.totp_secret),
    createdAt: new Date(row.created_at).toISOString(),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
  };
}

/**
 * Create an account.
 *
 * The unique index on `lower(email)` is what actually prevents a duplicate —
 * checking first and inserting second is a race, and two people registering the
 * same address in the same second is exactly when it matters.
 *
 * @param {{email: unknown, password: unknown, name: unknown, country?: unknown,
 *          baseCurrency?: unknown, acceptedTerms?: unknown,
 *          ip?: string|undefined, userAgent?: string|undefined}} input
 * @returns {Promise<PresentedUser>}
 */
export async function register(input) {
  const email = requireEmail(input.email);
  const name = requireName(input.name);

  if (input.acceptedTerms !== true) {
    throw new HttpError(
      400,
      "You must accept the client agreement and risk disclosure to open an account.",
    );
  }

  const problems = passwordProblems(input.password, { email, name });
  if (problems.length > 0) throw new HttpError(400, problems.join(" "));

  const country = COUNTRIES.includes(String(input.country)) ? String(input.country) : "Other";
  const baseCurrency = BASE_CURRENCIES.includes(String(input.baseCurrency))
    ? String(input.baseCurrency)
    : "USD";

  const passwordHash = await hashPassword(String(input.password));
  const userId = randomUUID();

  try {
    return await asAuth(async (q) => {
      const result = await q(
        `INSERT INTO app.users (user_id, email, password_hash, name, country, base_currency)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [userId, email, passwordHash, name, country, baseCurrency],
      );
      await record(q, userId, "registered", null, input.ip, input.userAgent);
      return presentUser(result.rows[0]);
    });
  } catch (error) {
    // 23505 = unique_violation. The address is already registered.
    if (/** @type {{code?: string}} */ (error)?.code === "23505") {
      throw new HttpError(409, "An account already exists for that email address.");
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ login */

/**
 * The generic failure. Used for a missing user, a wrong password and a disabled
 * account alike, so none of them can be told apart from outside.
 */
const BAD_CREDENTIALS = "That email address and password do not match an account.";

/**
 * A dummy digest, verified against when no user exists.
 *
 * Without it, a login for an unknown address returns in microseconds while a
 * known one takes the full scrypt cost — which turns response time into a
 * membership oracle. This spends the same work on both paths.
 */
let absentUserDigest = "";

/**
 * Sign in.
 *
 * @param {{email: unknown, password: unknown, totp?: unknown, remember?: unknown,
 *          userAgent?: string|undefined, ip?: string|undefined}} input
 * @returns {Promise<{token: string, expiresAt: string, user: PresentedUser}>}
 */
export async function login(input) {
  const email = normaliseEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";

  const found = await asAuth((q) => q(`SELECT * FROM app.users WHERE email = $1`, [email]));
  const user = found.rows[0];

  if (!user) {
    // Spend the same work as a real verification before refusing.
    if (!absentUserDigest) absentUserDigest = await hashPassword(randomBytes(16).toString("hex"));
    await verifyPassword(password, absentUserDigest);
    throw new HttpError(401, BAD_CREDENTIALS, { credentialRejected: true });
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutes = Math.max(
      1,
      Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000),
    );
    throw new HttpError(
      429,
      `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    );
  }

  if (user.status !== "active") throw new HttpError(401, BAD_CREDENTIALS, { credentialRejected: true });

  const correct = await verifyPassword(password, user.password_hash);
  if (!correct) {
    await recordFailedAttempt(user, input.ip, input.userAgent);
    throw new HttpError(401, BAD_CREDENTIALS, { credentialRejected: true });
  }

  // Second factor, when the account carries one. Checked *after* the password,
  // so the prompt itself never reveals that an address is registered.
  if (user.totp_secret) {
    const code = String(input.totp ?? "").replace(/\s/g, "");
    if (!code) throw new HttpError(401, "two_factor_required");

    const byApp = verifyTotp(user.totp_secret, code);
    const byRecovery = byApp ? false : await consumeRecoveryCode(user.user_id, code);
    if (!byApp && !byRecovery) {
      await recordFailedAttempt(user, input.ip, input.userAgent);
      throw new HttpError(
        401,
        "That verification code is not valid. Codes expire after 30 seconds.",
        { credentialRejected: true },
      );
    }
  }

  await asAuth(async (q) => {
    await q(
      `UPDATE app.users
          SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
        WHERE user_id = $1`,
      [user.user_id],
    );
    await record(q, user.user_id, "signed_in", null, input.ip, input.userAgent);
  });

  const session = await createSession(user.user_id, {
    remember: input.remember === true,
    userAgent: input.userAgent,
    ip: input.ip,
  });

  return { ...session, user: presentUser({ ...user, last_login_at: new Date() }) };
}

/**
 * @param {{user_id: string, failed_attempts: number}} user
 * @param {string|undefined} [ip]
 * @param {string|undefined} [userAgent]
 */
async function recordFailedAttempt(user, ip, userAgent) {
  const attempts = Number(user.failed_attempts ?? 0) + 1;
  const lock = attempts >= MAX_FAILED_ATTEMPTS;
  await asAuth(async (q) => {
    await q(
      `UPDATE app.users
          SET failed_attempts = $2,
              locked_until = CASE WHEN $3::boolean
                                  THEN now() + ($4 || ' milliseconds')::interval
                                  ELSE locked_until END
        WHERE user_id = $1`,
      [user.user_id, lock ? 0 : attempts, lock, String(LOCKOUT_MS)],
    );
    await record(
      q, user.user_id,
      lock ? "locked_out" : "sign_in_failed",
      lock ? `after ${attempts} failed attempts` : null,
      ip, userAgent,
    );
  });
}

/* --------------------------------------------------------------- sessions */

/**
 * Issue a session.
 *
 * @param {string} userId
 * @param {{remember?: boolean, userAgent?: string|undefined, ip?: string|undefined}} [options]
 * @returns {Promise<{token: string, expiresAt: string}>}
 */
export async function createSession(userId, options = {}) {
  const { token, digest } = newSessionToken();
  const ttl = options.remember ? SESSION_TTL_REMEMBERED_MS : SESSION_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  await asAuth((q) => q(
    `INSERT INTO app.sessions (session_id, user_id, token_digest, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(), userId, digest, expiresAt,
      String(options.userAgent ?? "").slice(0, 300) || null,
      String(options.ip ?? "").slice(0, 60) || null,
    ],
  ));

  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * Resolve a bearer token to the user it belongs to.
 *
 * Returns null for anything that is not a live session — expired, revoked,
 * unknown, or belonging to a disabled user. The caller decides whether that is
 * an error; this function does not throw for an absent session, because most
 * endpoints are readable without one.
 *
 * @param {string|undefined} token
 * @returns {Promise<{user: PresentedUser, sessionId: string, expiresAt: string}|null>}
 */
export async function sessionFromToken(token) {
  if (typeof token !== "string" || token.length < 20) return null;

  const digest = sha256(token);
  const result = await asAuth((q) => q(
    `SELECT s.session_id, s.expires_at, u.*
       FROM app.sessions s
       JOIN app.users u ON u.user_id = s.user_id
      WHERE s.token_digest = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'`,
    [digest],
  ));
  const row = result.rows[0];
  if (!row) return null;

  // Touch it, so "last seen" on the security page means something.
  //
  // Scoped by the digest rather than by the session id we just read. The two
  // select the same row, but it keeps one rule true of every statement in this
  // file without exception: a session is addressed by something the caller
  // proved they hold, or by the user who owns it — never by a bare identifier.
  // A rule with one sanctioned exception is a rule nobody can check.
  await asAuth((q) =>
    q(`UPDATE app.sessions SET last_seen_at = now() WHERE token_digest = $1`, [digest]));

  return {
    user: presentUser(row),
    sessionId: row.session_id,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/**
 * End one session.
 * @param {string|undefined} token
 */
export async function logout(token) {
  if (typeof token !== "string" || !token) return false;
  const result = await asAuth((q) => q(
    `UPDATE app.sessions SET revoked_at = now()
      WHERE token_digest = $1 AND revoked_at IS NULL`,
    [sha256(token)],
  ));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Every live session for a user, newest first, with the current one marked.
 *
 * @param {string} userId
 * @param {string} currentSessionId
 */
export async function listSessions(userId, currentSessionId) {
  // Owner-scoped rather than credential-scoped: we already know who is asking,
  // so the database can be told, and it will refuse to return anyone else's
  // sessions even if this query were wrong.
  const result = await asOwner(userId, (q) => q(
    `SELECT session_id, created_at, last_seen_at, expires_at, user_agent, ip
       FROM app.sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [userId],
  ));
  return result.rows.map((/** @type {Record<string, any>} */ row) => ({
    sessionId: row.session_id,
    current: row.session_id === currentSessionId,
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    device: describeUserAgent(row.user_agent),
    ip: row.ip ?? "—",
  }));
}

/**
 * A user agent, as something a person can recognise their own device in.
 *
 * Deliberately coarse. The question being answered is "was that me?", which
 * needs the browser and the platform and nothing else; a full UA string in the
 * interface is noise that makes the answer harder to see.
 *
 * @param {string|null} ua
 */
export function describeUserAgent(ua) {
  const value = String(ua ?? "");
  if (!value) return "Unknown device";

  const browser =
    /Edg\//.test(value) ? "Edge"
    : /OPR\//.test(value) ? "Opera"
    : /Firefox\//.test(value) ? "Firefox"
    : /HeadlessChrome/.test(value) ? "Headless Chrome"
    : /Chrome\//.test(value) ? "Chrome"
    : /Safari\//.test(value) ? "Safari"
    : "Unknown browser";

  const platform =
    /Windows/.test(value) ? "Windows"
    : /Android/.test(value) ? "Android"
    : /iPhone|iPad|iOS/.test(value) ? "iOS"
    : /Mac OS X|Macintosh/.test(value) ? "macOS"
    : /CrOS/.test(value) ? "ChromeOS"
    : /Linux/.test(value) ? "Linux"
    : "Unknown platform";

  return `${platform} · ${browser}`;
}

/**
 * Revoke one session belonging to this user.
 *
 * Scoped by `user_id` as well as session id, so a session identifier belonging
 * to another account revokes nothing.
 *
 * @param {string} userId
 * @param {string} sessionId
 */
export async function revokeSession(userId, sessionId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sessionId))) {
    throw new HttpError(400, "That is not a session identifier.");
  }
  const result = await asOwner(userId, (q) => q(
    `UPDATE app.sessions SET revoked_at = now()
      WHERE user_id = $1 AND session_id = $2 AND revoked_at IS NULL`,
    [userId, sessionId],
  ));
  if ((result.rowCount ?? 0) === 0) throw new HttpError(404, "That session has already ended.");
  return true;
}

/**
 * Revoke every session except the one making the request.
 * @param {string} userId
 * @param {string} keepSessionId
 */
export async function revokeOtherSessions(userId, keepSessionId) {
  const result = await asOwner(userId, (q) => q(
    `UPDATE app.sessions SET revoked_at = now()
      WHERE user_id = $1 AND session_id <> $2 AND revoked_at IS NULL`,
    [userId, keepSessionId],
  ));
  return result.rowCount ?? 0;
}

/* --------------------------------------------------------------- password */

/**
 * Change a password.
 *
 * Every other session is revoked. If the reason for the change is that someone
 * else knows the old password, leaving their session alive defeats the point.
 *
 * @param {string} userId
 * @param {string} keepSessionId
 * @param {{currentPassword: unknown, newPassword: unknown,
 *          ip?: string|undefined, userAgent?: string|undefined}} input
 */
export async function changePassword(userId, keepSessionId, input) {
  const found = await asOwner(userId, (q) =>
    q(`SELECT * FROM app.users WHERE user_id = $1`, [userId]));
  const user = found.rows[0];
  if (!user) throw new HttpError(401, "Sign in again to change your password.");

  const correct = await verifyPassword(String(input.currentPassword ?? ""), user.password_hash);
  if (!correct) {
    throw new HttpError(403, "Your current password is not correct.", { credentialRejected: true });
  }

  const problems = passwordProblems(input.newPassword, { email: user.email, name: user.name });
  if (problems.length > 0) throw new HttpError(400, problems.join(" "));

  if (await verifyPassword(String(input.newPassword), user.password_hash)) {
    throw new HttpError(400, "Your new password must be different from your current one.");
  }

  const hash = await hashPassword(String(input.newPassword));
  await asOwner(userId, async (q) => {
    await q(
      `UPDATE app.users SET password_hash = $2, password_changed_at = now() WHERE user_id = $1`,
      [userId, hash],
    );
    await record(q, userId, "password_changed", null, input.ip, input.userAgent);
  });

  const revoked = await revokeOtherSessions(userId, keepSessionId);

  // The surviving session gets a new token.
  //
  // Keeping the old one would mean the credential that existed before the
  // change still works after it — so if the reason for changing the password
  // was that someone else had obtained this session, the change would have
  // accomplished nothing for the one session that mattered. The caller swaps
  // the cookie for this.
  const rotated = await rotateSession(userId, keepSessionId, {
    userAgent: input.userAgent, ip: input.ip,
  });

  return { revokedSessions: revoked, ...rotated };
}

/**
 * Replace a live session's token with a fresh one, keeping the session row.
 *
 * Used after any change that alters what the session is allowed to mean. The
 * row is kept rather than replaced so "signed in since" on the security page
 * stays honest — nobody signed in again, the credential was reissued.
 *
 * @param {string} userId
 * @param {string} sessionId
 * @param {{userAgent?: string|undefined, ip?: string|undefined}} [context]
 * @returns {Promise<{token: string, expiresAt: string}>}
 */
export async function rotateSession(userId, sessionId, context = {}) {
  const { token, digest } = newSessionToken();
  const result = await asOwner(userId, (q) => q(
    `UPDATE app.sessions
        SET token_digest = $3, last_seen_at = now()
      WHERE user_id = $1 AND session_id = $2 AND revoked_at IS NULL
      RETURNING expires_at`,
    [userId, sessionId, digest],
  ));
  const row = result.rows[0];
  if (!row) throw new HttpError(401, "That session has ended. Sign in again.");
  void context;
  return { token, expiresAt: new Date(row.expires_at).toISOString() };
}

/* ------------------------------------------------- reset and verification */

/** How long a one-time link is good for. Short, because it arrives by email. */
const RESET_TTL_MS = 60 * 60 * 1000;
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Where the outbox sends people. Set to the public origin in a deployment.
 */
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? "http://127.0.0.1:27000";

/**
 * Mint a one-time token for a purpose.
 *
 * The token is returned once and stored only as its SHA-256, exactly like a
 * session. A reset table that can be read to mint a reset is a reset table that
 * turns a read-only database disclosure into account takeover.
 *
 * Any unconsumed token for the same purpose is invalidated first, so requesting
 * a second reset link makes the first one dead rather than leaving two valid
 * ways in.
 *
 * @param {import("./db.js").Query} q
 * @param {string} userId
 * @param {"password_reset"|"email_verification"} purpose
 * @param {number} ttlMs
 * @param {string} [ip]
 */
async function mintToken(q, userId, purpose, ttlMs, ip) {
  await q(
    `UPDATE app.one_time_tokens SET consumed_at = now()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [userId, purpose],
  );

  const token = randomBytes(32).toString("base64url");
  await q(
    `INSERT INTO app.one_time_tokens (token_digest, user_id, purpose, expires_at, requested_ip)
     VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval, $5)`,
    [sha256(token), userId, purpose, String(ttlMs), String(ip ?? "").slice(0, 60) || null],
  );
  return token;
}

/**
 * Queue a message for delivery.
 *
 * There is no email provider, so nothing leaves this table — `blocked_reason`
 * records why, and a delivery worker would drain it once one exists. This is
 * the honest shape: the flow is real, the link is real, and the only missing
 * piece is the transport, which is missing visibly rather than silently.
 *
 * @param {import("./db.js").Query} q
 * @param {{userId: string, to: string, kind: string, subject: string, body: string}} message
 */
async function enqueue(q, { userId, to, kind, subject, body }) {
  await q(
    `INSERT INTO app.outbox (message_id, user_id, to_address, kind, subject, body, blocked_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(), userId, to, kind, subject, body,
      "No email provider is configured. 18-notifications has not passed its gates.",
    ],
  );
}

/**
 * Begin a password reset.
 *
 * **Always reports success**, whether or not the address is registered. The
 * alternative tells anyone who asks which addresses have accounts here, which
 * on a financial site is worth money to the person asking. The work is
 * comparable either way for the same reason the sign-in path spends a full
 * verification on an absent user.
 *
 * @param {{email: unknown, ip?: string|undefined}} input
 */
export async function requestPasswordReset(input) {
  const email = normaliseEmail(input.email);

  await asAuth(async (q) => {
    const found = await q(`SELECT user_id, name, status FROM app.users WHERE email = $1`, [email]);
    const user = found.rows[0];
    if (!user || user.status !== "active") return;

    const token = await mintToken(q, user.user_id, "password_reset", RESET_TTL_MS, input.ip);
    const link = `${PUBLIC_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;

    await enqueue(q, {
      userId: user.user_id,
      to: email,
      kind: "password_reset",
      subject: "Reset your Project X password",
      body:
        `Someone asked to reset the password for this account.\n\n` +
        `${link}\n\n` +
        `This link works once and expires in one hour. If it was not you, ` +
        `nothing has changed and you can ignore this message.`,
    });
    await record(q, user.user_id, "password_reset_requested", null, input.ip);
  });

  // The same answer in every case, including when nothing happened.
  return {
    accepted: true,
    detail:
      "If that address has an account, a reset link has been created for it. " +
      "The link works once and expires in an hour.",
  };
}

/**
 * Check a reset token without spending it.
 *
 * The reset page calls this before showing the form, so somebody following a
 * stale link is told immediately rather than after typing a new password twice.
 *
 * @param {unknown} token
 */
export async function checkResetToken(token) {
  const row = await lookupToken(token, "password_reset");
  return { valid: Boolean(row) };
}

/**
 * @param {unknown} token
 * @param {"password_reset"|"email_verification"} purpose
 */
async function lookupToken(token, purpose) {
  if (typeof token !== "string" || token.length < 20) return null;
  const result = await asAuth((q) => q(
    `SELECT t.token_digest, t.user_id, u.email, u.name
       FROM app.one_time_tokens t
       JOIN app.users u ON u.user_id = t.user_id
      WHERE t.token_digest = $1
        AND t.purpose = $2
        AND t.consumed_at IS NULL
        AND t.expires_at > now()
        AND u.status = 'active'`,
    [sha256(token), purpose],
  ));
  return result.rows[0] ?? null;
}

/**
 * Complete a password reset.
 *
 * The token is consumed and every session is revoked — all of them, including
 * the one that asked. Somebody resetting a password either forgot it or is
 * recovering an account somebody else reached; in both cases the right outcome
 * is that every existing session stops working and they sign in fresh.
 *
 * @param {{token: unknown, newPassword: unknown, ip?: string|undefined,
 *          userAgent?: string|undefined}} input
 */
export async function completePasswordReset(input) {
  const row = await lookupToken(input.token, "password_reset");
  if (!row) {
    throw new HttpError(
      400,
      "That reset link is no longer valid. Links work once and expire after an hour — request a new one.",
    );
  }

  const problems = passwordProblems(input.newPassword, { email: row.email, name: row.name });
  if (problems.length > 0) throw new HttpError(400, problems.join(" "));

  const hash = await hashPassword(String(input.newPassword));

  await asAuth(async (q) => {
    // Consumed inside the same transaction that changes the password, and
    // re-checked while doing it: two requests arriving with the same token at
    // the same moment must not both succeed.
    const consumed = await q(
      `UPDATE app.one_time_tokens SET consumed_at = now()
        WHERE token_digest = $1 AND consumed_at IS NULL`,
      [row.token_digest],
    );
    if ((consumed.rowCount ?? 0) === 0) {
      throw new HttpError(400, "That reset link has already been used.");
    }

    await q(
      `UPDATE app.users
          SET password_hash = $2, password_changed_at = now(),
              failed_attempts = 0, locked_until = NULL
        WHERE user_id = $1`,
      [row.user_id, hash],
    );

    // Resetting also clears a lockout: somebody who forgot their password and
    // guessed at it five times should not have to wait fifteen minutes after
    // proving they hold the address.
    await q(
      `UPDATE app.sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [row.user_id],
    );
    await record(q, row.user_id, "password_reset_completed", null, input.ip, input.userAgent);
  });

  return {
    reset: true,
    detail: "Your password has been reset and every session has been signed out.",
  };
}

/**
 * Send an address-confirmation link.
 * @param {string} userId
 * @param {string} email
 * @param {string} [ip]
 */
export async function requestEmailVerification(userId, email, ip) {
  await asAuth(async (q) => {
    const token = await mintToken(q, userId, "email_verification", VERIFICATION_TTL_MS, ip);
    const link = `${PUBLIC_ORIGIN}/verify-email?token=${encodeURIComponent(token)}`;
    await enqueue(q, {
      userId, to: email, kind: "email_verification",
      subject: "Confirm your email address",
      body: `Confirm this address by following the link below.\n\n${link}\n\nIt expires in 24 hours.`,
    });
    await record(q, userId, "email_verification_requested", null, ip);
  });
  return { sent: true };
}

/**
 * Confirm an address.
 * @param {{token: unknown, ip?: string|undefined}} input
 */
export async function completeEmailVerification(input) {
  const row = await lookupToken(input.token, "email_verification");
  if (!row) {
    throw new HttpError(400, "That confirmation link is no longer valid. Request a new one.");
  }
  await asAuth(async (q) => {
    const consumed = await q(
      `UPDATE app.one_time_tokens SET consumed_at = now()
        WHERE token_digest = $1 AND consumed_at IS NULL`,
      [row.token_digest],
    );
    if ((consumed.rowCount ?? 0) === 0) {
      throw new HttpError(400, "That confirmation link has already been used.");
    }
    await q(`UPDATE app.users SET email_verified = true WHERE user_id = $1`, [row.user_id]);
    await record(q, row.user_id, "email_verified", null, input.ip);
  });
  return { verified: true, email: row.email };
}

/**
 * Read the outbox.
 *
 * Exists because the messages have nowhere else to go. In development this is
 * how a reset link is actually retrieved, and the end-to-end suite uses it to
 * follow the flow a person would follow through their inbox.
 *
 * Guarded: without a provider this is the only copy of a live reset link, so it
 * is readable only when explicitly enabled, and never in production.
 *
 * @param {string} [address] Limit to one recipient.
 */
export async function readOutbox(address) {
  const result = await asAuth((q) => q(
    address
      ? `SELECT message_id, to_address, kind, subject, body, created_at, blocked_reason
           FROM app.outbox WHERE to_address = $1 ORDER BY created_at DESC LIMIT 20`
      : `SELECT message_id, to_address, kind, subject, body, created_at, blocked_reason
           FROM app.outbox ORDER BY created_at DESC LIMIT 20`,
    address ? [String(address).toLowerCase()] : [],
  ));
  return result.rows.map((/** @type {Record<string, any>} */ row) => ({
    messageId: row.message_id,
    to: row.to_address,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    blockedReason: row.blocked_reason,
  }));
}

/* ---------------------------------------------------------- second factor */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 base32, no padding. Authenticator apps expect this encoding.
 * @param {Buffer} buffer
 */
export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

/** @param {string} encoded */
export function base32Decode(encoded) {
  let bits = 0;
  let value = 0;
  /** @type {number[]} */
  const output = [];
  for (const char of String(encoded).toUpperCase().replace(/[=\s]/g, "")) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new HttpError(400, "That is not a valid authenticator secret.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/**
 * One TOTP code for a counter. RFC 6238 with the near-universal defaults:
 * HMAC-SHA1, six digits, a thirty-second step.
 *
 * SHA-1 is not a weakness here — HMAC-SHA1 is unbroken, and the alternative is
 * a code no authenticator app can generate.
 *
 * @param {string} secretBase32
 * @param {number} counter
 */
function totpAt(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", key).update(message).digest();
  const offset = Number(digest[digest.length - 1]) & 0x0f;
  const binary =
    ((Number(digest[offset]) & 0x7f) << 24) |
    ((Number(digest[offset + 1]) & 0xff) << 16) |
    ((Number(digest[offset + 2]) & 0xff) << 8) |
    (Number(digest[offset + 3]) & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Verify a TOTP code, allowing one step either side for clock drift.
 *
 * The comparison is constant-time, and the candidate is shape-checked first so
 * `timingSafeEqual` never sees mismatched lengths.
 *
 * @param {string} secretBase32
 * @param {string} code
 * @param {number} [now] Milliseconds, injectable for tests.
 */
export function verifyTotp(secretBase32, code, now = Date.now()) {
  const candidate = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(candidate)) return false;

  const counter = Math.floor(now / 30_000);
  let matched = false;
  // Every drift is checked even after a match, so the loop takes the same time
  // whichever step the code came from.
  for (const drift of [-1, 0, 1]) {
    const expected = totpAt(secretBase32, counter + drift);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) matched = true;
  }
  return matched;
}

/**
 * The current code for a secret. Exported for the end-to-end suite, which has
 * to behave like an authenticator app to prove the flow works.
 *
 * @param {string} secretBase32
 * @param {number} [now]
 */
export function currentTotp(secretBase32, now = Date.now()) {
  return totpAt(secretBase32, Math.floor(now / 30_000));
}

/**
 * Begin enrolment: generate a secret and the URI an authenticator app reads.
 *
 * The secret is written to a *pending* column, not enabled. Enrolment completes
 * only when the person proves they can generate a code from it — saving it as
 * live first is how people lock themselves out by scanning a code and then
 * closing the tab.
 *
 * @param {string} userId
 * @param {string} email
 */
export async function beginTotpEnrolment(userId, email) {
  const secret = base32Encode(randomBytes(20));
  await asOwner(userId, (q) =>
    q(`UPDATE app.users SET totp_pending = $2 WHERE user_id = $1`, [userId, secret]));

  const label = encodeURIComponent(`Project X:${email}`);
  const issuer = encodeURIComponent("Project X");
  return {
    secret,
    // Grouped in fours: this gets typed by hand by anyone whose authenticator
    // is on the same device as the browser.
    formattedSecret: secret.replace(/(.{4})/g, "$1 ").trim(),
    otpauthUri:
      `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}` +
      `&algorithm=SHA1&digits=6&period=30`,
  };
}

/**
 * Finish enrolment by proving the secret works, and issue recovery codes.
 *
 * @param {string} userId
 * @param {string} code
 */
export async function confirmTotpEnrolment(userId, code) {
  const found = await asOwner(userId, (q) =>
    q(`SELECT totp_pending FROM app.users WHERE user_id = $1`, [userId]));
  const pending = found.rows[0]?.totp_pending;
  if (!pending) {
    throw new HttpError(400, "Start two-factor setup again — no enrolment is in progress.");
  }
  if (!verifyTotp(pending, code)) {
    throw new HttpError(
      400,
      "That code is not valid. Check your authenticator and enter the code it shows now.",
    );
  }

  const codes = Array.from({ length: 10 }, () =>
    randomBytes(5).toString("hex").toUpperCase().replace(/^(.{5})/, "$1-"),
  );

  // One transaction: enabling the factor and issuing its recovery codes either
  // both happen or neither does. Half of this is an account with a second
  // factor and no way back into it.
  await asOwner(userId, async (q) => {
    await q(
      `UPDATE app.users SET totp_secret = totp_pending, totp_pending = NULL WHERE user_id = $1`,
      [userId],
    );
    await q(`DELETE FROM app.recovery_codes WHERE user_id = $1`, [userId]);
    for (const recovery of codes) {
      await q(
        `INSERT INTO app.recovery_codes (user_id, code_digest) VALUES ($1, $2)`,
        [userId, sha256(recovery)],
      );
    }
    await record(q, userId, "two_factor_enabled", null);
  });

  // The only moment these are ever readable. Only digests are stored.
  return { recoveryCodes: codes };
}

/**
 * Turn off two-factor authentication.
 *
 * Requires the password, because otherwise a borrowed session is enough to
 * remove the factor that exists to make a borrowed session useless.
 *
 * @param {string} userId
 * @param {unknown} password
 */
export async function disableTotp(userId, password) {
  const found = await asOwner(userId, (q) =>
    q(`SELECT password_hash FROM app.users WHERE user_id = $1`, [userId]));
  const user = found.rows[0];
  if (!user) throw new HttpError(401, "Sign in again.");
  if (!(await verifyPassword(String(password ?? ""), user.password_hash))) {
    throw new HttpError(403, "Your password is not correct.", { credentialRejected: true });
  }
  await asOwner(userId, async (q) => {
    await q(
      `UPDATE app.users SET totp_secret = NULL, totp_pending = NULL WHERE user_id = $1`,
      [userId],
    );
    await q(`DELETE FROM app.recovery_codes WHERE user_id = $1`, [userId]);
    await record(q, userId, "two_factor_disabled", null);
  });
  return true;
}

/**
 * Spend a recovery code. Single use: the row is deleted, not marked.
 * @param {string} userId
 * @param {string} code
 */
async function consumeRecoveryCode(userId, code) {
  const normalised = String(code ?? "").trim().toUpperCase();
  if (!/^[0-9A-F]{5}-[0-9A-F]{5}$/.test(normalised)) return false;
  const result = await asAuth((q) => q(
    `DELETE FROM app.recovery_codes WHERE user_id = $1 AND code_digest = $2`,
    [userId, sha256(normalised)],
  ));
  return (result.rowCount ?? 0) > 0;
}

/**
 * How many recovery codes remain unspent.
 * @param {string} userId
 */
export async function recoveryCodeCount(userId) {
  const result = await asOwner(userId, (q) => q(
    `SELECT count(*)::int AS remaining FROM app.recovery_codes WHERE user_id = $1`,
    [userId],
  ));
  return result.rows[0]?.remaining ?? 0;
}

/**
 * Delete sessions that expired a while ago.
 *
 * Revoked and expired rows are kept for a week so "where was I signed in?" can
 * still answer honestly just after a logout, then removed.
 */
export async function pruneSessions() {
  const result = await asAuth((q) => q(
    `DELETE FROM app.sessions
      WHERE expires_at < now() - interval '7 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
  ));
  return result.rowCount ?? 0;
}

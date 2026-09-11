/**
 * Who is allowed into the console, and how that is remembered.
 *
 * The threat model here is not the same as the client area's. This console can
 * read every client's rows and end anybody's session, and it is reached by a
 * handful of people who already work here. So:
 *
 * - **A passcode, not an account.** There is no registration, no reset, no
 *   directory. One shared secret, rotated by editing an environment variable
 *   and restarting. Fewer moving parts than an identity system, and nothing to
 *   escalate into — a client's password can never become an operator's.
 * - **The session is a signed statement, not a lookup.** An HMAC over the
 *   operator's name and an expiry, in an HttpOnly cookie. No table, so no query
 *   on every request and nothing to leak. The cost is that a session cannot be
 *   revoked before it expires, which is why they are short.
 * - **The API token never reaches the browser.** The console holds it and
 *   attaches it server-side. A console that hands the browser a key to the
 *   admin API has made every operator's laptop an admin API client.
 *
 * Nothing in here is a substitute for keeping the console off the public
 * internet. It is what stands up when that assumption fails.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The shared passcode. Absent means the console refuses to serve at all. */
const PASSCODE = process.env.OPS_PASSCODE ?? "";

/** Signing key for session cookies. */
const SESSION_SECRET = process.env.OPS_SESSION_SECRET ?? "";

/** How long a signed session lasts. Short: it cannot be revoked early. */
const SESSION_TTL_MS = Number(process.env.OPS_SESSION_TTL_MS ?? 8 * 60 * 60 * 1000);

export const SESSION_COOKIE = "px_ops";
export const CSRF_COOKIE = "px_ops_csrf";

/** Minimum lengths. A secret that is set is not therefore a secret. */
const MIN_PASSCODE = 12;
const MIN_SECRET = 32;

/**
 * Is the console configured well enough to serve?
 *
 * Checked at startup and refused rather than defaulted. A console that invents
 * its own passcode when none is set is a console with a passcode nobody knows
 * they are relying on.
 */
export function configurationProblems(env = process.env) {
  /** @type {string[]} */
  const problems = [];
  const passcode = env.OPS_PASSCODE ?? "";
  const secret = env.OPS_SESSION_SECRET ?? "";
  const token = env.OPS_TOKEN ?? "";

  if (!passcode) problems.push("OPS_PASSCODE is not set");
  else if (passcode.length < MIN_PASSCODE) {
    problems.push(`OPS_PASSCODE is shorter than ${MIN_PASSCODE} characters`);
  }

  if (!secret) problems.push("OPS_SESSION_SECRET is not set");
  else if (secret.length < MIN_SECRET) {
    problems.push(`OPS_SESSION_SECRET is shorter than ${MIN_SECRET} characters`);
  }

  if (!token) problems.push("OPS_TOKEN is not set — the admin API would refuse every call");

  return problems;
}

/* ------------------------------------------------------------- passcodes */

/**
 * Compare a supplied passcode in constant time.
 *
 * Hashed to a fixed width first, so the comparison does not reveal the real
 * passcode's length and `timingSafeEqual` never sees mismatched buffers.
 *
 * @param {string} supplied
 */
export function passcodeMatches(supplied) {
  if (!PASSCODE) return false;
  const a = createHmac("sha256", "passcode").update(String(supplied ?? "")).digest();
  const b = createHmac("sha256", "passcode").update(PASSCODE).digest();
  return timingSafeEqual(a, b);
}

/* --------------------------------------------------------- brute force */

/**
 * Failed sign-in attempts per address.
 *
 * Five in five minutes, then refused. There is one passcode and it does not
 * lock out — locking it would let anybody who can reach the console lock every
 * operator out of it, which is a denial of service with no attacker cost. The
 * address is throttled instead.
 *
 * @type {Map<string, {count: number, until: number}>}
 */
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60 * 1000;

/** @param {string} address */
export function withinAttemptBudget(address) {
  const entry = attempts.get(address);
  if (!entry || Date.now() > entry.until) return true;
  return entry.count < MAX_ATTEMPTS;
}

/** @param {string} address */
export function recordFailedAttempt(address) {
  const now = Date.now();
  const entry = attempts.get(address);
  if (!entry || now > entry.until) {
    attempts.set(address, { count: 1, until: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** @param {string} address */
export function clearAttempts(address) {
  attempts.delete(address);
}

/**
 * How long until this address may try again.
 * @param {string} address
 */
export function retryAfterSeconds(address) {
  const entry = attempts.get(address);
  if (!entry) return 0;
  return Math.max(0, Math.ceil((entry.until - Date.now()) / 1000));
}

/* ---------------------------------------------------------- the session */

/** @param {string} value */
const sign = (value) =>
  createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");

/**
 * Mint a session.
 *
 * The payload is readable by the holder — it is their own name and an expiry,
 * neither of which is a secret. The signature is what makes it unforgeable.
 *
 * @param {string} operator
 */
export function issueSession(operator) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({ operator: String(operator).slice(0, 80), expiresAt }),
    "utf8",
  ).toString("base64url");
  return { value: `${payload}.${sign(payload)}`, expiresAt };
}

/**
 * Read a session cookie back.
 *
 * Returns null for anything that is not a live, correctly signed session. The
 * signature is checked before the payload is parsed and before the expiry is
 * read — trusting a value far enough to parse it is already trusting it.
 *
 * @param {string|undefined} cookie
 * @returns {{operator: string, expiresAt: number}|null}
 */
export function readSession(cookie) {
  if (typeof cookie !== "string" || !cookie.includes(".") || !SESSION_SECRET) return null;

  const index = cookie.lastIndexOf(".");
  const payload = cookie.slice(0, index);
  const signature = cookie.slice(index + 1);

  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims?.expiresAt !== "number" || claims.expiresAt < Date.now()) return null;
    return { operator: String(claims.operator ?? "operator"), expiresAt: claims.expiresAt };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- CSRF */

/**
 * A double-submit token.
 *
 * The cookie is readable by script on this origin, and the same value has to
 * appear in the form. Another origin can cause the browser to send the cookie
 * but cannot read it to put it in the body, so it cannot produce a matching
 * pair. `SameSite=Lax` already blocks the cross-site POST; this is the second
 * mechanism, because the console's buttons end people's sessions.
 */
export const newCsrfToken = () => randomBytes(24).toString("base64url");

/**
 * @param {string|undefined} cookieValue
 * @param {unknown} submitted
 */
export function csrfMatches(cookieValue, submitted) {
  const a = String(cookieValue ?? "");
  const b = String(submitted ?? "");
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/* ------------------------------------------------------------- cookies */

/**
 * Build a Set-Cookie header.
 *
 * `Secure` follows the forwarded protocol for the same reason as the client
 * area's: hard-coding it on breaks local http, hard-coding it off ships a
 * console session in clear over a tunnel.
 *
 * @param {string} name
 * @param {string|null} value Null clears it.
 * @param {{secure: boolean, httpOnly?: boolean, maxAgeSeconds?: number}} options
 */
export function cookieHeader(name, value, { secure, httpOnly = true, maxAgeSeconds }) {
  const attributes = ["Path=/", "SameSite=Lax"];
  if (httpOnly) attributes.push("HttpOnly");
  if (secure) attributes.push("Secure");

  if (value === null) {
    return `${name}=; ${attributes.join("; ")}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
  if (maxAgeSeconds !== undefined) attributes.push(`Max-Age=${Math.max(0, maxAgeSeconds)}`);
  return `${name}=${encodeURIComponent(value)}; ${attributes.join("; ")}`;
}

/**
 * Read one cookie from a request header.
 * @param {string|undefined} header
 * @param {string} name
 */
export function readCookie(header, name) {
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/**
 * # 19-client-api
 *
 * The outward-facing surface. REST for the client area.
 *
 * ## What this service is not allowed to do
 *
 * - **Compute a financial figure.** It forwards what the core computed, and
 *   when the core has nothing, it returns `null` plus the reason (INV-183).
 * - **Turn money into a number.** Amounts are decimal strings end to end.
 * - **Accept a mutating request without an idempotency key** (INV-181).
 * - **Move money to or from the outside world.** Funding endpoints record an
 *   intent and return 503 with the gate that is blocking, because
 *   `15-reconciliation` and `17-payments` are ungated. Demo capital is a
 *   different thing entirely: no payment rail is involved, the ledger draws it
 *   from the demo pot and settles it (INV-034), so a demo deposit is live.
 *
 * Account *metadata* is stored here for now (see `db.js`); it moves to
 * `04-account` once that module passes its gates.
 */

import http from "node:http";

import * as accounts from "./accounts.js";
import * as auth from "./auth.js";
import {
  close as closeDb, isolationStatus, migrate, productionSafetyProblems,
} from "./db.js";
import { delivery, startOutboxWorker } from "./mailer.js";
import * as admin from "./admin.js";
import { HttpError, requireAmount } from "./money.js";
import { forward, upstream, UPSTREAM } from "./core.js";

const PORT = Number(process.env.PORT ?? 8000);
const SERVICE = "client-api";
const MODULE_ID = "19-client-api";
const TIER = "T4";


/**
 * Identity.
 *
 * `auth.js` now issues real sessions, so a request that carries one is
 * attributed to the person who signed in. A request that carries none still
 * resolves to a single development owner, and that is a deliberate, stated
 * choice rather than an oversight:
 *
 * - `16-kyc-aml` has not passed its gates, so there is no verified identity to
 *   require, and refusing every anonymous request would mean the platform could
 *   not be demonstrated at all.
 * - The gate scripts and the end-to-end suite drive this API directly, without
 *   a browser or a session, and asserting on *financial* refusals. Turning
 *   those into 401s would replace a suite that proves the money rules with one
 *   that proves a login form.
 *
 * Set `AUTH_REQUIRED=true` to drop the fallback and refuse anonymous requests
 * outright. That is what a deployment would do; the default is what a
 * demonstrable reference implementation needs.
 *
 * The important half is that a signed-in request is *never* attributed to the
 * development owner, and a session never widens access to another person's
 * rows — `owner_id` is the session's user id, and every query is scoped by it.
 */
const DEV_OWNER = "dev-owner-0001";
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "true";

/**
 * Honour `x-client-id` as an identity.
 *
 * Defaults on, because the gate scripts and the end-to-end suite drive this API
 * as several distinct owners without a browser. It is an impersonation
 * primitive and is named as one: startup refuses it in production.
 */
const TRUST_CLIENT_ID_HEADER = process.env.TRUST_CLIENT_ID_HEADER !== "false";

/**
 * Expose the outbox over HTTP.
 *
 * Without an email provider the outbox holds live password-reset links, so
 * reading it is equivalent to reading somebody's inbox. On by default in
 * development because it is the only way to complete a reset here at all, and
 * refused in production.
 */
const EXPOSE_OUTBOX = process.env.EXPOSE_OUTBOX !== "false" && process.env.NODE_ENV !== "production";

/** Paths that are reachable without a session even when AUTH_REQUIRED is set. */
const PUBLIC_PATHS = new Set([
  "/health", "/metrics", "/v1/status", "/v1/sessions", "/v1/auth/register", "/v1/auth/login",
  "/v1/auth/logout", "/v1/auth/session", "/v1/auth/meta",
  // Recovering an account is something you do precisely because you cannot
  // sign in, so these cannot be behind a session.
  "/v1/auth/password/forgot", "/v1/auth/password/reset", "/v1/auth/email/verify",
]);

/**
 * The bearer token on a request, if any.
 *
 * Only the Authorization header is read. A cookie is deliberately not accepted
 * here: the web app holds the cookie and converts it into this header when it
 * proxies, which keeps the API free of any cookie-shaped CSRF surface.
 *
 * @param {http.IncomingMessage} req
 */
function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Resolve the caller.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<{owner: string, session: Awaited<ReturnType<typeof auth.sessionFromToken>>}>}
 */
async function identify(req) {
  const session = await auth.sessionFromToken(bearerToken(req));
  if (session) return { owner: session.user.userId, session };

  // `x-client-id` lets one machine hold several distinct owners without signing
  // in, which the gate scripts and the end-to-end suite rely on. It is also, by
  // construction, a way to name any owner you like — so it is honoured only when
  // switched on, and `productionSafetyProblems()` refuses to start a production
  // process that has switched it on. It is ignored outright the moment a real
  // session is present, so it can never override one.
  const header = req.headers["x-client-id"];
  if (TRUST_CLIENT_ID_HEADER && typeof header === "string" && header) {
    return { owner: header, session: null };
  }
  return { owner: DEV_OWNER, session: null };
}

/**
 * The session, or a 401. For endpoints that act on a person's own account.
 * @param {Awaited<ReturnType<typeof identify>>} identity
 */
function requireSession(identity) {
  if (!identity.session) {
    throw new HttpError(401, "Sign in to continue.");
  }
  return identity.session;
}

/** @type {Map<string, number>} */
const metrics = new Map();
/** @param {string} name */
const incr = (name) => metrics.set(name, (metrics.get(name) ?? 0) + 1);

/** @type {Map<string, {count: number, resetAt: number}>} */
const rateLimits = new Map();

/**
 * Requests per client per minute.
 *
 * Sized for what the product actually does, not for a page of static content.
 * An open trading terminal polls the quote at 800ms, the account at 2s and the
 * chart at 3s — about 120 requests a minute, per tab. At the old limit of 240 a
 * client with two terminals open throttled themselves, which is a denial of
 * service the platform performs on its own users.
 *
 * This is still a bound, not an absence of one: it admits roughly eight
 * concurrent terminals before it bites, and a scripted abuser hits it in
 * seconds.
 */
const RATE_LIMIT = 1_200;
const RATE_WINDOW_MS = 60_000;

/**
 * Addresses exempt from the *general* request limit.
 *
 * Empty by default, and refused outright in production.
 *
 * This exists for one reason: the gate suite. G4, G8 and G9 together issue
 * several hundred requests in a few seconds, all from one address, and 1 200 a
 * minute is sized for a browser rather than a test harness — so the gates
 * throttled each other and reported unrelated invariants as broken. The limiter
 * was behaving correctly; the traffic really was from one client.
 *
 * The alternative was raising the limit for everybody, which weakens a live
 * control to make a test pass. This is narrower, visible in the logs at
 * startup, and impossible to leave on in production.
 *
 * It exempts nothing from the *sign-in failure* budget — password guessing is
 * throttled here exactly as it is anywhere else, which is what G8 relies on.
 */
const RATE_LIMIT_EXEMPT = new Set(
  (process.env.RATE_LIMIT_EXEMPT_IPS ?? "").split(",").map((ip) => ip.trim()).filter(Boolean),
);

/** @param {string} key */
function withinRateLimit(key) {
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT;
}

/**
 * A separate budget for credential endpoints, counted in **failures**.
 *
 * Keyed on the source address rather than the account, because an attacker
 * spraying one password across many accounts never trips a per-account lockout.
 * That is the gap this closes; the lockout in auth.js closes the other one.
 *
 * The important detail is that only failures are counted. An earlier version
 * counted every attempt, which meant a shared egress address — an office behind
 * NAT, a mobile carrier's CGNAT, a school — could exhaust the budget with
 * nothing but people successfully signing in on Monday morning, and the
 * platform would lock out the whole building. A person who signs in correctly
 * has not consumed anything; a script guessing passwords consumes one per
 * guess, which is exactly the traffic this is meant to bound.
 *
 * @type {Map<string, {failures: number, resetAt: number}>}
 */
const authFailures = new Map();
const AUTH_FAILURE_LIMIT = Number(process.env.AUTH_FAILURE_LIMIT ?? 30);

/**
 * The endpoints where a credential is presented and checked.
 *
 * Only these are gated by the failure budget. Registering an account, asking
 * for a reset link, reading a session and signing out are not credential
 * attempts, and throttling them on a spent budget meant one person guessing
 * passwords behind a shared address stopped everyone else on that address from
 * *signing up* — a denial of service performed on bystanders, by a control
 * meant to protect them.
 *
 * It also made the gate suite poison its own next run: G8 deliberately exhausts
 * this budget, and the following run could not create the accounts it needed.
 */
const CREDENTIAL_PATHS = new Set([
  "/v1/auth/login",
  "/v1/auth/password",
  "/v1/auth/password/reset",
  "/v1/auth/totp/confirm",
  "/v1/auth/totp/disable",
]);

/**
 * Addresses whose `x-forwarded-for` is believed.
 *
 * Defaults to loopback, which is where the web app sits in every deployment of
 * this stack. Set `TRUSTED_PROXY_IPS` to the real proxy addresses anywhere else.
 */
const TRUSTED_PROXIES = new Set(
  (process.env.TRUSTED_PROXY_IPS ?? "127.0.0.1,::1,::ffff:127.0.0.1")
    .split(",").map((ip) => ip.trim()).filter(Boolean),
);

/**
 * The source address a rate limit is charged to.
 *
 * `x-forwarded-for` is honoured **only from a trusted proxy**. It used to be
 * honoured from anyone, which made the per-address sign-in budget worthless: a
 * caller could send a different forwarded address on every request and never
 * accumulate a single failure against themselves. The header is attacker
 * controlled by definition — the only thing that is not is the socket the
 * request actually arrived on.
 *
 * Behind the web app every request does share one socket address, which is why
 * the header exists at all; the fix is to believe it from the proxy rather than
 * from the client.
 *
 * @param {http.IncomingMessage} req
 */
function sourceAddress(req) {
  const peer = req.socket.remoteAddress ?? "";
  const forwarded = req.headers["x-forwarded-for"];

  if (TRUSTED_PROXIES.has(peer) && typeof forwarded === "string") {
    // The left-most entry is the original client; the rest are proxies it
    // passed through. Only the first is of interest, and only from a peer we
    // already decided to believe.
    const client = forwarded.split(",")[0]?.trim();
    if (client) return client;
  }
  return peer || "anonymous";
}

/**
 * Has this address spent its failure budget?
 * @param {http.IncomingMessage} req
 */
function withinAuthRateLimit(req) {
  const entry = authFailures.get(sourceAddress(req));
  if (!entry || Date.now() > entry.resetAt) return true;
  return entry.failures < AUTH_FAILURE_LIMIT;
}

/**
 * Charge one failure to this address.
 * @param {http.IncomingMessage} req
 */
function recordAuthFailure(req) {
  const key = sourceAddress(req);
  const now = Date.now();
  const entry = authFailures.get(key);
  if (!entry || now > entry.resetAt) {
    authFailures.set(key, { failures: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  entry.failures += 1;
}

/**
 * @param {string} level
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 */
function log(level, message, fields = {}) {
  process.stdout.write(
    JSON.stringify({ ts: Date.now(), level, service: SERVICE, module_id: MODULE_ID, tier: TIER, message, ...fields }) + "\n",
  );
}

/** @param {http.IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk) => {
      if (refused) return;
      size += chunk.length;
      if (size > 64 * 1024) {
        refused = true;
        // Stop reading, but do NOT destroy the socket: the handler above still
        // has to write the 413, and destroying it here left the client with no
        // response at all — indistinguishable from the service having fallen
        // over. `pause()` stops consuming the rest of the upload while the
        // refusal is written. Found by the G8 fuzzer, which saw a 200KB body
        // return nothing rather than a refusal.
        req.pause();
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return reject(new HttpError(400, "body is not valid JSON"));
      }

      // `null`, `[]`, `"a string"` and `7` are all valid JSON and none of them
      // is a request. Every handler downstream reads `body.something`, and on a
      // null that throws — which the edge then reports as a 500, meaning "we did
      // not anticipate this" rather than "that is not a request". Found by the
      // G8 fuzzer: a bare `null` body turned every POST endpoint into a 500.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return reject(new HttpError(400, "body must be a JSON object"));
      }

      // Prototype pollution: `__proto__` arriving as a normal key is harmless
      // under JSON.parse (it is an own property, not the prototype), but these
      // objects are spread and merged downstream, and a key named `__proto__`
      // or `constructor` reaching an assignment is the whole vulnerability
      // class. Dropped rather than refused: they are never meaningful input.
      for (const dangerous of ["__proto__", "constructor", "prototype"]) {
        if (Object.hasOwn(parsed, dangerous)) delete parsed[dangerous];
      }

      resolve(parsed);
    });
    req.on("error", () => reject(new HttpError(400, "request failed")));
  });
}

/**
 * Market-data parameters, validated at the edge.
 *
 * These used to be forwarded verbatim. A junk symbol then reached market-data,
 * which refused it, and `upstream()` turned that refusal into a **502** — the
 * edge telling a client "the market data service is broken" when in fact the
 * client had asked for `../../etc`. A 502 also reads to every monitor as an
 * outage, so a scripted bad request looked like a failing dependency.
 *
 * Found by the G8 fuzzer, which flagged six query shapes returning 5xx.
 *
 * @param {URL} url
 * @returns {URLSearchParams}
 */
function marketDataQuery(url) {
  const query = new URLSearchParams();

  const symbol = url.searchParams.get("symbol");
  if (symbol !== null) {
    if (!/^[A-Z]{3,12}$/.test(symbol)) {
      throw new HttpError(400, "symbol must be 3-12 uppercase letters");
    }
    query.set("symbol", symbol);
  }

  const interval = url.searchParams.get("interval");
  if (interval !== null) {
    if (!/^[0-9]{1,3}[smhdMW]$/.test(interval)) {
      throw new HttpError(400, "interval must look like 1m, 15m, 1h or 1d");
    }
    query.set("interval", interval);
  }

  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    // Bounded as well as numeric: an unbounded limit is a way to ask one
    // request to allocate the whole series.
    if (!/^[0-9]{1,4}$/.test(limit) || Number(limit) < 1 || Number(limit) > 5000) {
      throw new HttpError(400, "limit must be a whole number between 1 and 5000");
    }
    query.set("limit", limit);
  }

  return query;
}

/**
 * @param {http.IncomingMessage} req
 * @returns {string}
 */
function requireIdempotencyKey(req) {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 8) {
    throw new HttpError(
      400,
      "Mutating requests require an Idempotency-Key header of at least 8 characters. " +
        "Retries must be safe; financial effects are not repeatable (INV-102).",
    );
  }
  return key;
}

/**
 * Gate chains, so the interface can say precisely what is blocking.
 *
 * Only funding remains: `03-ledger`, `09-risk`, `10-oms` and `11-execution` are
 * built, so balances and orders are real. Moving real money still needs
 * `15-reconciliation` and `17-payments`, and until it does, this string is what
 * the client area says instead of pretending.
 */
const GATES = {
  funding: "Funding requires 15-reconciliation and 17-payments to pass their gates.",
};

/**
 * Credentials, sessions and second factors.
 *
 * Split out of `route` because it is the one part of this service with its own
 * threat model: everything here is reachable before anyone has proven who they
 * are, so each handler states what it refuses and why.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} path
 * @param {string} method
 * @param {URL} url
 * @param {Awaited<ReturnType<typeof identify>>} identity
 */
async function routeAuth(req, res, path, method, url, identity) {
  /** What the registration and profile forms need in order to render. */
  if (path === "/v1/auth/meta" && method === "GET") {
    return send(res, 200, {
      countries: auth.COUNTRIES,
      currencies: auth.BASE_CURRENCIES,
      // So the reset page can say "check your inbox" only when that is true,
      // and say what actually happens when it is not.
      emailDelivery: delivery.enabled,
    });
  }

  // Who am I? Answers for everyone, signed in or not, because the interface
  // needs to render a signed-out state as confidently as a signed-in one.
  if (path === "/v1/auth/session" && method === "GET") {
    if (!identity.session) {
      return send(res, 200, { authenticated: false, user: null });
    }
    return send(res, 200, {
      authenticated: true,
      user: identity.session.user,
      expiresAt: identity.session.expiresAt,
      sessionId: identity.session.sessionId,
    });
  }

  if (path === "/v1/auth/register" && method === "POST") {
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));
    const user = await auth.register({
      email: body.email,
      password: body.password,
      name: body.name,
      country: body.country,
      baseCurrency: body.baseCurrency,
      acceptedTerms: body.acceptedTerms,
      ip: sourceAddress(req),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    });

    // Queued, not sent — there is no provider. The account works meanwhile:
    // gating sign-in on a confirmation nobody can receive would make every
    // account unusable.
    await auth.requestEmailVerification(user.userId, user.email, sourceAddress(req));

    // Registering signs you in. Making someone type the password they just
    // chose, into a second form, proves nothing — they demonstrably have it.
    const session = await auth.createSession(user.userId, {
      remember: body.remember === true,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      ip: req.socket.remoteAddress ?? undefined,
    });

    incr("projectx_registrations_total");
    // The email is not logged. It is the identifier of a real person, and a log
    // line is the easiest place for one to escape from.
    log("info", "account registered", { userId: user.userId, country: user.country });

    return send(res, 201, { user, token: session.token, expiresAt: session.expiresAt });
  }

  if (path === "/v1/auth/login" && method === "POST") {
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));
    try {
      const result = await auth.login({
        email: body.email,
        password: body.password,
        totp: body.totp,
        remember: body.remember === true,
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
        ip: req.socket.remoteAddress ?? undefined,
      });
      incr("projectx_logins_total");
      log("info", "signed in", { userId: result.user.userId });
      return send(res, 200, {
        user: result.user,
        token: result.token,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      // "This account has 2FA, send me the code" is a distinct outcome from
      // "those credentials are wrong", and the interface has to tell them apart
      // to know whether to show the code field. It is only ever reached after
      // the password has already been verified, so it reveals nothing.
      if (error instanceof HttpError && error.message === "two_factor_required") {
        return send(res, 401, {
          error: "two_factor_required",
          detail: "Enter the six-digit code from your authenticator app.",
        });
      }
      incr("projectx_failed_logins_total");
      throw error;
    }
  }

  if (path === "/v1/auth/logout" && method === "POST") {
    await auth.logout(bearerToken(req));
    incr("projectx_logouts_total");
    // Always 200. Whether there was a session to end is not the caller's
    // business, and a signed-out client asking to sign out has got what it wanted.
    return send(res, 200, { signedOut: true });
  }

  if (path === "/v1/auth/password" && method === "POST") {
    const session = requireSession(identity);
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));
    const result = await auth.changePassword(session.user.userId, session.sessionId, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      ip: sourceAddress(req),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    });
    log("info", "password changed", {
      userId: session.user.userId,
      revokedSessions: result.revokedSessions,
    });
    // `token` is the rotated credential for this same session. The web app
    // swaps the cookie for it; an API client replaces its bearer token.
    return send(res, 200, {
      changed: true,
      revokedSessions: result.revokedSessions,
      token: result.token,
      expiresAt: result.expiresAt,
      detail:
        result.revokedSessions > 0
          ? `Your password was changed and ${result.revokedSessions} other session${
              result.revokedSessions === 1 ? " was" : "s were"
            } signed out.`
          : "Your password was changed.",
    });
  }

  if (path === "/v1/auth/sessions" && method === "GET") {
    const session = requireSession(identity);
    return send(res, 200, {
      sessions: await auth.listSessions(session.user.userId, session.sessionId),
    });
  }

  if (path === "/v1/auth/sessions/revoke" && method === "POST") {
    const session = requireSession(identity);
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));

    if (body.all === true) {
      const count = await auth.revokeOtherSessions(session.user.userId, session.sessionId);
      return send(res, 200, {
        revoked: count,
        detail:
          count === 0
            ? "There were no other sessions to end."
            : `Signed out of ${count} other session${count === 1 ? "" : "s"}.`,
      });
    }

    // Revoking your own session is allowed but is really a sign-out, and
    // saying so is kinder than silently logging someone out of the page they
    // are looking at.
    if (body.sessionId === session.sessionId) {
      throw new HttpError(400, "That is this session. Use Sign out to end it.");
    }

    await auth.revokeSession(session.user.userId, String(body.sessionId ?? ""));
    return send(res, 200, { revoked: 1, detail: "That session was signed out." });
  }

  // -------------------------------------------------- reset and verification
  if (path === "/v1/auth/password/forgot" && method === "POST") {
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));
    const result = await auth.requestPasswordReset({
      email: body.email,
      ip: sourceAddress(req),
    });
    incr("projectx_password_resets_requested_total");
    // 200 whether or not the address exists. Anything else answers "does this
    // person bank here?" for anyone who asks.
    return send(res, 200, result);
  }

  // Checked before the form is shown, so a stale link is refused up front
  // rather than after somebody has typed a new password twice.
  if (path === "/v1/auth/password/reset" && method === "GET") {
    return send(res, 200, await auth.checkResetToken(url.searchParams.get("token")));
  }

  if (path === "/v1/auth/password/reset" && method === "POST") {
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));
    const result = await auth.completePasswordReset({
      token: body.token,
      newPassword: body.newPassword,
      ip: sourceAddress(req),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    });
    incr("projectx_password_resets_completed_total");
    log("info", "password reset completed");
    return send(res, 200, result);
  }

  if (path === "/v1/auth/email/verify" && method === "POST") {
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));
    return send(res, 200, await auth.completeEmailVerification({
      token: body.token,
      ip: sourceAddress(req),
    }));
  }

  if (path === "/v1/auth/email/verify/request" && method === "POST") {
    const session = requireSession(identity);
    if (session.user.emailVerified) {
      throw new HttpError(409, "That address is already confirmed.");
    }
    await auth.requestEmailVerification(
      session.user.userId, session.user.email, sourceAddress(req),
    );
    return send(res, 200, {
      sent: true,
      detail: "A confirmation link has been created for your address.",
    });
  }

  // ------------------------------------------------------------ audit trail
  if (path === "/v1/auth/events" && method === "GET") {
    const session = requireSession(identity);
    return send(res, 200, {
      events: await auth.securityHistory(session.user.userId, Number(url.searchParams.get("limit") ?? 20)),
    });
  }

  // The outbox. Reading it is reading somebody's inbox, so it is refused unless
  // explicitly enabled and never available in production.
  if (path === "/v1/auth/outbox" && method === "GET") {
    if (!EXPOSE_OUTBOX) {
      throw new HttpError(
        404,
        "The outbox is not exposed. It holds live password-reset links, so it is " +
        "readable only where EXPOSE_OUTBOX is set and never in production.",
      );
    }
    return send(res, 200, {
      messages: await auth.readOutbox(url.searchParams.get("to") ?? undefined),
      delivery: delivery.driver,
      note: delivery.enabled
        ? `Messages here are delivered by MAIL_DRIVER=${delivery.driver}; a row with ` +
          "a blocked_reason is one that failed and will be retried."
        : delivery.noProviderReason,
    });
  }

  // ------------------------------------------------------- second factor
  if (path === "/v1/auth/totp/begin" && method === "POST") {
    const session = requireSession(identity);
    if (session.user.twoFactorEnabled) {
      throw new HttpError(409, "Two-factor authentication is already enabled on this account.");
    }
    const enrolment = await auth.beginTotpEnrolment(session.user.userId, session.user.email);
    return send(res, 200, enrolment);
  }

  if (path === "/v1/auth/totp/confirm" && method === "POST") {
    const session = requireSession(identity);
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));
    const result = await auth.confirmTotpEnrolment(session.user.userId, String(body.code ?? ""));
    log("info", "two-factor enabled", { userId: session.user.userId });
    return send(res, 200, {
      enabled: true,
      ...result,
      detail:
        "Two-factor authentication is on. Store these recovery codes somewhere safe — " +
        "they are shown once and are the only way in if you lose your authenticator.",
    });
  }

  if (path === "/v1/auth/totp/disable" && method === "POST") {
    const session = requireSession(identity);
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));
    await auth.disableTotp(session.user.userId, body.password);
    log("info", "two-factor disabled", { userId: session.user.userId });
    return send(res, 200, { enabled: false, detail: "Two-factor authentication is off." });
  }

  return send(res, 404, { error: "not_found", path });
}

/**
 * The operator surface. See `admin.js` for why it is reached differently from
 * everything else in this service.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} path
 * @param {string} method
 * @param {URL} url
 */
async function routeAdmin(req, res, path, method, url) {
  const operator = admin.requireOperator(req);
  incr("projectx_admin_requests_total");

  if (path === "/v1/admin/overview" && method === "GET") {
    return send(res, 200, await admin.overview());
  }

  if (path === "/v1/admin/users" && method === "GET") {
    return send(res, 200, {
      users: await admin.listUsers({
        q: url.searchParams.get("q") ?? "",
        limit: Number(url.searchParams.get("limit") ?? 50),
        sort: url.searchParams.get("sort") ?? "recent",
      }),
    });
  }

  const userPath = path.match(/^\/v1\/admin\/users\/([^/]+)(?:\/(.+))?$/);
  if (userPath) {
    const userId = decodeURIComponent(userPath[1] ?? "");
    const action = userPath[2] ?? "";

    if (!action && method === "GET") {
      return send(res, 200, await admin.userDetail(userId));
    }

    if (method === "POST") {
      // Every one of these is recorded against the person it affected, with the
      // operator named on the row.
      switch (action) {
        case "revoke-sessions":
          log("warn", "operator revoked sessions", { operator, userId });
          return send(res, 200, await admin.revokeAllSessions(userId, operator));
        case "unlock":
          log("warn", "operator cleared a lockout", { operator, userId });
          return send(res, 200, await admin.unlockUser(userId, operator));
        case "suspend":
          log("warn", "operator suspended an account", { operator, userId });
          return send(res, 200, await admin.setUserStatus(userId, "suspended", operator));
        case "restore":
          log("warn", "operator restored an account", { operator, userId });
          return send(res, 200, await admin.setUserStatus(userId, "active", operator));
        case "clear-two-factor":
          log("warn", "operator removed a second factor", { operator, userId });
          return send(res, 200, await admin.clearTwoFactor(userId, operator));
        default:
          throw new HttpError(404, "no such operator action");
      }
    }
  }

  if (path === "/v1/admin/accounts" && method === "GET") {
    return send(res, 200, {
      accounts: await admin.allAccounts({ limit: Number(url.searchParams.get("limit") ?? 200) }),
    });
  }

  if (path === "/v1/admin/audit" && method === "GET") {
    return send(res, 200, {
      events: await admin.auditTrail({
        event: url.searchParams.get("event") ?? "",
        limit: Number(url.searchParams.get("limit") ?? 100),
      }),
      names: await admin.auditEventNames(),
    });
  }

  if (path === "/v1/admin/outbox" && method === "GET") {
    return send(res, 200, {
      messages: await admin.outbox({
        state: url.searchParams.get("state") ?? "",
        limit: Number(url.searchParams.get("limit") ?? 100),
      }),
      delivery: delivery.driver,
    });
  }

  if (path === "/v1/admin/isolation" && method === "GET") {
    return send(res, 200, await admin.isolation());
  }

  return send(res, 404, { error: "not_found", path });
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  incr("projectx_http_requests_total");

  if (path === "/health") {
    return send(res, 200, { status: "healthy", service: SERVICE, module_id: MODULE_ID, tier: TIER });
  }

  if (path === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    let body = "";
    for (const [name, value] of metrics) {
      body += `# TYPE ${name} counter\n`;
      body += `${name}{service="${SERVICE}",module_id="${MODULE_ID}",tier="${TIER}"} ${value}\n`;
    }
    return res.end(body);
  }

  // ------------------------------------------------------------- operator
  // Before identity resolution: these are not a client's requests, they are
  // reached with a shared secret, and a client session is never an operator
  // credential however senior the person holding it.
  if (path.startsWith("/v1/admin/")) {
    return await routeAdmin(req, res, path, method, url);
  }

  const identity = await identify(req);
  const owner = identity.owner;
  const clientKey = String(
    identity.session?.user.userId ?? req.headers["x-client-id"] ?? req.socket.remoteAddress ?? "anonymous",
  );
  if (!RATE_LIMIT_EXEMPT.has(sourceAddress(req)) && !withinRateLimit(clientKey)) {
    incr("projectx_rate_limited_total");
    return send(res, 429, { error: "rate_limited", retry_after_seconds: 60 });
  }

  if (AUTH_REQUIRED && !identity.session && !PUBLIC_PATHS.has(path)) {
    return send(res, 401, { error: "unauthenticated", detail: "Sign in to continue." });
  }

  // ------------------------------------------------------------------ auth
  // Sign-in attempts get their own, much tighter budget. The global rate limit
  // is sized for a trading terminal polling quotes; applying that to a login
  // form would allow twelve hundred password guesses a minute, which is not a
  // limit at all. The per-account lockout in auth.js is the other half of this:
  // this bounds an attacker spraying many accounts, that one bounds an attacker
  // grinding a single account.
  if (path.startsWith("/v1/auth/")) {
    if (method === "POST" && CREDENTIAL_PATHS.has(path) && !withinAuthRateLimit(req)) {
      incr("projectx_auth_rate_limited_total");
      return send(res, 429, {
        error: "rate_limited",
        detail: "Too many attempts from this address. Wait a minute and try again.",
        retry_after_seconds: 60,
      });
    }
    return await routeAuth(req, res, path, method, url, identity);
  }

  // ---------------------------------------------------------------- status
  if (path === "/v1/status") {
    const names = ["ledger", "oms", "pricing", "market-data"];
    const bases = [UPSTREAM.ledger, UPSTREAM.oms, UPSTREAM.pricing, UPSTREAM.marketData];
    const results = await Promise.allSettled(bases.map((b) => upstream(b, "/health")));
    /** @type {Record<string, string>} */
    const core = {};
    results.forEach((r, i) => { core[String(names[i])] = r.status === "fulfilled" ? "healthy" : "unavailable"; });
    const tradable = Object.values(core).every((v) => v === "healthy");
    return send(res, tradable ? 200 : 503, { core, tradable });
  }

  if (path === "/v1/quote") {
    const query = marketDataQuery(url);
    const symbol = query.get("symbol");
    return send(res, 200, await upstream(
      UPSTREAM.pricing,
      `/v1/quote${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""}`,
    ));
  }

  // ---------------------------------------------------------- market data
  // Forwarded verbatim. Prices are decimal strings the whole way; this file
  // never parses one, which is what INV-180 and P8 amount to in practice.
  if (path === "/v1/instruments") {
    return send(res, 200, await upstream(UPSTREAM.marketData, "/v1/instruments"));
  }

  if (path === "/v1/quotes") {
    return send(res, 200, await upstream(UPSTREAM.marketData, "/v1/quotes"));
  }

  if (path === "/v1/sessions") {
    // Where every instrument's market stands: open or closed, and when that
    // next changes (INV-053). Forwarded verbatim.
    return send(res, 200, await upstream(UPSTREAM.marketData, "/v1/sessions"));
  }

  if (path === "/v1/candles") {
    const query = marketDataQuery(url);
    // Required rather than defaulted. Without it market-data refuses, and
    // `upstream()` reports that refusal as a 502 — the edge blaming a
    // dependency for a request that never named an instrument.
    if (!query.get("symbol")) throw new HttpError(400, "symbol is required");
    return send(res, 200, await upstream(UPSTREAM.marketData, `/v1/candles?${query}`));
  }

  // ------------------------------------------------------ trading accounts
  if (path === "/v1/trading-accounts" && method === "GET") {
    const result = await forward(UPSTREAM.ledger, `/v1/accounts?owner=${encodeURIComponent(owner)}`);
    return send(res, result.status, result.body);
  }

  if (path === "/v1/trading-accounts" && method === "POST") {
    // The terminal's "open a demo account" button. Same door as /v1/accounts
    // (INV-033): one number, one ledger account, one client-area record.
    requireIdempotencyKey(req);
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));
    const account = await accounts.open(owner, {
      mode: "demo",
      nickname: typeof body.nickname === "string" ? body.nickname : "Demo account",
      leverage: typeof body.leverage === "number" ? body.leverage : 500,
    });
    incr("projectx_demo_accounts_opened_total");
    log("info", "demo account opened", { account: account.accountNumber });
    return send(res, 201, account);
  }

  const tradingAccount = path.match(/^\/v1\/trading-accounts\/(\d+)(?:\/(state|orders|statement))?$/);
  if (tradingAccount && method === "GET") {
    const number = tradingAccount[1] ?? "";
    const view = tradingAccount[2] ?? "";
    const result = await forward(UPSTREAM.ledger, `/v1/accounts/${number}${view ? `/${view}` : ""}`);
    return send(res, result.status, result.body);
  }

  // -------------------------------------------------------------- trading
  if (path === "/v1/positions/close" && method === "POST") {
    const key = requireIdempotencyKey(req);
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));
    const result = await forward(UPSTREAM.oms, "/v1/positions/close", {
      method: "POST",
      idempotencyKey: key,
      body: { account: String(body.account ?? ""), symbol: String(body.symbol ?? "") },
    });
    incr("projectx_position_closes_total");
    return send(res, result.status, result.body);
  }

  // -------------------------------------------------------------- accounts
  if (path === "/v1/accounts/meta" && method === "GET") {
    return send(res, 200, {
      types: accounts.ACCOUNT_TYPES,
      leverages: accounts.LEVERAGES,
      currencies: accounts.CURRENCIES,
      platforms: accounts.PLATFORMS,
    });
  }

  if (path === "/v1/accounts" && method === "GET") {
    // Seeding deliberately does NOT happen here. A read handler that writes is
    // a read handler that races: the accounts page issues two of these
    // concurrently, both could observe an empty table, and both would seed.
    const list = await accounts.list(owner, {
      mode: url.searchParams.get("mode") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
    });
    return send(res, 200, { accounts: sortAccounts(list, url.searchParams.get("sort")) });
  }

  if (path === "/v1/accounts" && method === "POST") {
    requireIdempotencyKey(req);
    const body = await readBody(req);
    const account = await accounts.open(owner, /** @type {Record<string, unknown>} */ (body));
    incr("projectx_accounts_opened_total");
    if (account.mode === "demo") incr("projectx_demo_accounts_opened_total");
    log("info", "account opened", { account: account.accountNumber, type: account.accountType });
    return send(res, 201, account);
  }

  const accountAction = path.match(/^\/v1\/accounts\/(\d+)\/(archive|restore)$/);
  if (accountAction && method === "POST") {
    // The regex guarantees both groups, but the type system cannot know that.
    const number = accountAction[1] ?? "";
    const action = accountAction[2] ?? "";
    const result = action === "archive"
      ? await accounts.archive(owner, number, "Archived by the account holder")
      : await accounts.restore(owner, number);
    log("info", `account ${action}d`, { account: number });
    return send(res, 200, result);
  }

  // ---------------------------------------------------------------- wallet
  if (path === "/v1/wallet") {
    // The wallet is a projection over the ledger journal, and the ledger now
    // holds demo balances. Where a figure exists it is forwarded; where it does
    // not, the answer is still null with a reason — never a substituted zero
    // (INV-183). The edge computes nothing either way (INV-180).
    /** @type {{ok: boolean, status: number, body: {accounts?: import("./accounts.js").TradingAccount[]}}} */
    let accounts;
    try {
      accounts = await forward(UPSTREAM.ledger, `/v1/accounts?owner=${encodeURIComponent(owner)}`);
    } catch {
      return send(res, 200, {
        balance: null,
        currency: "USD",
        unavailableReason: "The financial core is unreachable, so no balance can be read.",
        blockedBy: "03-ledger",
      });
    }

    const list = accounts.body.accounts ?? [];
    const primary = list[0];
    if (!primary) {
      return send(res, 200, {
        balance: null,
        currency: "USD",
        unavailableReason:
          "No trading account has been opened yet, so there is no balance to report.",
        blockedBy: null,
      });
    }

    /** @type {{ok: boolean, status: number, body: {valuation?: import("./accounts.js").Valuation}}} */
    const state = await forward(UPSTREAM.ledger, `/v1/accounts/${primary.accountNumber}/state`);
    const valuation = state.ok ? state.body.valuation : undefined;
    return send(res, 200, {
      balance: valuation?.balance ?? null,
      equity: valuation?.equity ?? null,
      currency: primary.currency ?? "USD",
      accountNumber: primary.accountNumber,
      accountCount: list.length,
      unavailableReason: valuation ? null : "The financial core could not value this account.",
      blockedBy: valuation ? null : "03-ledger",
    });
  }

  // --------------------------------------------------------------- funding
  const funding = path.match(/^\/v1\/funding\/(deposit|withdrawal|transfer)$/);
  if (funding && method === "POST") {
    const kind = funding[1];
    const key = requireIdempotencyKey(req);
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));

    const amount = requireAmount(body.amount, "amount");
    const method_ = String(body.method ?? (kind === "transfer" ? "internal" : "card"));
    const currency = String(body.currency ?? "USD");

    // Demo capital is the one kind of funding that is live. It is chosen by
    // the target account's mode, not by a method the client names: a real
    // account asking for "demo" funds is refused, and a demo account asking
    // for a card deposit gets demo capital, because that is the only thing a
    // demo account can ever hold.
    if (kind === "deposit" && typeof body.toAccount === "string" && /^\d{6,12}$/.test(body.toAccount)) {
      const target = await accounts.list(owner, { status: "active" });
      const account = target.find((a) => a.accountNumber === body.toAccount);
      if (account?.mode === "demo") {
        const settled = await accounts.demoDeposit(owner, body.toAccount, amount, key);
        incr("projectx_demo_credits_total");
        log("info", "demo capital issued", { account: body.toAccount, amount });
        return send(res, 200, {
          ...settled,
          detail: `${amount} USD of demo capital was added to account #${body.toAccount}.`,
        });
      }
    }

    const record = await accounts.recordFundingIntent(
      owner,
      {
        kind,
        method: method_,
        amount,
        currency,
        fromAccount: body.fromAccount ?? null,
        toAccount: body.toAccount ?? null,
      },
      key,
      GATES.funding,
    );

    incr("projectx_funding_intents_total");
    // 503, not 200: nothing moved. The request was recorded, and the response
    // says exactly why it stopped there.
    return send(res, 503, {
      error: "funding_not_available",
      recorded: true,
      requestId: record.request_id,
      replayed: record.replayed,
      detail: GATES.funding,
      blockedBy: ["15-reconciliation", "17-payments"],
    });
  }

  if (path === "/v1/funding/history" && method === "GET") {
    return send(res, 200, { transactions: await accounts.fundingHistory(owner) });
  }

  if (path === "/v1/funding/demo-reset" && method === "POST") {
    const key = requireIdempotencyKey(req);
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));
    const account = String(body.account ?? "");
    if (!/^\d{6,12}$/.test(account)) throw new HttpError(400, "account must be a trading account number");
    const result = await accounts.demoReset(owner, account, key);
    incr("projectx_demo_resets_total");
    log("info", "demo account reset", { account });
    return send(res, 200, {
      ...result,
      detail: result.changed
        ? `Account #${account} was reset to its opening balance.`
        : `Account #${account} was already at its opening balance.`,
    });
  }

  // ---------------------------------------------------------------- orders
  // Orders go through the OMS, which owns the order lifecycle and the guarantee
  // that one client order id is one order (INV-091). The edge does not shortcut
  // to the ledger: two front doors would mean two places counting retries.
  if (path === "/v1/orders" && method === "POST") {
    const key = requireIdempotencyKey(req);
    const body = /** @type {Record<string, unknown>} */ (await readBody(req));

    const symbol = String(body.symbol ?? "");
    if (!/^[A-Z]{3,12}$/.test(symbol)) throw new HttpError(400, "symbol must be 3-12 uppercase letters");
    const side = String(body.side ?? "");
    if (side !== "BUY" && side !== "SELL") throw new HttpError(400, 'side must be "BUY" or "SELL"');
    // Validated as a decimal string and forwarded as one. It never becomes a
    // JavaScript number here — see money.js for why that matters.
    const volume = requireAmount(body.volume, "volume");
    const account = String(body.account ?? "");
    if (!/^\d{6,12}$/.test(account)) throw new HttpError(400, "account must be a trading account number");

    const result = await forward(UPSTREAM.oms, "/v1/orders", {
      method: "POST",
      idempotencyKey: key,
      body: { account, symbol, side, volume },
    });
    incr(result.ok ? "projectx_orders_accepted_total" : "projectx_orders_refused_total");
    log("info", "order submitted", { account, symbol, side, volume, status: result.status });
    return send(res, result.status, result.body);
  }

  if (path === "/v1/orders" && method === "GET") {
    const account = url.searchParams.get("account") ?? "";
    if (!/^\d{6,12}$/.test(account)) throw new HttpError(400, "account must be a trading account number");
    const result = await forward(UPSTREAM.ledger, `/v1/accounts/${account}/orders`);
    return send(res, result.status, result.body);
  }

  // ------------------------------------------------------- profile & misc
  if (path === "/v1/profile") {
    // Signed in: the profile is the person's own record, read from the identity
    // table rather than assembled here.
    if (identity.session) {
      const user = identity.session.user;
      return send(res, 200, {
        name: user.name,
        email: user.email,
        clientId: user.userId,
        country: user.country,
        baseCurrency: user.baseCurrency,
        since: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        authenticated: true,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        recoveryCodesRemaining: user.twoFactorEnabled
          ? await auth.recoveryCodeCount(user.userId)
          : 0,
        // Being signed in is not being verified. The interface needs to be able
        // to say "we know who you say you are, and nobody has checked" — which
        // is the honest description of an identity issued by this module.
        identityVerified: false,
        verificationNote:
          "Identity verification is owned by 16-kyc-aml, which has not passed its gates. " +
          "Signing in proves you own this account; it does not verify who you are.",
      });
    }

    // Signed out: the development identity, named as such.
    return send(res, 200, {
      name: "Development User",
      email: "dev@projectx.local",
      clientId: owner,
      country: "—",
      baseCurrency: "USD",
      since: "2026-01-15T00:00:00.000Z",
      lastLoginAt: null,
      authenticated: false,
      emailVerified: false,
      twoFactorEnabled: false,
      recoveryCodesRemaining: 0,
      identityVerified: false,
      authNote:
        "No session. This request is attributed to the shared development identity — " +
        "sign in to act as yourself.",
    });
  }

  if (path === "/v1/notifications") {
    return send(res, 200, {
      notifications: [
        { title: "Demo trading is live", text: "Open a demo account, fund it with demo capital and trade through the real ledger.", href: "/" },
        { title: "Domain kernel passed G4", text: "Money arithmetic proven across ~100k generated cases.", href: "/status" },
      ],
    });
  }

  return send(res, 404, { error: "not_found", path });
}

/**
 * @param {import("./accounts.js").PresentedAccount} a
 * @param {import("./accounts.js").PresentedAccount} b
 */
const byNumber = (a, b) => Number(a.accountNumber) - Number(b.accountNumber);

/**
 * Sorting is a display concern, so it happens here rather than in SQL — the
 * list is small and this keeps the query one shape.
 * @param {import("./accounts.js").PresentedAccount[]} list
 * @param {string|null} sort
 * @returns {import("./accounts.js").PresentedAccount[]}
 */
function sortAccounts(list, sort) {
  const copy = [...list];
  switch (sort) {
    case "oldest": return copy.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    // Account numbers are numeric identifiers, so they sort numerically —
    // lexicographically, "50000010" would come before "5000009". (This is an
    // identifier, not money, so Number() is safe here.)
    case "number": return copy.sort((a, b) => byNumber(a, b));
    case "type": return copy.sort((a, b) => a.accountType.localeCompare(b.accountType) || byNumber(a, b));
    default: return copy.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  }
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** @type {() => void} */
let stopOutboxWorker = () => {};

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    if (error instanceof HttpError) {
      incr("projectx_client_errors_total");
      // Every refused credential attempt passes through here, which makes this
      // the one place that sees them all.
      //
      // Only a *rejected credential* counts: a wrong password, a wrong
      // verification code, a spent reset link. Those are guesses.
      //
      // Everything else that lands here with a 4xx is not. A 400 is malformed
      // input; a bare 401 means no credential was presented at all. Counting
      // either let a scanner — or the security gate's own authorization matrix,
      // which works by calling protected endpoints with no session — exhaust
      // the budget and lock out every legitimate caller sharing that address.
      // A 429 is excluded too: charging for being rate-limited extends the
      // window on every retry, and a budget that renews itself on contact never
      // expires.
      if (error.credentialRejected) recordAuthFailure(req);
      return send(res, error.status, {
        error: error.message,
        ...(error.code ? { code: error.code, detail: error.message } : {}),
      });
    }
    incr("projectx_server_errors_total");
    log("error", "unhandled error", { detail: String(error) });
    send(res, 500, { error: "internal_error" });
  });
});

// Refused before anything listens. Each of these is survivable alone and an
// incident together, and a deployment checklist is a thing people complete from
// memory at the end of a long day.
const unsafe = productionSafetyProblems();
if (unsafe.length > 0) {
  for (const problem of unsafe) log("error", "unsafe for production", { problem });
  log("error", "refusing to start", { problems: unsafe.length });
  process.exit(1);
}

const started = await migrate()
  .then(async () => {
    log("info", "schema ready");

    // Read back from the catalogue rather than assumed from the migration
    // having run. A policy that failed to apply, or a role that acquired
    // BYPASSRLS in a later manual fix, is visible here and nowhere else.
    const isolation = await isolationStatus();
    const bypassing = isolation.roles.filter((r) => r.rolsuper || r.rolbypassrls);
    if (bypassing.length > 0) {
      log("error", "a serving role can bypass row-level security", {
        roles: bypassing.map((r) => r.rolname),
      });
      return false;
    }
    const unprotected = isolation.tables.filter((t) => !t.relrowsecurity || !t.relforcerowsecurity);
    if (unprotected.length > 0) {
      log("error", "a table in app is not protected by row-level security", {
        tables: unprotected.map((t) => t.relname),
      });
      return false;
    }
    log("info", "row-level security active", {
      tables: isolation.tables.length,
      roles: isolation.roles.map((r) => r.rolname),
    });
    // Seeding happens once, here — never from a read handler, which would race
    // with itself the moment two requests arrive together. Guarded by an
    // advisory lock so two instances starting at once still seed only once.
    // Records from before the ledger issued every number are re-keyed onto
    // ledger accounts first (INV-033), so nothing below can collide with them.
    // Both steps need the ledger. It is usually a few seconds behind this
    // process at boot, so they are retried for a while; if it never answers,
    // the API still serves — every account request then reports the core as
    // unreachable, which is the truth — and the migration runs next start.
    const withLedger = async () => {
      const migrated = await accounts.reconcileLegacyAccounts();
      if (migrated > 0) log("info", "migrated legacy accounts into the ledger", { count: migrated });
      const seeded = await accounts.seedIfEmpty(DEV_OWNER);
      if (seeded) log("info", "seeded example archived accounts", { owner: DEV_OWNER });
    };
    for (let attempt = 1; ; attempt += 1) {
      try {
        await withLedger();
        break;
      } catch (error) {
        if (attempt >= 15) {
          log("warn", "ledger unreachable at startup; account migration and seeding deferred to next start", {
            detail: String(error),
          });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Long-dead sessions are cleared at startup rather than on a timer. The
    // table is small, this is the one moment nothing is in flight, and a
    // background sweep is another thing that can fail silently at 3am.
    const pruned = await auth.pruneSessions();
    if (pruned > 0) log("info", "pruned expired sessions", { count: pruned });

    // Drains app.outbox. A no-op when MAIL_DRIVER is unset, which is what keeps
    // the "nothing was sent" path honest rather than merely unimplemented.
    stopOutboxWorker = startOutboxWorker();

    if (AUTH_REQUIRED) log("info", "AUTH_REQUIRED is set — anonymous requests are refused");
    const ops = admin.opsStatus();
    log(ops.enabled ? "info" : "warn",
      ops.enabled ? "operator surface enabled at /v1/admin" : "operator surface disabled",
      ops.enabled ? {} : { reason: ops.reason });
    if (TRUST_CLIENT_ID_HEADER) {
      log("warn", "x-client-id is honoured as an identity — development only");
    }
    if (EXPOSE_OUTBOX) {
      log("warn", "the outbox is readable over HTTP — development only");
    }
    if (RATE_LIMIT_EXEMPT.size > 0) {
      log("warn", "addresses are exempt from the request limit — development only", {
        addresses: [...RATE_LIMIT_EXEMPT],
      });
    }
    return true;
  })
  .catch((error) => { log("error", "startup failed", { detail: String(error) }); return false; });

if (!started) process.exit(1);

server.listen(PORT, () => log("info", `listening on 0.0.0.0:${PORT}`, { upstream: UPSTREAM }));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log("info", `${signal} received, draining`);
    stopOutboxWorker();
    server.close(async () => { await closeDb().catch(() => {}); process.exit(0); });
  });
}

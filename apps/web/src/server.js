/**
 * # 20-web — the client area
 *
 * Server-rendered, zero runtime dependencies. Pages arrive complete; the
 * browser upgrades them.
 *
 * **This app owns no financial truth** (INV-190). It renders what the API
 * returns and computes nothing. Where the core cannot supply a figure, the page
 * says so and names the module responsible — it never substitutes a zero.
 *
 * `/api/*` is proxied to `19-client-api` from the server, so the browser never
 * learns the API's address and there is no CORS surface to configure.
 */

import http from "node:http";

import { authLayout, page } from "./ui/layout.js";
import { accountsPage, openAccountModal } from "./pages/accounts.js";
import { fundingPage, transferPage, transactionsPage, walletPage } from "./pages/funding.js";
import {
  performancePage, ordersPage, insightsPage, calendarPage, rewardsPage,
  referralsPage, profilePage, statusPage, statementsPage, helpPage, notFoundPage,
  securityPage, settingsPage, signOutPage,
} from "./pages/misc.js";
import { terminalPage } from "./pages/terminal.js";
import { DOCS, docsIndexPage, legalPage } from "./pages/docs.js";
import {
  instrumentsPage, feesPage, platformsPage, apiAccessPage,
  verificationPage, contactPage, aboutPage, notificationsPage,
} from "./pages/company.js";
import {
  loginPage, registerPage, forgotPasswordPage, resetPasswordPage, verifyEmailPage,
} from "./pages/auth.js";
import { stylesheet } from "./ui/styles.js";

const PORT = Number(process.env.PORT ?? 3000);

/**
 * The session cookie.
 *
 * The API speaks bearer tokens; the browser gets a cookie it cannot read. This
 * server is the only place the two meet, and that is the point of the
 * arrangement:
 *
 * - `HttpOnly` means a script injected into any page cannot read the token, so
 *   an XSS becomes a defacement rather than an account takeover.
 * - `SameSite=Lax` means another origin cannot cause an authenticated POST, so
 *   there is no CSRF token to get wrong. Lax rather than Strict because Strict
 *   drops the cookie on a normal inbound link, which signs people out when they
 *   arrive from their own email.
 * - The token never appears in a URL, in `localStorage`, or in any response
 *   body the browser can reach.
 */
const SESSION_COOKIE = "px_session";

/**
 * When set, a signed-out visitor is redirected to /login instead of browsing as
 * the shared development identity.
 *
 * Off by default, and deliberately so: the gate scripts and the end-to-end
 * suite drive this app without a session and assert on what the *financial*
 * screens say. Turning every one of those into a redirect would replace a suite
 * that proves the money rules with one that proves a login form. A deployment
 * sets this; a reference implementation that has to stay demonstrable does not.
 * See the matching flag in `19-client-api`.
 */
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "true";

/** Pages a signed-out visitor may always reach, even with AUTH_REQUIRED set. */
const PUBLIC_PATHS = new Set([
  "/login", "/register", "/forgot-password", "/signout",
  // Recovering an account is something you do because you cannot sign in.
  "/reset-password", "/verify-email",
  "/status", "/help", "/about", "/contact", "/docs",
  "/instruments", "/fees", "/platforms", "/api-access",
]);

/** @param {string} path */
const isPublicPath = (path) => PUBLIC_PATHS.has(path) || path.startsWith("/docs/");

// Two URLs, deliberately. Server-side rendering reaches the API by service name
// over the compose network; the browser cannot resolve that name, so anything
// the browser touches goes through this server's own /api proxy.
const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://client-api:8000";

const CLIENT_JS_PATH = new URL("./client.js", import.meta.url);
const CHART_JS_PATH = new URL("./chart.js", import.meta.url);
const VENDOR_DIR = new URL("../vendor/", import.meta.url);

/**
 * The vendored chart library, served from this origin.
 *
 * The CSP is `script-src 'self'`, deliberately: no CDN, no third-party host
 * that can change what the page runs. So the library is a file in this
 * repository, pinned by `vendor/klinecharts/VERSION`, and served here.
 */
const VENDORED = new Map([
  ["/vendor/klinecharts.min.js", "klinecharts/klinecharts.min.js"],
]);

/**
 * Read one cookie.
 *
 * Split on ";" only — a cookie value may legitimately contain "=" (base64url
 * padding does not, but the next value stored here might), so the name is taken
 * from the first "=" and the remainder is the value, undivided.
 *
 * @param {http.IncomingMessage} req
 * @param {string} name
 * @returns {string|undefined}
 */
function cookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/**
 * Build the Set-Cookie header for a session.
 *
 * `Secure` is decided from the forwarded protocol rather than hard-coded:
 * hard-coding it on breaks local http development, and hard-coding it off ships
 * a cookie that travels in clear over a tunnel. The proxy tells us which we are
 * on, and that is the only thing that actually knows.
 *
 * @param {http.IncomingMessage} req
 * @param {string|null} token Null clears the cookie.
 * @param {string} [expiresAt] ISO date; ignored when clearing.
 */
function sessionCookie(req, token, expiresAt) {
  const forwarded = req.headers["x-forwarded-proto"];
  const secure = typeof forwarded === "string" && forwarded.split(",")[0]?.trim() === "https";

  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) attributes.push("Secure");

  if (!token) {
    // Max-Age=0 and a past Expires, because browsers disagree about which one
    // retires a cookie and a half-cleared session is worse than either.
    return `${SESSION_COOKIE}=; ${attributes.join("; ")}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }

  const maxAge = expiresAt
    ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
    : undefined;
  if (maxAge !== undefined) attributes.push(`Max-Age=${maxAge}`);

  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${attributes.join("; ")}`;
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @param {string} [token] Session token, forwarded as a bearer credential.
 */
async function callApi(path, init = {}, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    /** @type {Record<string, string>} */
    const headers = { .../** @type {Record<string, string>} */ (init.headers ?? {}) };
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(`${API_INTERNAL_URL}${path}`, {
      ...init, headers, signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  } catch {
    // Fail closed: the page renders, and says the core is unreachable.
    return { ok: false, status: 503, body: { error: "core_unavailable" } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Everything the shell needs on every page.
 *
 * The session is fetched alongside the wallet rather than after it. Rendering
 * the shell signed-out and then correcting it once the session resolves is the
 * flash of the wrong identity that server rendering exists to avoid.
 *
 * @param {string} [token]
 */
async function shellData(token) {
  const [wallet, status, session] = await Promise.all([
    callApi("/v1/wallet", {}, token),
    callApi("/v1/status", {}, token),
    token ? callApi("/v1/auth/session", {}, token) : Promise.resolve({ ok: true, status: 200, body: {} }),
  ]);
  return {
    wallet: wallet.ok
      ? { balance: wallet.body.balance, unavailableReason: wallet.body.unavailableReason }
      : { balance: null, unavailableReason: "The core is unreachable." },
    status: status.ok ? status.body : { core: {}, tradable: false },
    user: session.ok && session.body.authenticated ? session.body.user : null,
  };
}

/**
 * Read the reset link back out of the outbox.
 *
 * This exists because there is no email provider: the link is queued with
 * nowhere to go, and without this the flow could not be completed by a person
 * or proven by a test. The API refuses to expose the outbox at all in
 * production, so this returns null there and the page simply does not offer a
 * link.
 *
 * It is the single most dangerous convenience in this codebase — a reset link is
 * a live credential — which is why it is one function, in one place, gated by
 * the service that owns the data rather than by a flag on this side.
 *
 * @param {string} email
 * @returns {Promise<string|null>}
 */
async function resetLinkFromOutbox(email) {
  const outbox = await callApi(`/v1/auth/outbox?to=${encodeURIComponent(email.toLowerCase())}`);
  if (!outbox.ok) return null;
  const message = (outbox.body.messages ?? [])
    .find((/** @type {{kind: string}} */ m) => m.kind === "password_reset");
  const match = /https?:\/\/\S*\/reset-password\?token=[A-Za-z0-9_-]+/.exec(message?.body ?? "");
  if (!match) return null;
  // Rewritten to a path so the page links to this origin rather than to
  // whatever PUBLIC_ORIGIN the API was configured with.
  try {
    const link = new URL(match[0]);
    return `${link.pathname}${link.search}`;
  } catch {
    return null;
  }
}

/**
 * @param {http.ServerResponse} res
 * @param {string} location
 * @param {string} [setCookie]
 */
function redirect(res, location, setCookie) {
  res.writeHead(303, {
    location,
    "cache-control": "no-store",
    ...(setCookie ? { "set-cookie": setCookie } : {}),
  });
  res.end();
}

/**
 * Where to send someone after they sign in.
 *
 * Only a path on this site is accepted. An open redirect on a login form is the
 * standard way to make a phishing link look legitimate: the domain in the URL
 * is genuinely ours, and the destination after authentication is not. A value
 * starting with "//" or containing a scheme is discarded, not sanitised.
 *
 * @param {string|null|undefined} value
 */
function safeNext(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("://") || /[\r\n]/.test(value)) return "/";
  return value;
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} html
 */
function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  res.end(html);
}

/**
 * Proxy the browser's /api/* calls to the client API.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} path Path **including** any query string.
 */
async function proxy(req, res, path) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json" };
  // Forward only what the API needs. Nothing else crosses the boundary.
  for (const name of ["idempotency-key", "x-client-id"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  // The API rate-limits sign-in attempts per source address, and behind this
  // proxy every request otherwise arrives from the same socket — which would
  // pool every visitor into one budget.
  const remote = req.socket.remoteAddress;
  if (remote) headers["x-forwarded-for"] = remote;
  const agent = req.headers["user-agent"];
  if (typeof agent === "string") headers["user-agent"] = agent;

  const token = cookie(req, SESSION_COOKIE);
  const result = await callApi(path, {
    method: req.method ?? "GET",
    headers,
    ...(body ? { body } : {}),
  }, token);

  /** @type {Record<string, string>} */
  const responseHeaders = { "content-type": "application/json", "cache-control": "no-store" };

  // The one place a bearer token becomes a cookie. The token is stripped from
  // the body on the way past, so it exists in exactly one place the browser can
  // hold it, and that place is unreadable to script.
  let payload = result.body;
  if ((path === "/v1/auth/login" || path === "/v1/auth/register") && result.ok && payload?.token) {
    responseHeaders["set-cookie"] = sessionCookie(req, String(payload.token), payload.expiresAt);
    const { token: _token, ...rest } = payload;
    payload = { ...rest, authenticated: true };
  }
  if (path === "/v1/auth/logout") {
    // Cleared whatever the API said. A logout that leaves the cookie behind
    // because the API was briefly unreachable is a logout that did not happen.
    responseHeaders["set-cookie"] = sessionCookie(req, null);
  }
  // Changing a password rotates this session's token, so the cookie has to be
  // swapped for the new one in the same response. Without this the browser keeps
  // presenting a credential the database no longer recognises, and the person
  // who just changed their password is signed out for their trouble.
  if (path === "/v1/auth/password" && result.ok && payload?.token) {
    responseHeaders["set-cookie"] = sessionCookie(req, String(payload.token), payload.expiresAt);
    const { token: _rotated, ...rest } = payload;
    payload = rest;
  }

  res.writeHead(result.status, responseHeaders);
  res.end(JSON.stringify(payload));
}

/**
 * Pipe a server-sent event stream from the API to the browser.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} path Path including the query string.
 */
async function proxyStream(req, res, path) {
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  /** @type {Record<string, string>} */
  const headers = { accept: "text/event-stream" };
  const token = cookie(req, SESSION_COOKIE);
  if (token) headers.authorization = `Bearer ${token}`;
  const remote = req.socket.remoteAddress;
  if (remote) headers["x-forwarded-for"] = remote;
  let upstream;
  try {
    upstream = await fetch(`${API_INTERNAL_URL}${path}`, { headers, signal: controller.signal });
  } catch {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "core_unavailable" }));
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => "");
    res.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(body || JSON.stringify({ error: "stream_unavailable" }));
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((resolve) => res.once("drain", resolve));
    }
  } catch {
    /* the browser or the API went away; either way the stream is over */
  } finally {
    if (!res.writableEnded) res.end();
  }
  return undefined;
}

/**
 * Read an `application/x-www-form-urlencoded` body.
 *
 * This exists for the no-JavaScript path. The auth forms are real forms with a
 * real action, so a browser with scripting disabled — or one where the script
 * failed to load — can still sign in. A login that depends on JavaScript is a
 * login that fails silently for the people least able to diagnose it.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<URLSearchParams>}
 */
async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw new Error("form body too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // ---- static ----
    if (path === "/styles.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" });
      return res.end(stylesheet);
    }
    if (path === "/client.js" || path === "/chart.js") {
      const { readFile } = await import("node:fs/promises");
      const source = await readFile(path === "/chart.js" ? CHART_JS_PATH : CLIENT_JS_PATH, "utf8");
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(source);
    }
    const vendored = VENDORED.get(path);
    if (vendored) {
      const { readFile } = await import("node:fs/promises");
      const source = await readFile(new URL(vendored, VENDOR_DIR));
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        // Pinned by file content, so it may be cached hard.
        "cache-control": "public, max-age=86400, immutable",
      });
      return res.end(source);
    }
    if (path === "/api/v1/stream") {
      // Streamed, not proxied through callApi: an event stream never ends,
      // so it cannot be read into a body. Piped byte for byte, and torn down
      // upstream when the browser goes away.
      return await proxyStream(req, res, `${path.slice(4)}${url.search}`);
    }
    if (path === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "healthy", service: "web", module_id: "20-web", tier: "T4" }));
    }
    if (path.startsWith("/api/")) {
      // `url.search` is carried across deliberately. Forwarding only the
      // pathname silently turns "the last 180 candles for EURUSD" into "no
      // symbol, no interval, no limit" — which the API then answers with a 404
      // that looks like the market being unavailable rather than a proxy bug.
      return await proxy(req, res, `${path.slice(4)}${url.search}`);
    }

    // ---- identity ----
    const token = cookie(req, SESSION_COOKIE);
    const method = req.method ?? "GET";

    /**
     * @param {string} title
     * @param {string} body
     * @param {number} [status]
     */
    const renderAuth = (title, body, status = 200) =>
      sendHtml(res, status, authLayout({ title, body }));

    // The registration form needs the country and currency lists the API
    // publishes, so the two can never drift apart into a form that offers a
    // country the API then refuses.
    const authMeta = async () => {
      const meta = await callApi("/v1/auth/meta");
      return meta.ok
        ? {
            countries: meta.body.countries,
            currencies: meta.body.currencies,
            emailDelivery: Boolean(meta.body.emailDelivery),
          }
        : {
            countries: ["United Kingdom", "Other"],
            currencies: ["USD", "EUR", "GBP"],
            emailDelivery: false,
          };
    };

    if (path === "/login" && method === "GET") {
      // Already signed in: nothing to do here. Going somewhere useful beats
      // presenting a form that would only re-establish what already exists.
      if (token) {
        const session = await callApi("/v1/auth/session", {}, token);
        if (session.ok && session.body.authenticated) {
          return redirect(res, safeNext(url.searchParams.get("next")));
        }
      }
      return renderAuth("Sign in", loginPage({
        next: safeNext(url.searchParams.get("next")),
        email: url.searchParams.get("email") ?? "",
        registered: url.searchParams.get("registered") === "1",
        signedOut: url.searchParams.get("signedOut") === "1",
        passwordChanged: url.searchParams.get("passwordChanged") === "1",
        twoFactor: url.searchParams.get("twoFactor") === "1",
      }));
    }

    if (path === "/login" && method === "POST") {
      const form = await readForm(req);
      const next = safeNext(form.get("next"));
      const result = await callApi("/v1/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(req.headers["user-agent"] ? { "user-agent": String(req.headers["user-agent"]) } : {}),
          ...(req.socket.remoteAddress ? { "x-forwarded-for": req.socket.remoteAddress } : {}),
        },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
          totp: form.get("totp") || undefined,
          remember: form.get("remember") === "true",
        }),
      });

      if (result.ok && result.body.token) {
        return redirect(res, next, sessionCookie(req, String(result.body.token), result.body.expiresAt));
      }

      // Re-rendered with the error in place rather than redirected with it in a
      // query string: an error in a URL survives a bookmark, a share and a back
      // button, and none of those are places it belongs.
      const twoFactor = result.body.error === "two_factor_required";
      return renderAuth("Sign in", loginPage({
        next,
        email: form.get("email") ?? "",
        twoFactor,
        error: twoFactor
          ? "Enter the six-digit code from your authenticator app."
          : String(result.body.detail ?? result.body.error ?? "Could not sign you in."),
      }), twoFactor ? 200 : 401);
    }

    if (path === "/register" && method === "GET") {
      if (token) {
        const session = await callApi("/v1/auth/session", {}, token);
        if (session.ok && session.body.authenticated) return redirect(res, "/");
      }
      return renderAuth("Create an account", registerPage(await authMeta()));
    }

    if (path === "/register" && method === "POST") {
      const form = await readForm(req);
      const values = {
        name: form.get("name") ?? "",
        email: form.get("email") ?? "",
        country: form.get("country") ?? "",
        baseCurrency: form.get("baseCurrency") ?? "USD",
      };

      // Checked here as well as in the browser, because this path is the one
      // taken when the browser check did not run.
      if (form.get("password") !== form.get("confirmPassword")) {
        return renderAuth("Create an account", registerPage({
          ...(await authMeta()), values,
          error: "Those two passwords do not match.",
        }), 400);
      }

      const result = await callApi("/v1/auth/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(req.headers["user-agent"] ? { "user-agent": String(req.headers["user-agent"]) } : {}),
          ...(req.socket.remoteAddress ? { "x-forwarded-for": req.socket.remoteAddress } : {}),
        },
        body: JSON.stringify({
          ...values,
          password: form.get("password"),
          acceptedTerms: form.get("acceptedTerms") === "true",
        }),
      });

      if (result.ok && result.body.token) {
        // Straight in. They have just proved they hold the password by choosing
        // it; a second form asking for it would establish nothing.
        return redirect(res, "/", sessionCookie(req, String(result.body.token), result.body.expiresAt));
      }

      return renderAuth("Create an account", registerPage({
        ...(await authMeta()), values,
        error: String(result.body.error ?? result.body.detail ?? "Could not create your account."),
      }), result.status === 409 ? 409 : 400);
    }

    if (path === "/forgot-password" && method === "GET") {
      // `sent=1` is where the scripted path lands after its request succeeded.
      // The confirmation is rendered here rather than in the browser because
      // only the server can read the development link out of the outbox.
      const askedFor = url.searchParams.get("email") ?? "";
      const already = url.searchParams.get("sent") === "1";
      const meta = await authMeta();
      return renderAuth("Forgot password", forgotPasswordPage({
        sent: already,
        email: askedFor,
        deliveryEnabled: meta.emailDelivery,
        // Only offered where nothing was actually sent: with a provider the
        // link belongs in the inbox and nowhere else.
        devLink: already && askedFor && !meta.emailDelivery
          ? await resetLinkFromOutbox(askedFor)
          : null,
      }));
    }

    if (path === "/forgot-password" && method === "POST") {
      const form = await readForm(req);
      const email = form.get("email") ?? "";
      const result = await callApi("/v1/auth/password/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const meta = await authMeta();
      if (!result.ok) {
        return renderAuth("Forgot password", forgotPasswordPage({
          email,
          deliveryEnabled: meta.emailDelivery,
          error: String(result.body.error ?? "Could not create a reset link."),
        }), 400);
      }

      // With no email provider the link has nowhere to go, so in development it
      // is read back out of the outbox and shown. `EXPOSE_OUTBOX` is refused in
      // production, and this returns nothing there.
      return renderAuth("Forgot password", forgotPasswordPage({
        sent: true, email,
        deliveryEnabled: meta.emailDelivery,
        devLink: meta.emailDelivery ? null : await resetLinkFromOutbox(email),
      }));
    }

    if (path === "/reset-password" && method === "GET") {
      const resetToken = url.searchParams.get("token") ?? "";
      const check = await callApi(`/v1/auth/password/reset?token=${encodeURIComponent(resetToken)}`);
      return renderAuth("Choose a new password", resetPasswordPage({
        token: resetToken,
        valid: Boolean(check.ok && check.body.valid),
      }));
    }

    if (path === "/reset-password" && method === "POST") {
      const form = await readForm(req);
      const resetToken = form.get("token") ?? "";

      if (form.get("newPassword") !== form.get("confirmPassword")) {
        return renderAuth("Choose a new password", resetPasswordPage({
          token: resetToken, error: "Those two passwords do not match.",
        }), 400);
      }

      const result = await callApi("/v1/auth/password/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: resetToken, newPassword: form.get("newPassword") }),
      });

      if (!result.ok) {
        return renderAuth("Choose a new password", resetPasswordPage({
          token: resetToken,
          error: String(result.body.error ?? "Could not set that password."),
        }), 400);
      }

      // Every session was revoked, this one included, so the cookie goes too.
      return redirect(res, "/login?passwordChanged=1", sessionCookie(req, null));
    }

    if (path === "/verify-email") {
      const verifyToken = url.searchParams.get("token") ?? "";
      const result = await callApi("/v1/auth/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: verifyToken }),
      });
      return renderAuth("Confirm your address", verifyEmailPage({
        verified: Boolean(result.ok && result.body.verified),
        email: String(result.body.email ?? ""),
        error: String(result.body.error ?? ""),
      }), result.ok ? 200 : 400);
    }

    if (path === "/signout") {
      // A GET link that ends a session would let any image or prefetch sign
      // someone out, so the link goes to this page and the page posts.
      if (method === "POST") {
        await callApi("/v1/auth/logout", { method: "POST" }, token);
        return redirect(res, "/login?signedOut=1", sessionCookie(req, null));
      }
    }

    // ---- pages ----
    const shell = await shellData(token);

    // A cookie that no longer resolves to a session is a cookie that has
    // expired or been revoked elsewhere. Clearing it here means the next
    // request is honestly signed out rather than carrying a dead credential.
    if (token && !shell.user && path !== "/signout") {
      return redirect(
        res,
        `/login?next=${encodeURIComponent(path + url.search)}`,
        sessionCookie(req, null),
      );
    }

    if (AUTH_REQUIRED && !shell.user && !isPublicPath(path)) {
      return redirect(res, `/login?next=${encodeURIComponent(path + url.search)}`);
    }

    /**
     * @param {string} title
     * @param {string} body
     * @param {string} [modal]
     */
    const render = (title, body, modal = "") =>
      sendHtml(res, 200, page({ title, path, body, wallet: shell.wallet, user: shell.user, modal }));

    if (path === "/") {
      const mode = url.searchParams.get("mode") === "demo" ? "demo" : "real";
      const sort = url.searchParams.get("sort") ?? "newest";
      const view = url.searchParams.get("view") === "grid" ? "grid" : "list";

      const [active, archived, meta] = await Promise.all([
        callApi(`/v1/accounts?mode=${mode}&status=active&sort=${encodeURIComponent(sort)}`, {}, token),
        callApi(`/v1/accounts?mode=${mode}&status=archived&sort=${encodeURIComponent(sort)}`, {}, token),
        callApi("/v1/accounts/meta", {}, token),
      ]);

      const body = accountsPage({
        accounts: active.ok ? active.body.accounts : [],
        archived: archived.ok ? archived.body.accounts : [],
        mode, sort, view,
      });
      const modal = meta.ok
        ? openAccountModal(meta.body, mode)
        : openAccountModal({ types: {}, leverages: [200], currencies: ["USD"], platforms: ["MT5"] }, mode);
      return render("My accounts", body, modal);
    }

    if (path === "/deposit" || path === "/withdraw") {
      const kind = path === "/deposit" ? "deposit" : "withdrawal";
      // Both modes: a demo account is funded here too, with demo capital.
      const accounts = await callApi("/v1/accounts?status=active", {}, token);
      return render(
        kind === "deposit" ? "Deposit" : "Withdraw",
        fundingPage({
          kind,
          accounts: accounts.ok ? accounts.body.accounts : [],
          selected: url.searchParams.get("account") ?? undefined,
        }),
      );
    }

    if (path === "/transfer") {
      const accounts = await callApi("/v1/accounts?status=active", {}, token);
      return render("Transfer", transferPage({
        accounts: accounts.ok ? accounts.body.accounts : [],
        from: url.searchParams.get("from") ?? undefined,
      }));
    }

    if (path === "/transactions") {
      const history = await callApi("/v1/funding/history", {}, token);
      return render("Transaction history", transactionsPage({
        history: history.ok ? history.body.transactions : [],
      }));
    }

    if (path === "/funding-wallet") return render("Funding wallet", walletPage());
    if (path === "/crypto-wallet") return render("Crypto wallet", walletPage({ crypto: true }));
    if (path === "/performance") return render("Performance", performancePage());
    if (path === "/orders") return render("History of orders", ordersPage());
    if (path === "/insights") return render("Market overview", insightsPage());
    if (path === "/insights/calendar") return render("Economic calendar", calendarPage());
    if (path === "/rewards") return render("Trading credits", rewardsPage());
    if (path === "/referrals") return render("Referrals", referralsPage());
    if (path === "/help") return render("Help", helpPage());
    if (path === "/security") {
      // The sessions list is the whole point of this screen, and it only exists
      // for someone signed in. Signed out, the page says so rather than
      // rendering an empty table that looks like "you have no sessions".
      const [sessions, profile, events] = shell.user
        ? await Promise.all([
            callApi("/v1/auth/sessions", {}, token),
            callApi("/v1/profile", {}, token),
            callApi("/v1/auth/events?limit=8", {}, token),
          ])
        : [null, null, null];
      return render("Security", securityPage({
        user: shell.user,
        sessions: sessions?.ok ? sessions.body.sessions : [],
        twoFactorEnabled: Boolean(profile?.ok && profile.body.twoFactorEnabled),
        recoveryCodesRemaining: profile?.ok ? Number(profile.body.recoveryCodesRemaining ?? 0) : 0,
        emailVerified: Boolean(profile?.ok && profile.body.emailVerified),
        events: events?.ok ? events.body.events : [],
      }));
    }
    if (path === "/settings") return render("Settings", settingsPage());
    if (path === "/signout") return render("Sign out", signOutPage({ user: shell.user }));
    // Company and product pages.
    if (path === "/instruments") return render("Instruments", instrumentsPage());
    if (path === "/fees") return render("Fees and charges", feesPage());
    if (path === "/platforms") return render("Platforms", platformsPage());
    if (path === "/api-access") return render("API access", apiAccessPage());
    if (path === "/verification") return render("Verification", verificationPage());
    if (path === "/contact") return render("Contact", contactPage());
    if (path === "/about") return render("About", aboutPage());
    if (path === "/notifications") return render("Notifications", notificationsPage());

    // The document suite is driven by the registry, so adding a policy is a
    // data change rather than another branch here.
    if (path === "/docs") return render("Documents", docsIndexPage());
    if (path.startsWith("/docs/")) {
      const slug = path.slice("/docs/".length);
      const doc = Object.hasOwn(DOCS, slug) ? DOCS[slug] : null;
      if (doc) return render(doc.title, legalPage(slug));
    }
    if (path === "/status") return render("Platform status", statusPage(shell.status));

    if (path === "/profile") {
      const profile = await callApi("/v1/profile", {}, token);
      return render("Profile", profilePage({
        profile: profile.ok ? profile.body : {
          name: "—", email: "—", clientId: "—", country: "—", baseCurrency: "USD", since: Date.now(),
        },
      }));
    }

    if (path.startsWith("/statements/")) {
      return render("Statements", statementsPage({ account: path.split("/")[2] ?? "" }));
    }

    // The terminal. Everything it renders is fetched here, server-side, so the
    // first paint is a real account with real positions rather than a set of
    // spinners that resolve into one.
    if (path === "/terminal") {
      const symbol = /^[A-Z]{3,12}$/.test(url.searchParams.get("symbol") ?? "")
        ? String(url.searchParams.get("symbol"))
        : "EURUSD";
      const interval = url.searchParams.get("interval") ?? "1m";

      const [instruments, tradingAccounts] = await Promise.all([
        callApi("/v1/instruments", {}, token),
        callApi("/v1/trading-accounts", {}, token),
      ]);
      const accounts = tradingAccounts.ok ? tradingAccounts.body.accounts : [];
      const chosen = url.searchParams.get("account") ?? accounts[0]?.accountNumber ?? "";

      // A second round trip only where there is an account to describe.
      const [state, orders] = chosen
        ? await Promise.all([
            callApi(`/v1/trading-accounts/${chosen}/state`, {}, token),
            callApi(`/v1/orders?account=${chosen}`, {}, token),
          ])
        : [{ ok: false, body: {} }, { ok: false, body: {} }];

      return render(
        "Trading terminal",
        terminalPage({
          instruments: instruments.ok ? instruments.body.instruments : [],
          accounts,
          symbol,
          interval,
          account: chosen,
          valuation: state.ok ? state.body.valuation : null,
          orders: orders.ok ? orders.body.orders : [],
          // `coreReachable` distinguishes "you have no account yet" from "we
          // cannot tell you whether you have one", which are different things
          // to show a client (INV-183).
          coreReachable: tradingAccounts.ok,
        }),
      );
    }

    return sendHtml(res, 404, page({
      title: "Not found", path, body: notFoundPage(),
      wallet: shell.wallet, user: shell.user,
    }));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ level: "error", message: String(error) })}\n`);
    return sendHtml(res, 500, page({
      title: "Error", path, body: notFoundPage(),
      wallet: { balance: null, unavailableReason: null },
    }));
  }
});

server.listen(PORT, () => {
  process.stdout.write(
    JSON.stringify({
      ts: Date.now(), level: "info", service: "web", module_id: "20-web",
      message: `listening on 0.0.0.0:${PORT}`, api: API_INTERNAL_URL,
    }) + "\n",
  );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

/**
 * # Project X Ops — the operator console
 *
 * A standalone app on its own port with its own deploy. It is deliberately not
 * part of `20-web`: the client area ships product, and the operator surface
 * lives here so it can be secured, exposed and audited separately. Nothing in
 * the client area can reach this, and nothing here is reachable by a client's
 * session however senior the person holding it.
 *
 * ```
 * operator browser
 *   │  passcode → signed HttpOnly cookie (HMAC, 8h)
 *   ▼
 * ops (:27030)  ── server-side only: X-Ops-Token ──►  client-api /v1/admin/*
 *   │
 *   ├─ registry/modules.yaml, gates/gates.yaml   (the repository)
 *   └─ docker, ss, git, /proc                     (the host)
 * ```
 *
 * The token never reaches the browser. The console holds it and attaches it
 * server-side, which is the whole reason this is a server rather than a
 * single-page app talking to the admin API directly.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";

import {
  CSRF_COOKIE, SESSION_COOKIE, configurationProblems, cookieHeader, csrfMatches,
  clearAttempts, issueSession, newCsrfToken, passcodeMatches, readCookie,
  readSession, recordFailedAttempt, retryAfterSeconds, withinAttemptBudget,
} from "./session.js";
import { callAdmin, platformStatus, proxyAdminStream } from "./sources/api.js";
import { gateDefinitions, modules, tiers } from "./sources/registry.js";
import * as infra from "./sources/infra.js";
import * as gateRunner from "./sources/gates.js";
import { loginPage, page } from "./ui/layout.js";
import { stylesheet } from "./ui/styles.js";
import { overviewPage } from "./pages/overview.js";
import { userDetailPage, usersPage } from "./pages/users.js";
import { bridgePage, feedPage, ledgerPage, ordersPage, telemetryPage } from "./pages/trading.js";
import {
  accountsPage, auditPage, databasePage, gatesPage, infraPage, logsPage,
  modulesPage, outboxPage,
} from "./pages/system.js";

const PORT = Number(process.env.PORT ?? 27030);
const CONSOLE_JS = new URL("./console.js", import.meta.url);

/** @param {string} level @param {string} message @param {Record<string, unknown>} [fields] */
function log(level, message, fields = {}) {
  process.stdout.write(
    JSON.stringify({ ts: Date.now(), level, service: "ops", module_id: "20-web", tier: "T4", message, ...fields }) + "\n",
  );
}

/* ---------------------------------------------------------------- responses */

/**
 * Security headers for every response.
 *
 * `noindex` because a console that shows up in a search result has already
 * failed. `frame-ancestors 'none'` because clickjacking an operator console
 * means clickjacking the buttons that end people's sessions. The CSP allows no
 * external origin at all — this page loads nothing it does not serve.
 */
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cache-control": "no-store, max-age=0",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} html
 * @param {string[]} [cookies]
 */
function sendHtml(res, status, html, cookies = []) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    ...SECURITY_HEADERS,
    ...(cookies.length ? { "set-cookie": cookies } : {}),
  });
  res.end(html);
}

/**
 * @param {http.ServerResponse} res
 * @param {string} location
 * @param {string[]} [cookies]
 */
function redirect(res, location, cookies = []) {
  res.writeHead(303, {
    location,
    ...SECURITY_HEADERS,
    ...(cookies.length ? { "set-cookie": cookies } : {}),
  });
  res.end();
}

/** @param {http.IncomingMessage} req */
const isSecure = (req) => {
  const forwarded = req.headers["x-forwarded-proto"];
  return typeof forwarded === "string" && forwarded.split(",")[0]?.trim() === "https";
};

/** @param {http.IncomingMessage} req */
const addressOf = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  return String(
    (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : "") ||
      req.socket.remoteAddress || "unknown",
  );
};

/**
 * Read a form body.
 *
 * Every mutation in this console is a real form post, so the whole thing works
 * without JavaScript. `console.js` adds confirmation prompts and toasts; it is
 * not what makes the buttons work.
 *
 * @param {http.IncomingMessage} req
 */
async function readForm(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("form body too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/* -------------------------------------------------------------------- app */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  const secure = isSecure(req);

  try {
    // ---- static ----
    if (path === "/styles.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" });
      return res.end(stylesheet);
    }
    if (path === "/console.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(await readFile(CONSOLE_JS, "utf8"));
    }
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "healthy", service: "ops" }));
    }

    // ---- session ----
    const session = readSession(readCookie(req.headers.cookie, SESSION_COOKIE));
    let csrf = readCookie(req.headers.cookie, CSRF_COOKIE) ?? "";
    /** @type {string[]} */
    const cookies = [];
    if (!csrf) {
      csrf = newCsrfToken();
      // Readable by script on this origin: the double-submit pattern needs the
      // page to be able to put the same value in the form.
      cookies.push(cookieHeader(CSRF_COOKIE, csrf, { secure, httpOnly: false }));
    }

    // ---- sign in ----
    if (path === "/login") {
      if (session) return redirect(res, "/");

      if (method === "POST") {
        const address = addressOf(req);
        if (!withinAttemptBudget(address)) {
          log("warn", "sign-in refused, attempt budget spent", { address });
          return sendHtml(res, 429, loginPage({
            csrf, retryAfter: retryAfterSeconds(address),
            error: "Too many attempts from this address.",
          }), cookies);
        }

        const form = await readForm(req);
        if (!csrfMatches(readCookie(req.headers.cookie, CSRF_COOKIE), form.get("csrf"))) {
          return sendHtml(res, 403, loginPage({ csrf, error: "That form expired. Try again." }), cookies);
        }

        if (!passcodeMatches(form.get("passcode") ?? "")) {
          recordFailedAttempt(address);
          log("warn", "sign-in failed", { address });
          return sendHtml(res, 401, loginPage({ csrf, error: "That passcode is not correct." }), cookies);
        }

        clearAttempts(address);
        const operator = (form.get("operator") ?? "").trim() || "operator";
        const issued = issueSession(operator);
        log("info", "operator signed in", { operator, address });
        return redirect(res, "/", [
          ...cookies,
          cookieHeader(SESSION_COOKIE, issued.value, {
            secure,
            maxAgeSeconds: Math.floor((issued.expiresAt - Date.now()) / 1000),
          }),
        ]);
      }

      return sendHtml(res, 200, loginPage({ csrf }), cookies);
    }

    if (path === "/logout" && method === "POST") {
      log("info", "operator signed out", { operator: session?.operator ?? "—" });
      return redirect(res, "/login", [cookieHeader(SESSION_COOKIE, null, { secure })]);
    }

    // Everything past here needs a session.
    if (!session) {
      return redirect(res, "/login", cookies);
    }
    const operator = session.operator;

    /**
     * Guard a mutation.
     *
     * `SameSite=Lax` already stops a cross-site POST; this is the second
     * mechanism, because these buttons end people's sessions.
     * @param {URLSearchParams} form
     */
    const csrfOk = (form) =>
      csrfMatches(readCookie(req.headers.cookie, CSRF_COOKIE), form.get("csrf"));

    /**
     * @param {string} title
     * @param {string} body
     * @param {{refresh?: number}} [options]
     */
    const render = (title, body, options = {}) =>
      sendHtml(res, 200, page({
        title, path, body, operator, csrf,
        refresh: options.refresh ?? 0,
      }), cookies);

    // ---- overview ----
    if (path === "/") {
      const [overviewResult, status, containers, host, commit, audit, definitions, moduleList] =
        await Promise.all([
          callAdmin("/v1/admin/overview", { operator }),
          platformStatus(),
          infra.containers(),
          infra.host(),
          infra.commit(),
          callAdmin("/v1/admin/audit?limit=12", { operator }),
          gateDefinitions(),
          modules(),
        ]);
      const board = await gateRunner.board(definitions, moduleList);

      return render("Overview", overviewPage({
        overview: overviewResult.body ?? {},
        status, containers, host, commit,
        gates: board,
        audit: audit.ok ? audit.body.events ?? [] : [],
        error: overviewResult.error,
      }), { refresh: 30 });
    }

    // ---- users ----
    if (path === "/users") {
      const q = url.searchParams.get("q") ?? "";
      const sort = url.searchParams.get("sort") ?? "recent";
      const result = await callAdmin(
        `/v1/admin/users?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}&limit=200`,
        { operator },
      );
      return render("Users", usersPage({
        users: result.ok ? result.body.users ?? [] : [],
        q, sort, error: result.error,
      }));
    }

    const userMatch = path.match(/^\/users\/([0-9a-fA-F-]{36})(?:\/([a-z-]+))?$/);
    if (userMatch) {
      const userId = String(userMatch[1]);
      const action = userMatch[2] ?? "";

      if (action && method === "POST") {
        const form = await readForm(req);
        if (!csrfOk(form)) return redirect(res, `/users/${userId}?error=expired`);

        const result = await callAdmin(`/v1/admin/users/${userId}/${action}`, {
          method: "POST", operator,
        });
        log(result.ok ? "warn" : "error", "operator action", {
          operator, userId, action, ok: result.ok,
        });
        return redirect(res, `/users/${userId}?${result.ok ? "done" : "error"}=${encodeURIComponent(action)}`);
      }

      const result = await callAdmin(`/v1/admin/users/${userId}`, { operator });
      return render("User", userDetailPage({
        detail: result.ok ? result.body : {},
        csrf, error: result.error, userId,
      }));
    }

    // ---- accounts ----
    if (path === "/accounts") {
      const result = await callAdmin("/v1/admin/accounts?limit=300", { operator });
      return render("Accounts", accountsPage({
        accounts: result.ok ? result.body.accounts ?? [] : [],
        error: result.error,
      }));
    }

    // ---- order book ----
    if (path === "/orders") {
      const account = (url.searchParams.get("account") ?? "").replace(/\D/g, "").slice(0, 12);
      const result = await callAdmin("/v1/admin/orders?limit=500", { operator });
      return render("Order book", ordersPage({
        orders: result.ok ? result.body.orders ?? [] : [], account, error: result.error,
      }), { refresh: 10 });
    }

    // ---- ledger ----
    if (path === "/ledger") {
      const kind = (url.searchParams.get("kind") ?? "").replace(/[^A-Z_]/g, "");
      const after = (url.searchParams.get("after") ?? "").replace(/\D/g, "");
      const query = new URLSearchParams({ limit: "100" });
      if (kind) query.set("kind", kind);
      if (after) query.set("after", after);
      const [balances, invariants, journal] = await Promise.all([
        callAdmin("/v1/admin/ledger/balances", { operator }),
        callAdmin("/v1/admin/ledger/invariants", { operator }),
        callAdmin(`/v1/admin/ledger/journal?${query}`, { operator }),
      ]);
      return render("Ledger", ledgerPage({
        balances: balances.ok ? balances.body : null,
        invariants: invariants.body ?? null,
        journal: journal.ok ? journal.body : null,
        error: balances.error && journal.error ? balances.error : null,
        kind, after,
      }));
    }

    // ---- the feed ----
    if (path === "/feed") {
      const result = await callAdmin("/v1/admin/feed", { operator });
      return render("Market feed", feedPage({
        feed: result.body ?? {}, csrf, error: result.error,
        done: url.searchParams.get("done") ?? "", fail: url.searchParams.get("fail") ?? "",
      }), { refresh: 15 });
    }
    if (path === "/feed/source" && method === "POST") {
      const form = await readForm(req);
      if (!csrfOk(form)) return redirect(res, "/feed?fail=expired");
      const cls = String(form.get("class") ?? "");
      const sources = String(form.get("sources") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const result = await callAdmin("/v1/admin/feed/source", { method: "POST", operator, body: { class: cls, sources } });
      log(result.ok ? "warn" : "error", "operator changed a feed source order", { operator, class: cls, sources, ok: result.ok });
      return redirect(res, result.ok ? `/feed?done=${encodeURIComponent(cls)}` : `/feed?fail=${encodeURIComponent(result.error ?? "refused")}`);
    }

    // ---- telemetry ----
    if (path === "/telemetry") {
      const result = await callAdmin("/v1/admin/telemetry", { operator });
      return render("Telemetry", telemetryPage({ telemetry: result.body ?? { users: [], tracked: 0 }, error: result.error }));
    }
    if (path === "/telemetry/stream") {
      // The API's operator stream, piped through with the token attached
      // here. The browser never holds the token.
      return await proxyAdminStream(req, res, "/v1/admin/telemetry/stream", operator);
    }

    // ---- the bridge ----
    if (path === "/bridge") {
      const result = await callAdmin("/v1/admin/external", { operator });
      return render("MT5 bridge", bridgePage({
        external: result.body ?? {}, csrf, error: result.error,
        done: url.searchParams.get("done") ?? "", fail: url.searchParams.get("fail") ?? "",
      }), { refresh: 15 });
    }
    const bridgeAction = path.match(/^\/bridge\/(map|unmap|cycle)$/);
    if (bridgeAction && method === "POST") {
      const form = await readForm(req);
      if (!csrfOk(form)) return redirect(res, "/bridge?fail=expired");
      const action = String(bridgeAction[1]);
      const body = action === "map" ? { ledgerAccount: String(form.get("ledgerAccount") ?? "").replace(/\D/g, "") } : {};
      const result = await callAdmin(`/v1/admin/external/${action}`, { method: "POST", operator, body });
      log(result.ok ? "warn" : "error", "operator bridge action", { operator, action, ok: result.ok });
      const done = { map: "Mapping saved", unmap: "Mapping removed", cycle: "Cycle run" }[action] ?? action;
      return redirect(res, result.ok ? `/bridge?done=${encodeURIComponent(done)}` : `/bridge?fail=${encodeURIComponent(result.error ?? "refused")}`);
    }

    // ---- gates ----
    if (path === "/gates") {
      const [definitions, moduleList, commit] = await Promise.all([
        gateDefinitions(), modules(), infra.commit(),
      ]);
      const board = await gateRunner.board(definitions, moduleList);
      return render("Gates", gatesPage({
        gates: board, commit, csrf, running: gateRunner.running(),
      }), { refresh: gateRunner.running().length ? 10 : 0 });
    }

    const gateRun = path.match(/^\/gates\/([A-Z0-9]+)\/run$/);
    if (gateRun && method === "POST") {
      const form = await readForm(req);
      if (!csrfOk(form)) return redirect(res, "/gates");

      const id = String(gateRun[1]);
      if (!gateRunner.GATE_COMMANDS[id]) return redirect(res, "/gates");

      log("info", "operator started a gate", { operator, gate: id });
      // Deliberately not awaited: a gate takes minutes and the request must
      // return now. The board polls while anything is in flight.
      void gateRunner.runGate(id, operator).catch((error) => {
        log("error", "gate run failed to start", { gate: id, detail: String(error) });
      });
      return redirect(res, "/gates");
    }

    // ---- modules ----
    if (path === "/modules") {
      const [moduleList, tierList] = await Promise.all([modules(), tiers()]);
      return render("Modules", modulesPage({ modules: moduleList, tiers: tierList }));
    }

    // ---- infrastructure ----
    if (path === "/infra") {
      const [containers, images, volumes, ports, tunnels, host, commit] = await Promise.all([
        infra.containers(), infra.images(), infra.volumes(),
        infra.ports(), infra.tunnels(), infra.host(), infra.commit(),
      ]);
      return render("Infrastructure", infraPage({
        containers, images, volumes, ports, tunnels, host, commit,
      }), { refresh: 30 });
    }

    // ---- database ----
    if (path === "/database") {
      const result = await callAdmin("/v1/admin/isolation", { operator });
      return render("Database", databasePage({
        isolation: result.ok ? result.body : {},
        error: result.error,
      }));
    }

    // ---- audit ----
    if (path === "/audit") {
      const filter = url.searchParams.get("event") ?? "";
      const result = await callAdmin(
        `/v1/admin/audit?event=${encodeURIComponent(filter)}&limit=200`, { operator },
      );
      return render("Audit", auditPage({
        events: result.ok ? result.body.events ?? [] : [],
        names: result.ok ? result.body.names ?? [] : [],
        filter, error: result.error,
      }));
    }

    // ---- outbox ----
    if (path === "/outbox") {
      const state = url.searchParams.get("state") ?? "";
      const result = await callAdmin(
        `/v1/admin/outbox?state=${encodeURIComponent(state)}&limit=200`, { operator },
      );
      return render("Outbox", outboxPage({
        messages: result.ok ? result.body.messages ?? [] : [],
        delivery: result.ok ? result.body.delivery ?? "none" : "none",
        state, error: result.error,
      }));
    }

    // ---- logs ----
    if (path === "/logs") {
      const requested = url.searchParams.get("service") ?? "client-api";
      const service = infra.LOG_SOURCES.includes(/** @type {any} */ (requested))
        ? requested : "client-api";
      const result = await infra.logs(service, 300);
      return render("Logs", logsPage({
        service, sources: infra.LOG_SOURCES, result,
      }), { refresh: 20 });
    }

    return sendHtml(res, 404, page({
      title: "Not found", path, operator, csrf,
      body: `<div class="page-head"><div class="grow">
        <h1 class="h1">Not found</h1>
        <p class="muted small">No console page is served at <span class="mono">${
          String(path).replace(/[&<>"']/g, "")
        }</span>.</p>
      </div></div>`,
    }), cookies);
  } catch (error) {
    log("error", "unhandled", { path, detail: String(error) });
    return sendHtml(res, 500, `<!doctype html><meta charset="utf-8">
      <title>Error · Project X Ops</title>
      <link rel="stylesheet" href="/styles.css">
      <div class="login-shell"><div class="login-card">
        <h1 class="h1">Something failed</h1>
        <p class="muted small" style="margin-top:var(--s-3)">The console hit an error
        rendering this page. The detail is in its log.</p>
        <a class="btn btn-block" href="/" style="margin-top:var(--s-4)">Back to overview</a>
      </div></div>`);
  }
});

/* ------------------------------------------------------------------ boot */

const problems = configurationProblems();
if (problems.length > 0) {
  // Refused rather than defaulted. A console that invents a passcode when none
  // is set is a console protected by a secret nobody knows they rely on.
  for (const problem of problems) log("error", "refusing to start", { problem });
  process.exit(1);
}

server.listen(PORT, () => {
  log("info", `listening on 0.0.0.0:${PORT}`, {
    api: process.env.API_INTERNAL_URL ?? "http://client-api:8000",
  });
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

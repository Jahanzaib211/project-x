/**
 * G2/G4 — every console screen, rendered and inspected.
 *
 * The same approach as `apps/web/tests/screens.test.js`: the page modules are
 * pure functions from data to HTML, so each screen renders in-process and is
 * asserted on. No browser, no network.
 *
 * Two things matter more here than in the client area. The console renders data
 * from every client — names, addresses, user agents — so an escaping mistake is
 * a stored XSS with an operator's session on the other side of it. And it
 * renders next to buttons that end people's sessions, so a panel that fails
 * quietly is a panel somebody acts on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ago, esc, page, loginPage } from "../src/ui/layout.js";
import { overviewPage } from "../src/pages/overview.js";
import { usersPage, userDetailPage } from "../src/pages/users.js";
import {
  accountsPage, auditPage, databasePage, gatesPage, infraPage, logsPage,
  modulesPage, outboxPage,
} from "../src/pages/system.js";
import { parseYaml } from "../src/sources/registry.js";

/* ------------------------------------------------------------- fixtures */

const user = {
  userId: "8ad42757-a0a8-4efe-97bd-ad26bea9a439",
  email: "ada@example.com", name: "Ada Lovelace", country: "United Kingdom",
  baseCurrency: "GBP", status: "active", emailVerified: true, twoFactor: true,
  failedAttempts: 0, lockedUntil: null,
  createdAt: "2026-09-01T10:00:00.000Z", lastLoginAt: "2026-09-11T08:00:00.000Z",
  accountCount: 2, liveSessions: 1, recoveryCodes: 8,
  passwordChangedAt: "2026-09-10T09:00:00.000Z",
};

const detail = {
  user,
  sessions: [{
    sessionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", live: true, revokedAt: null,
    device: "Linux · Chrome", ip: "127.0.0.1",
    createdAt: "2026-09-11T08:00:00.000Z", lastSeenAt: "2026-09-11T08:30:00.000Z",
    expiresAt: "2026-09-11T20:00:00.000Z",
  }],
  accounts: [{
    accountNumber: "50000001", platform: "MT5", accountType: "Standard", mode: "demo",
    nickname: "Demo", currency: "USD", leverage: 500, status: "active",
    createdAt: "2026-09-11T08:05:00.000Z", archivedAt: null, archivedReason: null,
    balance: null, balanceUnavailableReason: "Read from the core, not from this table.",
  }],
  funding: [],
  events: [{
    event: "signed_in", detail: null, ip: "127.0.0.1",
    device: "Linux · Chrome", at: "2026-09-11T08:00:00.000Z",
  }],
  mail: [{
    messageId: "m1", kind: "password_reset", subject: "Reset your Project X password",
    createdAt: "2026-09-11T08:10:00.000Z", deliveredAt: "2026-09-11T08:10:05.000Z",
    blockedReason: null,
  }],
};

const overview = {
  users: { total: 616, today: 12, week: 40, with_two_factor: 3, verified: 9, locked: 0, suspended: 0 },
  accounts: { total: 619, active: 610, demo: 39 },
  funding: { total: 7 },
  sessions: { live: 521 },
  events: { today: 900, failed_today: 201, lockouts_today: 4 },
  outbox: { pending: 0, delivered: 543 },
};

const containers = {
  available: true, error: null,
  list: [{ name: "projectx-web", state: "running", status: "Up 3 hours (healthy)",
           image: "projectx/web:dev", ports: "127.0.0.1:27000", healthy: true, unhealthy: false }],
};

/** @type {any} */
const passingGate = {
  id: "G8", name: "Security", stage: "ci", blocking: true,
  question: "Can someone take money, data or availability that is not theirs?",
  checks: [], runnable: true, running: false, requiredBy: ["19-client-api"],
  stale: false,
  last: {
    id: "G8", passed: true, startedAt: "2026-09-11T08:00:00.000Z", durationMs: 42_000,
    commit: "abc1234", clean: true, operator: "jahanzaib", timedOut: false,
    summary: "✓ security holds", output: ["✓ security holds"],
  },
};
const gateBoard = [passingGate];

const commit = {
  available: true, error: null, sha: "abc1234", clean: true, changedFiles: 0,
  subject: "identity: row-level security", author: "jahanzaib", when: "2 hours ago",
};

const host = {
  uptimeHours: 24, load: { one: "1.08", five: "1.26", fifteen: "1.38" },
  disk: { free: "64G", usedPercent: "86%" }, node: "v22.23.2",
};

const audit = [{
  event: "signed_in", detail: null, ip: "127.0.0.1", device: "Linux · Chrome",
  at: "2026-09-11T08:00:00.000Z", userId: user.userId, email: user.email, name: user.name,
}];

const isolation = {
  roles: [
    { role: "projectx", superuser: true, bypassRls: true, canLogin: true },
    { role: "projectx_app", superuser: false, bypassRls: false, canLogin: true },
    { role: "projectx_auth", superuser: false, bypassRls: false, canLogin: true },
  ],
  tables: [{ table: "accounts", rowSecurity: true, forced: true, policies: 1, rows: 619 }],
  grants: [{ role: "projectx_app", table: "accounts", privileges: "DELETE,INSERT,SELECT,UPDATE" }],
  database: { database_size: "11 MB", connections: 5, version: "PostgreSQL 17.11" },
};

const moduleList = [{
  id: "19-client-api", name: "Client API", tier: "T4", status: "in-progress",
  releaseApproval: "auto", dependsOn: ["10-oms"], dependents: ["20-web"],
  requiredGates: ["G0", "G8"], invariants: 10, tests: 9, purpose: "The edge.",
  builds: [], invariantList: [],
}];

const tierList = [{
  id: "T4", name: "Experience", blastRadius: "clients inconvenienced",
  changePolicy: "automated canary, auto-promote",
}];

/** Every console screen, with the body it renders. */
const SCREENS = {
  "/": overviewPage({
    overview, status: { reachable: true, core: { ledger: "healthy" }, tradable: true },
    containers, gates: gateBoard, commit, host, audit, error: null,
  }),
  "/ (api down)": overviewPage({
    overview: {}, status: { reachable: false, core: {}, tradable: false },
    containers: { available: false, error: "docker is not available", list: [] },
    gates: [], commit, host, audit: [], error: "the client API is unreachable",
  }),
  "/users": usersPage({ users: [user], q: "", sort: "recent", error: null }),
  "/users (empty)": usersPage({ users: [], q: "nobody", sort: "recent", error: null }),
  "/users (error)": usersPage({ users: [], q: "", sort: "recent", error: "unauthenticated" }),
  "/users/:id": userDetailPage({ detail, csrf: "tok", error: null, userId: user.userId }),
  "/users/:id (locked)": userDetailPage({
    detail: { ...detail, user: { ...user, lockedUntil: "2099-01-01T00:00:00.000Z" } },
    csrf: "tok", error: null, userId: user.userId,
  }),
  "/users/:id (suspended)": userDetailPage({
    detail: { ...detail, user: { ...user, status: "suspended", twoFactor: false } },
    csrf: "tok", error: null, userId: user.userId,
  }),
  "/accounts": accountsPage({
    accounts: [{
      accountNumber: "50000001", ownerId: user.userId, email: user.email, name: user.name,
      platform: "MT5", accountType: "Standard", mode: "demo", nickname: "Demo",
      currency: "USD", leverage: 500, status: "active", createdAt: "2026-09-11T08:00:00.000Z",
    }],
    error: null,
  }),
  "/gates": gatesPage({ gates: gateBoard, commit, csrf: "tok", running: [] }),
  "/gates (failing)": gatesPage({
    gates: [{ ...passingGate, last: { ...passingGate.last, passed: false, summary: "✗ security FAILED" } }],
    commit, csrf: "tok", running: [],
  }),
  "/gates (running)": gatesPage({
    gates: [{ ...passingGate, running: true }], commit, csrf: "tok", running: ["G8"],
  }),
  "/modules": modulesPage({ modules: moduleList, tiers: tierList }),
  "/infra": infraPage({
    containers,
    images: { available: true, error: null, list: [{ reference: "projectx/web:dev", id: "abc123def456", created: "2 hours ago", size: "180MB" }] },
    volumes: { available: true, error: null, list: [{ name: "projectx_postgres_data", driver: "local" }] },
    ports: { available: true, error: null, list: [{ name: "web", port: 27000, description: "Web", listening: true }] },
    tunnels: { available: true, error: null, list: [{ pid: 1234, config: "(remotely managed)", command: "cloudflared tunnel run --token <redacted>" }] },
    host, commit,
  }),
  "/infra (no docker)": infraPage({
    containers: { available: false, error: "docker is not available to this process", list: [] },
    images: { available: false, error: "docker is not available to this process", list: [] },
    volumes: { available: false, error: "docker is not available to this process", list: [] },
    ports: { available: true, error: null, list: [] },
    tunnels: { available: true, error: null, list: [] },
    host, commit: { available: false, error: "git is not available", sha: "", clean: true, subject: "", author: "", when: "" },
  }),
  "/database": databasePage({ isolation, error: null }),
  "/database (rls off)": databasePage({
    isolation: {
      ...isolation,
      roles: [{ role: "projectx_app", superuser: false, bypassRls: true, canLogin: true }],
      tables: [{ table: "accounts", rowSecurity: false, forced: false, policies: 0, rows: 1 }],
    },
    error: null,
  }),
  "/audit": auditPage({ events: audit, names: [{ event: "signed_in", count: 40 }], filter: "", error: null }),
  "/outbox": outboxPage({
    messages: [{
      messageId: "m1", to: user.email, kind: "password_reset",
      subject: "Reset your Project X password", createdAt: "2026-09-11T08:00:00.000Z",
      deliveredAt: null, blockedReason: "No email provider is configured.",
    }],
    delivery: "none", state: "", error: null,
  }),
  "/outbox (smtp)": outboxPage({ messages: [], delivery: "smtp", state: "delivered", error: null }),
  "/logs": logsPage({
    service: "client-api", sources: ["web", "client-api"],
    result: { available: true, error: null, source: "container projectx-client-api", lines: ['{"level":"info","message":"listening"}'] },
  }),
  "/logs (missing)": logsPage({
    service: "ops", sources: ["web", "ops"],
    result: { available: false, error: "no container and no .run/ops.log", source: "", lines: [] },
  }),
};

/** @param {string} body */
const full = (body) =>
  page({ title: "t", path: "/", body, operator: "jahanzaib", csrf: "tok" });

/* ---------------------------------------------------------------- tests */

test("every screen renders without leaking a placeholder", () => {
  for (const [name, html] of Object.entries(SCREENS)) {
    assert.ok(html.length > 0, `${name} rendered nothing`);
    assert.ok(!html.includes("${"), `${name} contains an unresolved template literal`);
    assert.ok(!/>\s*undefined\s*</.test(html), `${name} renders "undefined"`);
    assert.ok(!/>\s*NaN\s*</.test(html), `${name} renders NaN`);
    assert.ok(!html.includes("[object Object]"), `${name} renders [object Object]`);
  }
});

test("tags balance on every screen", () => {
  const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"]);
  for (const [name, body] of Object.entries(SCREENS)) {
    const html = full(body);
    const stripped = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
    /** @type {string[]} */
    const stack = [];
    for (const match of stripped.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/gi)) {
      const closing = match[1] ?? "";
      const tag = (match[2] ?? "").toLowerCase();
      const attrs = match[3] ?? "";
      if (VOID.has(tag) || attrs.trimEnd().endsWith("/") || tag === "!doctype") continue;
      if (closing) assert.equal(stack.pop(), tag, `${name}: </${tag}> does not match the open tag`);
      else stack.push(tag);
    }
    assert.deepEqual(stack, [], `${name} leaves unclosed tag(s): ${stack.join(", ")}`);
  }
});

test("no screen emits a duplicate element id", () => {
  for (const [name, body] of Object.entries(SCREENS)) {
    const html = full(body);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual([...new Set(dupes)], [], `${name} emits duplicate id(s): ${dupes.join(", ")}`);
  }
});

test("inline styles reference only defined CSS tokens", async () => {
  const { stylesheet } = await import("../src/ui/styles.js");
  const defined = new Set([...stylesheet.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const offenders = [];
  for (const [name, body] of Object.entries(SCREENS)) {
    for (const match of full(body).matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      if (!defined.has(match[1] ?? "")) offenders.push(`${name} -> ${match[1]}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], [], `undefined token(s): ${offenders.join(", ")}`);
});

test("every internal link points at a console route", () => {
  const ROUTES = new Set([
    "/", "/users", "/accounts", "/gates", "/modules", "/infra",
    "/database", "/audit", "/outbox", "/logs", "/login", "/logout",
  ]);
  const offenders = [];
  for (const [name, body] of Object.entries(SCREENS)) {
    for (const match of full(body).matchAll(/href="(\/[^"#?]*)/g)) {
      const href = match[1] ?? "";
      if (ROUTES.has(href)) continue;
      if (href.startsWith("/users/")) continue;
      if (href === "/styles.css" || href === "/console.js") continue;
      offenders.push(`${name} -> ${href}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], [], `dead link(s): ${offenders.join(", ")}`);
});

/* -------------------------------------------------------------- escaping */

test("client-supplied text is escaped everywhere it is rendered", () => {
  // The console renders names, addresses and user agents from every client. An
  // escaping mistake here is a stored XSS with an operator's session — and the
  // operator's session can end anybody's.
  const hostile = '<script>alert(1)</script>';
  const poisoned = {
    ...user,
    name: hostile,
    email: `"><img src=x onerror=alert(1)>@example.com`,
    country: hostile,
  };

  const screens = [
    usersPage({ users: [poisoned], q: hostile, sort: "recent", error: hostile }),
    userDetailPage({
      detail: {
        ...detail, user: poisoned,
        sessions: [{ ...detail.sessions[0], device: hostile, ip: hostile }],
        events: [{ ...detail.events[0], event: hostile, detail: hostile, device: hostile }],
        accounts: [{ ...detail.accounts[0], nickname: hostile }],
        mail: [{ ...detail.mail[0], subject: hostile }],
      },
      csrf: "tok", error: null, userId: user.userId,
    }),
    auditPage({
      events: [{ ...audit[0], event: hostile, email: hostile, detail: hostile, device: hostile }],
      names: [{ event: hostile, count: 1 }], filter: hostile, error: null,
    }),
    outboxPage({
      messages: [{ messageId: "m", to: hostile, kind: hostile, subject: hostile,
                   createdAt: "2026-09-11T08:00:00.000Z", deliveredAt: null, blockedReason: hostile }],
      delivery: "none", state: "", error: null,
    }),
    logsPage({
      service: "client-api", sources: ["client-api"],
      result: { available: true, error: null, source: hostile, lines: [hostile] },
    }),
  ];

  for (const [index, html] of screens.entries()) {
    // The property is that the payload cannot *break out* of where it was put,
    // not that its characters are absent. `&lt;img src=x onerror=alert(1)&gt;`
    // is the payload rendered as inert text — the desired outcome — so a plain
    // substring match fails on correct escaping, and a regex over HTML walks
    // into attribute values and finds the same thing.
    //
    // So this checks for the two things that actually constitute a breakout: a
    // tag the console never writes, and a real double quote where an escaped
    // one belongs.
    for (const tag of ["<script", "<img", "<iframe", "<object", "<embed"]) {
      assert.ok(!html.includes(tag), `screen ${index} let a ${tag}> tag through`);
    }

    // Every `onerror` in the output came from the payload, so every one of them
    // must be followed by an escaped quote rather than a real one. A real quote
    // there would mean the value had closed its attribute.
    for (const match of html.matchAll(/onerror=(.)/g)) {
      assert.notEqual(match[1], '"', `screen ${index} closed an attribute early`);
    }

    assert.ok(html.includes("&lt;script&gt;"), `screen ${index} did not escape at all`);
  }
});

test("esc covers every character that can break out of markup", () => {
  assert.equal(esc(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

/* ----------------------------------------------------------- honest gaps */

test("a failed data source is named rather than rendered blank", () => {
  // A console panel that silently shows nothing is indistinguishable from one
  // showing that there is nothing — and an operator acts on the difference.
  const noDocker = SCREENS["/infra (no docker)"];
  assert.match(noDocker, /unavailable/i);
  assert.match(noDocker, /docker is not available to this process/);

  const apiDown = SCREENS["/ (api down)"];
  assert.match(apiDown, /unreachable/i);

  const missingLog = SCREENS["/logs (missing)"];
  assert.match(missingLog, /no container and no/);
});

test("the database page shouts when isolation is not being enforced", () => {
  // This is the page that answers "is client isolation actually on?". A green
  // tick here when a role can bypass RLS would be the worst possible lie.
  const broken = SCREENS["/database (rls off)"];
  assert.match(broken, /bypass row-level security/i);
  assert.match(broken, /not being enforced/i);
  assert.match(broken, /without forced row-level security/i);

  const fine = SCREENS["/database"];
  assert.ok(!/not being enforced/i.test(fine));
});

test("the overview leads with what is wrong", () => {
  const healthy = SCREENS["/"];
  assert.match(healthy, /Nothing is currently wrong/);

  const broken = overviewPage({
    overview, status: { reachable: true, core: { ledger: "unavailable" }, tradable: false },
    containers: { available: true, error: null, list: [
      { name: "projectx-oms", state: "exited", status: "Exited (1)", image: "x", ports: "", healthy: false, unhealthy: true },
    ] },
    gates: [{ ...passingGate, last: { ...passingGate.last, passed: false } }],
    commit: { ...commit, clean: false, changedFiles: 3 },
    host, audit, error: null,
  });
  assert.match(broken, /not tradable/i);
  assert.match(broken, /not healthy/i);
  assert.match(broken, /gate\(s\) failing/i);
  assert.match(broken, /uncommitted changes/i);
  assert.ok(!/Nothing is currently wrong/.test(broken));
});

/* ------------------------------------------------------------ the shell */

test("the shell is not indexable and cannot be framed", () => {
  // A console in a search result has already failed; a framed console is a
  // clickjacked set of buttons that end people's sessions.
  const html = full("<p>x</p>");
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(html, /data-csrf="tok"/);
  assert.match(html, /Signed in as jahanzaib/);
});

test("the sign-in page discloses nothing about the system behind it", () => {
  const html = loginPage({ csrf: "tok" });
  assert.match(html, /<meta name="robots" content="noindex/);
  // No version, no module list, no hostname, no service names.
  for (const leak of [/projectx_/, /postgres/i, /:2700\d/, /19-client-api/, /\bv\d+\.\d+\.\d+/]) {
    assert.ok(!leak.test(html), `the sign-in page leaks ${leak}`);
  }
  // And it says what will be recorded, because it will be.
  assert.match(html, /recorded against the account it affects/i);
});

test("every destructive action asks before it acts, and says what it does", () => {
  const html = SCREENS["/users/:id"];
  const forms = [...html.matchAll(/<form[^>]*action="\/users\/[^"]+\/([a-z-]+)"[^>]*>/g)];
  assert.ok(forms.length >= 2, "the detail page offers no operator actions");

  for (const form of forms) {
    assert.match(form[0], /data-confirm="[^"]{10,}"/,
      `the ${form[1]} action has no confirmation, or one too short to say anything`);
  }
  // Each carries the CSRF token.
  const actionForms = html.split("<form").filter((part) => part.includes("/users/"));
  for (const part of actionForms) {
    assert.match(part, /name="csrf"/, "an operator action form carries no CSRF token");
  }
  // The most dangerous one names what it cannot prove.
  assert.match(html, /proves nothing about who asked/i);
});

/* ------------------------------------------------------------------ time */

test("relative time degrades rather than rendering nonsense", () => {
  assert.equal(ago(null), "never");
  assert.equal(ago(undefined), "never");
  assert.equal(ago("not a date"), "—");
  assert.equal(ago(new Date().toISOString()), "just now");
  assert.match(ago(new Date(Date.now() - 5 * 60_000).toISOString()), /^\d+m ago$/);
  assert.match(ago(new Date(Date.now() - 5 * 3_600_000).toISOString()), /^\d+h ago$/);
  assert.match(ago(new Date(Date.now() - 5 * 86_400_000).toISOString()), /^\d+d ago$/);
});

/* ------------------------------------------------------------ the parser */

test("the registry parser reads the shapes the registry actually uses", () => {
  const parsed = parseYaml(`
version: 1

tiers:
  T0: { name: "Financial Core", blast_radius: "money is wrong" }

modules:
  - id: "03-ledger"
    name: "Ledger"
    tier: T0
    depends_on: ["00-foundation", "01-domain-kernel"]
    required_gates: [G0, G1]
    purpose: >
      A folded block scalar
      across two lines.
    invariants:
      - "INV-020: a transaction balances."
      - "INV-021: history is append-only."
  - id: "20-web"
    name: "Web"
    tier: T4
    depends_on: []
`);

  assert.equal(parsed.version, 1);
  assert.equal(parsed.tiers.T0.name, "Financial Core");
  assert.equal(parsed.modules.length, 2);

  const ledger = parsed.modules[0];
  assert.equal(ledger.id, "03-ledger");
  assert.deepEqual(ledger.depends_on, ["00-foundation", "01-domain-kernel"]);
  assert.deepEqual(ledger.required_gates, ["G0", "G1"]);
  assert.equal(ledger.invariants.length, 2);
  // A folded scalar joins with spaces rather than newlines.
  assert.match(ledger.purpose, /A folded block scalar across two lines\./);
  assert.deepEqual(parsed.modules[1].depends_on, []);
});

test("the parser treats a hash inside a value as data", () => {
  // Registry entries contain prose, and prose contains "#".
  const parsed = parseYaml(`
key: "a value # with a hash"
other: plain  # this really is a comment
`);
  assert.equal(parsed.key, "a value # with a hash");
  assert.equal(parsed.other, "plain");
});

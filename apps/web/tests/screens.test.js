/**
 * G2/G4 — every screen, rendered and inspected.
 *
 * The page modules are pure functions from data to HTML, so each screen can be
 * rendered in-process and asserted on. No browser, no network, milliseconds.
 *
 * What these catch, by construction rather than by review:
 *   - unresolved template literals and `undefined`/`NaN` leaking into markup
 *   - dead internal links (an href with no route behind it)
 *   - duplicate element ids
 *   - unbalanced tags
 *   - inline styles referencing an undefined CSS token
 *   - a dialog rendered without the hidden attribute
 *   - form controls with no accessible name
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { authLayout, page, initials, NAV } from "../src/ui/layout.js";
import { accountsPage, openAccountModal } from "../src/pages/accounts.js";
import { fundingPage, transferPage, transactionsPage, walletPage } from "../src/pages/funding.js";
import {
  performancePage, ordersPage, insightsPage, calendarPage, rewardsPage,
  referralsPage, profilePage, statusPage, statementsPage, helpPage,
  notFoundPage, securityPage, settingsPage, signOutPage,
} from "../src/pages/misc.js";
import { terminalPage } from "../src/pages/terminal.js";
import { DOCS, docsIndexPage, legalPage } from "../src/pages/docs.js";
import {
  instrumentsPage, feesPage, platformsPage, apiAccessPage,
  verificationPage, contactPage, aboutPage, notificationsPage,
} from "../src/pages/company.js";
import {
  loginPage, registerPage, forgotPasswordPage, resetPasswordPage, verifyEmailPage,
} from "../src/pages/auth.js";
import { stylesheet } from "../src/ui/styles.js";

/* ------------------------------------------------------------- fixtures */

const account = {
  accountNumber: "50000001", platform: "MT5", accountType: "Standard",
  mode: "real", nickname: "Long-term", currency: "USD", leverage: 200,
  status: "active", createdAt: "2026-07-01T00:00:00.000Z",
  archivedAt: null, archivedReason: null,
  balance: null, equity: null, balanceUnavailableReason: "03-ledger has not passed its gates.",
};
const archivedAccount = {
  ...account, accountNumber: "50000002", status: "archived",
  archivedAt: "2026-08-11T17:13:48.511Z",
  archivedReason: "Archived automatically after 30 days of inactivity",
};
const meta = {
  types: {
    Standard: { label: "Standard", description: "d", minDeposit: "10.00", commission: "None", spreadFrom: "0.3 pips" },
  },
  leverages: [200], currencies: ["USD"], platforms: ["MT5"],
};
const sessionUser = { name: "Ada Lovelace", email: "ada@example.com" };
const profile = {
  name: "Development User", email: "dev@projectx.local", clientId: "dev-owner-0001",
  country: "—", baseCurrency: "USD", since: "2026-01-15T00:00:00.000Z",
};

/* The terminal's inputs, shaped exactly as the API returns them. */
const instrument = {
  symbol: "EURUSD", name: "Euro / US Dollar", class: "FX major", digits: 5,
  minVolumeMilliLots: 10, maxVolumeMilliLots: 50_000,
};
const tradingAccount = {
  accountNumber: "50000001", nickname: "Demo account", mode: "demo",
  currency: "USD", leverage: 500,
};
const openPosition = {
  symbol: "EURUSD", side: "BUY", volume: "0.100", digits: 5,
  openPrice: "1.08512", mark: "1.08540", unrealised: "2.80", margin: "21.70",
  openedTick: 1_000_000, openedMs: 250_000_000,
};
const valuation = {
  balance: "9996.50", equity: "9999.30", unrealised: "2.80",
  usedMargin: "21.70", freeMargin: "9977.60", marginLevel: "46079.72",
  policyVersion: "margin-v1", positions: [openPosition],
};
const filledOrder = {
  orderId: "00000000-0000-0000-0000-00000000000a", state: "FILLED",
  symbol: "EURUSD", side: "BUY", volume: "0.100", timestampMs: 250_000_000,
  deal: { price: "1.08512", realised: "0.00", commission: "0.35" },
  rejection: null,
};
const terminalData = {
  instruments: [instrument], accounts: [tradingAccount], symbol: "EURUSD",
  interval: "1m", account: "50000001", valuation, orders: [filledOrder],
  coreReachable: true,
};

/** Every screen the router can serve, with the body it renders. */
const SCREENS = {
  "/": accountsPage({ accounts: [account], archived: [archivedAccount], mode: "real", sort: "newest", view: "list" }),
  "/ (empty)": accountsPage({ accounts: [], archived: [], mode: "real", sort: "newest", view: "grid" }),
  "/deposit": fundingPage({ kind: "deposit", accounts: [account] }),
  "/deposit (no accounts)": fundingPage({ kind: "deposit", accounts: [] }),
  "/withdraw": fundingPage({ kind: "withdrawal", accounts: [account] }),
  "/transfer": transferPage({ accounts: [account, archivedAccount] }),
  "/transactions": transactionsPage({ history: [] }),
  "/transactions (rows)": transactionsPage({
    history: [{
      requestId: "r1", kind: "deposit", method: "card", amount: "250.00",
      currency: "USD", fromAccount: null, toAccount: "50000001",
      status: "blocked_by_gate", blockedReason: "gated",
      createdAt: "2026-09-08T17:13:48.511Z",
    }],
  }),
  "/funding-wallet": walletPage(),
  "/crypto-wallet": walletPage({ crypto: true }),
  "/performance": performancePage(),
  "/orders": ordersPage(),
  "/insights": insightsPage(),
  "/insights/calendar": calendarPage(),
  "/rewards": rewardsPage(),
  "/referrals": referralsPage(),
  "/profile (signed out)": profilePage({ profile }),
  "/profile": profilePage({
    profile: {
      ...profile, name: "Ada Lovelace", email: "ada@example.com",
      clientId: "c146587f-d512-4447-bb5a-e7bdea6312c3",
      country: "United Kingdom", baseCurrency: "GBP",
      authenticated: true, emailVerified: false,
      twoFactorEnabled: true, recoveryCodesRemaining: 9,
    },
  }),
  "/status": statusPage({ core: { ledger: "healthy", oms: "unavailable" }, tradable: false }),
  "/statements/50000001": statementsPage({ account: "50000001" }),
  "/help": helpPage(),
  "/terminal": terminalPage(terminalData),
  "/terminal (no account)": terminalPage({
    ...terminalData, accounts: [], valuation: null, orders: [], account: "",
  }),
  "/terminal (core down)": terminalPage({
    ...terminalData, accounts: [], valuation: null, orders: [],
    account: "", coreReachable: false,
  }),
  "/terminal (flat account)": terminalPage({
    ...terminalData,
    valuation: { ...valuation, positions: [], usedMargin: "0.00", marginLevel: null },
    orders: [],
  }),
  "/security (signed out)": securityPage(),
  "/security": securityPage({
    user: sessionUser,
    sessions: [
      {
        sessionId: "8f14e45f-ceea-467a-9e0b-5e8a9b1f0c21", current: true,
        device: "Linux · Chrome", ip: "127.0.0.1",
        createdAt: "2026-09-10T09:00:00.000Z", lastSeenAt: "2026-09-11T08:12:00.000Z",
      },
      {
        sessionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", current: false,
        device: "iOS · Safari", ip: "203.0.113.9",
        createdAt: "2026-09-02T18:30:00.000Z", lastSeenAt: "2026-09-09T21:04:00.000Z",
      },
    ],
    twoFactorEnabled: true,
    recoveryCodesRemaining: 8,
    emailVerified: true,
    events: [
      { event: "password_changed", detail: null, ip: "127.0.0.1", device: "Linux · Chrome", at: "2026-09-11T08:12:00.000Z" },
      { event: "signed_in", detail: null, ip: "127.0.0.1", device: "Linux · Chrome", at: "2026-09-11T08:00:00.000Z" },
      { event: "locked_out", detail: "after 5 failed attempts", ip: "203.0.113.9", device: "iOS · Safari", at: "2026-09-10T22:41:00.000Z" },
      // An event the interface does not have a label for must still appear.
      { event: "some_future_event", detail: null, ip: "127.0.0.1", device: "Linux · Chrome", at: "2026-09-10T20:00:00.000Z" },
    ],
  }),
  "/security (no second factor)": securityPage({
    user: sessionUser, sessions: [], twoFactorEnabled: false, recoveryCodesRemaining: 0,
  }),
  "/settings": settingsPage(),
  "/signout": signOutPage({ user: sessionUser }),
  "/signout (signed out)": signOutPage(),
  "/login": loginPage(),
  "/login (with a reason)": loginPage({
    next: "/deposit", error: "That email address and password do not match an account.",
    email: "someone@example.com",
  }),
  "/login (second factor)": loginPage({ twoFactor: true, email: "someone@example.com" }),
  "/login (just registered)": loginPage({ registered: true }),
  "/login (signed out)": loginPage({ signedOut: true }),
  "/register": registerPage({
    countries: ["United Kingdom", "Pakistan", "Other"],
    currencies: ["USD", "EUR", "GBP"],
  }),
  "/register (rejected)": registerPage({
    countries: ["United Kingdom", "Other"], currencies: ["USD"],
    error: "An account already exists for that email address.",
    values: { name: "Ada Lovelace", email: "ada@example.com", country: "United Kingdom" },
  }),
  "/forgot-password": forgotPasswordPage(),
  "/forgot-password (sent, no provider)": forgotPasswordPage({ sent: true, email: "ada@example.com" }),
  "/forgot-password (sent, delivered)": forgotPasswordPage({
    sent: true, email: "ada@example.com", deliveryEnabled: true,
  }),
  "/forgot-password (sent, dev link)": forgotPasswordPage({
    sent: true, email: "ada@example.com",
    devLink: "/reset-password?token=aaaabbbbccccddddeeeeffff",
  }),
  "/reset-password": resetPasswordPage({ token: "aaaabbbbccccddddeeeeffff" }),
  "/reset-password (expired)": resetPasswordPage({ valid: false }),
  "/reset-password (rejected)": resetPasswordPage({
    token: "aaaabbbbccccddddeeeeffff",
    error: "Use at least 10 characters — this one has 4.",
  }),
  "/verify-email": verifyEmailPage({ verified: true, email: "ada@example.com" }),
  "/verify-email (expired)": verifyEmailPage({
    verified: false, error: "That confirmation link is no longer valid.",
  }),
  "/instruments": instrumentsPage(),
  "/fees": feesPage(),
  "/platforms": platformsPage(),
  "/api-access": apiAccessPage(),
  "/verification": verificationPage(),
  "/contact": contactPage(),
  "/about": aboutPage(),
  "/notifications": notificationsPage(),
  "/docs": docsIndexPage(),
  // Every document in the registry is rendered and asserted, not just a sample.
  ...Object.fromEntries(Object.keys(DOCS).map((slug) => [`/docs/${slug}`, legalPage(slug)])),
  "/404": notFoundPage(),
};

/** Routes the server actually handles. Kept in step with apps/web/src/server.js. */
const ROUTES = new Set([
  "/", "/deposit", "/withdraw", "/transfer", "/transactions",
  "/funding-wallet", "/crypto-wallet", "/performance", "/orders",
  "/insights", "/insights/calendar", "/rewards", "/referrals",
  "/profile", "/status", "/help", "/terminal",
  "/security", "/settings", "/signout",
  "/login", "/register", "/forgot-password", "/reset-password", "/verify-email",
  "/instruments", "/fees", "/platforms", "/api-access",
  "/verification", "/contact", "/about", "/notifications",
  "/docs",
  ...Object.keys(DOCS).map((slug) => `/docs/${slug}`),
]);
/** Route prefixes handled dynamically. */
const ROUTE_PREFIXES = ["/statements/"];

/**
 * @param {string} path
 * @param {string} body
 * @param {string} [modal]
 */
const fullPage = (path, body, modal = "") =>
  page({ title: "t", path, body, wallet: { balance: null, unavailableReason: null }, modal });

/* ---------------------------------------------------------------- tests */

test("every screen renders without leaking placeholders", () => {
  for (const [name, html] of Object.entries(SCREENS)) {
    assert.ok(html.length > 0, `${name} rendered nothing`);
    assert.ok(!html.includes("${"), `${name} contains an unresolved template literal`);
    assert.ok(!/>\s*undefined\s*</.test(html), `${name} renders the string "undefined"`);
    assert.ok(!/>\s*NaN\s*</.test(html), `${name} renders NaN`);
    assert.ok(!html.includes("[object Object]"), `${name} renders [object Object]`);
    assert.ok(!/\bnull\b(?![-\w])/.test(html.replace(/<!--[\s\S]*?-->/g, "")) || !/>\s*null\s*</.test(html),
      `${name} renders the string "null"`);
  }
});

test("every internal link points at a real route", () => {
  const offenders = [];
  for (const [name, body] of Object.entries(SCREENS)) {
    const html = fullPage("/", body, openAccountModal(meta));
    for (const match of html.matchAll(/href="(\/[^"#?]*)/g)) {
      const href = match[1] ?? "";
      if (ROUTES.has(href)) continue;
      if (ROUTE_PREFIXES.some((p) => href.startsWith(p))) continue;
      if (href === "/styles.css" || href === "/client.js") continue;
      offenders.push(`${name} -> ${href}`);
    }
  }
  assert.deepEqual(
    [...new Set(offenders)], [],
    `dead internal link(s): ${[...new Set(offenders)].join(", ")}. ` +
      "Every href must resolve to a handled route, or the person clicking it gets a 404.",
  );
});

test("no screen emits a duplicate element id", () => {
  for (const [name, body] of Object.entries(SCREENS)) {
    const html = fullPage("/", body, openAccountModal(meta));
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual([...new Set(dupes)], [], `${name} emits duplicate id(s): ${dupes.join(", ")}`);
  }
});

test("tags balance on every screen", () => {
  const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"]);
  for (const [name, body] of Object.entries(SCREENS)) {
    const html = fullPage("/", body, openAccountModal(meta));
    const stripped = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
    /** @type {string[]} */
    const stack = [];
    for (const match of stripped.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/gi)) {
      const closing = match[1] ?? "";
      const tag = match[2] ?? "";
      const attrs = match[3] ?? "";
      const name_ = tag.toLowerCase();
      if (VOID.has(name_) || attrs.trimEnd().endsWith("/")) continue;
      if (name_ === "!doctype") continue;
      if (closing) {
        assert.equal(stack.pop(), name_, `${name}: </${name_}> does not match the open tag`);
      } else {
        stack.push(name_);
      }
    }
    assert.deepEqual(stack, [], `${name} leaves unclosed tag(s): ${stack.join(", ")}`);
  }
});

test("inline styles reference only defined CSS tokens", () => {
  const defined = new Set([...stylesheet.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const offenders = [];
  for (const [name, body] of Object.entries(SCREENS)) {
    const html = fullPage("/", body, openAccountModal(meta));
    for (const match of html.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      const token = match[1] ?? "";
      if (!defined.has(token)) offenders.push(`${name} -> ${token}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], [], `undefined token(s) in markup: ${offenders.join(", ")}`);
});

test("the dialog is rendered hidden", () => {
  const modal = openAccountModal(meta);
  assert.match(modal, /class="modal-backdrop"[^>]*\shidden/,
    "the dialog must carry the hidden attribute in its initial markup");
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /aria-labelledby="[^"]+"/);
  // A dialog you cannot dismiss with the keyboard is a trap.
  assert.ok(modal.includes("data-close-modal"), "the dialog must offer a close control");
});

test("every form control has an accessible name", () => {
  const offenders = [];
  for (const [name, body] of Object.entries(SCREENS)) {
    const html = fullPage("/", body, openAccountModal(meta));
    const labelledIds = new Set(
      [...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1] ?? ""),
    );

    for (const match of html.matchAll(/<(input|select|textarea)([^>]*)>/g)) {
      const tag = match[1] ?? "";
      const attrs = match[2] ?? "";
      if (/type="(hidden|radio)"/.test(attrs)) continue;
      const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
      const named = /aria-label=|aria-labelledby=/.test(attrs)
        || (id && labelledIds.has(id))
        // Wrapped in a <label> is the pattern used throughout these pages.
        || new RegExp(`<label[^>]*>(?:(?!</label>)[\\s\\S])*${tag}`).test(html);
      if (!named) offenders.push(`${name} -> <${tag}${attrs.slice(0, 40)}>`);
    }

    for (const match of html.matchAll(/<button([^>]*)>([\s\S]{0,80}?)<\/button>/g)) {
      const attrs = match[1] ?? "";
      const inner = match[2] ?? "";
      const hasText = inner.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim().length > 0;
      if (!hasText && !/aria-label=/.test(attrs)) {
        offenders.push(`${name} -> icon-only <button${attrs.slice(0, 40)}> without aria-label`);
      }
    }
  }
  assert.deepEqual([...new Set(offenders)], [], `unlabelled control(s): ${offenders.join(" | ")}`);
});

test("no screen renders a fabricated financial figure", () => {
  // INV-183/INV-190: an unknown balance is reported, never invented.
  const MONEY = /(?:^|[>\s])(?:\$|€|£)\s?\d|(?:\d+\.\d{2})\s*(?:USD|EUR|GBP)/;
  for (const [name, body] of Object.entries(SCREENS)) {
    if (name.startsWith("/deposit") || name === "/withdraw" || name === "/transfer") continue; // min-deposit copy
    if (name.startsWith("/transactions (rows)")) continue; // echoes a recorded intent
    const balances = [...body.matchAll(/class="(?:account-balance|stat-value)[^"]*"[^>]*>([^<]*)</g)]
      .map((m) => (m[1] ?? "").trim());
    for (const value of balances) {
      assert.ok(!MONEY.test(value), `${name} renders a money value "${value}" in a balance slot`);
    }
  }
});

test("navigation entries all resolve", () => {
  for (const group of NAV) {
    for (const item of group.items) {
      assert.ok(
        ROUTES.has(item.href) || ROUTE_PREFIXES.some((p) => item.href.startsWith(p)),
        `nav item "${item.label}" points at ${item.href}, which no route handles`,
      );
    }
  }
});

test("every navigation item renders an icon", () => {
  // The collapsed rail hides labels and shows icons only. An item without an
  // icon renders as an empty 36px box — which is exactly what shipped before
  // this test existed.
  for (const group of NAV) {
    for (const item of group.items) {
      assert.ok(item.icon, `nav item "${item.label}" declares no icon`);
    }
  }

  // And prove it survives rendering, not just the data.
  const html = fullPage("/", SCREENS["/"], "");
  const navItems = [...html.matchAll(/<a class="nav-item"[\s\S]*?<\/a>/g)].map((m) => m[0]);
  assert.ok(navItems.length >= 10, `expected the full nav, found ${navItems.length} items`);
  for (const item of navItems) {
    assert.ok(item.includes("<svg"), `a nav item renders no icon: ${item.slice(0, 90)}`);
  }
});

test("the footer is banded and every band constrains its content", () => {
  // Without an inner wrapper a band runs full-bleed while everything above it
  // is centred at --content-max, which reads as a broken left edge.
  const html = fullPage("/", SCREENS["/"], "");

  const bands = [...html.matchAll(/<div class="footer-band">\s*<div class="footer-inner/g)];
  assert.ok(
    bands.length >= 3,
    `expected at least 3 separated footer bands, found ${bands.length}`,
  );

  // Navigation, the risk disclosure, and the legal line are distinct bands.
  for (const marker of ["footer-top", "footer-risk", "footer-bottom"]) {
    assert.ok(html.includes(marker), `the footer is missing its ${marker} band`);
  }
});

test("the footer carries the full document suite", () => {
  // On a financial site the absence of these documents is itself a signal, so
  // the whole registry must be reachable from the footer rather than a sample.
  const html = fullPage("/", SCREENS["/"], "");
  const linked = new Set(
    [...html.matchAll(/href="(\/docs\/[a-z-]+)"/g)].map((m) => m[1]),
  );

  const missing = Object.keys(DOCS)
    .map((slug) => `/docs/${slug}`)
    .filter((href) => !linked.has(href));

  // The index is linked too, so anything not in the footer is still one click away.
  assert.ok(html.includes('href="/docs"'), "the footer must link the document index");
  assert.ok(
    missing.length <= Object.keys(DOCS).length / 2,
    `most documents should be linked directly from the footer; missing: ${missing.join(", ")}`,
  );

  // The risk warning and the not-regulated statement are not optional.
  assert.match(html, /Risk warning/, "the footer must carry a risk warning");
  assert.match(html, /Not a regulated firm/, "the footer must state the regulatory position");
});

test("every document renders with its own title and sections", () => {
  for (const [slug, doc] of Object.entries(DOCS)) {
    const html = legalPage(slug);
    assert.ok(html.includes(doc.title), `${slug} does not render its title`);
    assert.ok(doc.sections.length >= 4, `${slug} has only ${doc.sections.length} sections`);
    for (const [heading] of doc.sections) {
      assert.ok(html.includes(heading), `${slug} does not render section "${heading}"`);
    }
  }
});

test("no document invents a licence, regulator or registration number", () => {
  // A plausible-looking licence number is the single most common feature of a
  // fraudulent broker site. This asserts the documents never grow one.
  const FABRICATED = [
    /licence number\s+[A-Z0-9-]{3,}/i,
    /registration number\s+\d/i,
    /authorised (?:and regulated )?by the [A-Z]/,
    /\bFCA\b|\bCySEC\b|\bASIC\b|\bFSA\b(?! )/,
  ];
  for (const [slug, doc] of Object.entries(DOCS)) {
    const text = doc.sections.map(([h, t]) => `${h} ${t}`).join(" ");
    for (const pattern of FABRICATED) {
      assert.equal(
        pattern.test(text), false,
        `${slug} appears to state a real authorisation: ${pattern.exec(text)?.[0]}`,
      );
    }
  }
});

/* -------------------------------------------------------- identity screens */

test("the auth forms work without JavaScript", () => {
  // Each is a real form with a real method and action. client.js upgrades them
  // to fetch-and-toast, but a login that only works when a script loaded is a
  // login that fails silently for the people least able to diagnose it.
  /** @type {Array<[string, string]>} */
  const forms = [
    ["login", loginPage()],
    ["register", registerPage()],
  ];
  for (const [name, html] of forms) {
    assert.match(html, /<form[^>]*method="post"/, `the ${name} form must post without a script`);
    assert.match(html, new RegExp(`<form[^>]*action="/${name}"`), `the ${name} form needs an action`);
    assert.match(html, /<button[^>]*type="submit"/, `the ${name} form needs a submit button`);
  }

  // Sign-out posts rather than links, so a prefetch or an <img> on another site
  // cannot end somebody's session by being fetched.
  const signOut = signOutPage({ user: sessionUser });
  assert.match(signOut, /<form[^>]*method="post"[^>]*action="\/signout"/);
});

test("password fields carry the autocomplete a manager needs", () => {
  // Wrong values here are why password managers offer to save a password on a
  // login form, and offer the old password on a change-password form.
  const login = loginPage();
  assert.match(login, /id="login-email"[^>]*autocomplete="username"/);
  assert.match(login, /id="login-password"[^>]*autocomplete="current-password"/);
  assert.match(login, /id="login-totp"[^>]*autocomplete="one-time-code"/);

  const register = registerPage();
  assert.match(register, /id="register-password"[^>]*autocomplete="new-password"/);
  assert.match(register, /id="register-confirm"[^>]*autocomplete="new-password"/);

  const security = securityPage({ user: sessionUser, sessions: [] });
  assert.match(security, /id="current-password"[^>]*autocomplete="current-password"/);
  assert.match(security, /id="new-password"[^>]*autocomplete="new-password"/);
});

test("no password is ever rendered back into the markup", () => {
  // A form re-rendered after a failure must not echo what was typed. A password
  // in the HTML is a password in the bfcache, in the page source, and in any
  // screenshot of the failure.
  const rendered = [
    loginPage({ email: "someone@example.com", error: "wrong" }),
    registerPage({ values: { name: "Ada", email: "ada@example.com" }, error: "taken" }),
  ];
  for (const html of rendered) {
    for (const match of html.matchAll(/<input[^>]*type="password"[^>]*>/g)) {
      assert.ok(
        !/\svalue=/.test(match[0] ?? ""),
        `a password input carries a value attribute: ${match[0]}`,
      );
    }
  }
});

test("the security page never server-renders a two-factor secret", () => {
  // The secret arrives from the enrolment endpoint, into a panel client.js
  // fills. Rendering it into the initial HTML would put it in the back/forward
  // cache and in the source of a page people screen-share.
  const html = securityPage({
    user: sessionUser, sessions: [], twoFactorEnabled: true, recoveryCodesRemaining: 10,
  });
  assert.match(html, /data-totp-panel[^>]*hidden/, "the enrolment panel must start empty and hidden");
  // A base32 secret is 32 characters of A-Z2-7. Nothing of that shape may appear.
  const suspicious = html.match(/\b[A-Z2-7]{32}\b/);
  assert.equal(suspicious, null, `something secret-shaped is in the markup: ${suspicious?.[0]}`);
  assert.ok(!/otpauth:\/\//.test(html), "the otpauth URI must not be server-rendered");
});

test("every error slot is wired to the field it describes", () => {
  // An error that is only a red border is not an error to anyone who cannot see
  // it. Each message element must exist up front, carry role="alert", and be
  // named by its input's aria-describedby — associations made after the error
  // appears are not reliably announced.
  /** @type {Array<[string, string]>} */
  const screens = [
    ["login", loginPage()],
    ["register", registerPage()],
    ["security", securityPage({ user: sessionUser, sessions: [] })],
  ];
  for (const [name, html] of screens) {
    const described = new Set();
    for (const match of html.matchAll(/aria-describedby="([^"]+)"/g)) {
      for (const id of (match[1] ?? "").split(/\s+/)) described.add(id);
    }
    const errorSlots = [...html.matchAll(/<p class="field-error" id="([^"]+)"/g)]
      .map((m) => m[1] ?? "")
      .filter(Boolean);
    assert.ok(errorSlots.length > 0, `${name} renders no field-error slots`);
    for (const id of errorSlots) {
      assert.ok(described.has(id), `${name}: ${id} exists but no input points at it`);
      assert.match(
        html,
        new RegExp(`id="${id}"[^>]*role="alert"`),
        `${name}: ${id} must carry role="alert"`,
      );
    }
  }
});

test("the signed-out shell offers a way in and shows no account data", () => {
  const html = authLayout({ title: "Sign in", body: loginPage() });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<title>Sign in · Project X<\/title>/);

  // No sidebar and no balance chip: neither means anything without a session,
  // and a nav full of links that all bounce to /login is worse than no nav.
  assert.ok(!html.includes('class="sidebar"'), "the auth shell must not render the sidebar");
  assert.ok(!html.includes("balance-chip"), "the auth shell must not render a balance");

  // The risk warning stays. Somebody deciding whether to register is exactly
  // who needs it, and putting it behind registration would be the wrong way round.
  assert.match(html, /Risk warning/);
  assert.match(html, /Not a regulated firm/);
});

test("the signed-in shell names the person and the signed-out one does not", () => {
  const signedIn = page({
    title: "t", path: "/", body: "<p>x</p>",
    wallet: { balance: null, unavailableReason: null },
    user: { name: "Ada Lovelace", email: "ada@example.com" },
  });
  assert.match(signedIn, /data-profile-name>Ada Lovelace</);
  assert.match(signedIn, /data-profile-email>ada@example\.com</);
  assert.match(signedIn, /class="avatar"[^>]*>AL</);
  assert.ok(!signedIn.includes('href="/register"'), "a signed-in shell must not invite registration");

  const signedOut = page({
    title: "t", path: "/", body: "<p>x</p>",
    wallet: { balance: null, unavailableReason: null },
  });
  assert.match(signedOut, /href="\/login"/);
  assert.match(signedOut, /href="\/register"/);
  assert.ok(!signedOut.includes("data-profile-email"), "a signed-out shell must not render a profile menu");
});

test("initials degrade instead of rendering an empty circle", () => {
  assert.equal(initials("Ada Lovelace"), "AL");
  assert.equal(initials("Ada Countess Lovelace"), "AL");
  assert.equal(initials("Prince"), "P");
  assert.equal(initials("  spaced   out  "), "SO");
  // An unparseable name gives a glyph, never "" — an avatar with no letters in
  // it reads as a broken image rather than as a person.
  assert.equal(initials(""), "·");
  assert.equal(initials("   "), "·");
  // Non-ASCII names must give their own first letter, not a mangled byte.
  assert.equal(initials("Åsa Öberg"), "ÅÖ");
  assert.equal(initials("鈴木 一郎"), "鈴一");
});

test("the reset flow never claims an email was sent, and never says who has an account", () => {
  // Two separate lies this guards against, both of which a reset page is the
  // natural home for.
  //
  // The first is claiming delivery. There is no email provider here, so a page
  // saying "check your inbox" sends somebody who is already locked out to wait
  // for a message that will never arrive.
  // Without a provider it must not imply one, and must say so plainly.
  const sent = forgotPasswordPage({ sent: true, email: "ada@example.com" });
  assert.ok(
    !/check your inbox|we have sent|sent you an email|on its way/i.test(sent),
    "with no provider the confirmation must not claim an email was delivered",
  );
  assert.match(sent, /no email provider|not.*emailed/i, "it must say the link was not delivered");

  // And with one, the opposite lie is just as bad: telling somebody nothing was
  // sent sends them hunting for a workaround they do not need.
  const delivered = forgotPasswordPage({
    sent: true, email: "ada@example.com", deliveryEnabled: true,
  });
  assert.match(delivered, /check your inbox/i, "with a provider it must say where the link went");
  assert.ok(
    !/no email provider/i.test(delivered),
    "with a provider it must not claim there is none",
  );
  // The development link is never offered once mail actually goes somewhere —
  // a live reset link rendered into a page is a live reset link on a screen.
  assert.ok(!/Development only/i.test(delivered));

  // The second is account enumeration. "If that address has an account" is the
  // whole point — "no account with that address" answers, for anyone who asks,
  // which addresses bank here.
  assert.match(sent, /if that address has an account/i);
  for (const leak of [/no account/i, /not registered/i, /we could not find/i, /unknown address/i]) {
    assert.ok(!leak.test(sent), `the confirmation reveals whether the address exists: ${leak}`);
  }

  // The ask itself collects an address, which is now correct — it has a real
  // reset behind it.
  const ask = forgotPasswordPage();
  assert.match(ask, /<input[^>]*type="email"/, "it must collect the address it will reset");
  assert.match(ask, /<form[^>]*method="post"[^>]*action="\/forgot-password"/);
  assert.match(ask, /href="\/login"/, "it must offer the way back");
});

test("a spent or expired reset link cannot present a password form", () => {
  // The failure this prevents is a form that accepts a new password and then
  // discards it, which reads to the person as "my reset did not work" and to
  // the operator as nothing at all.
  const expired = resetPasswordPage({ valid: false });
  assert.ok(
    !/<input[^>]*type="password"/.test(expired),
    "an invalid token must not render a password field",
  );
  assert.match(expired, /nothing has changed/i);
  assert.match(expired, /href="\/forgot-password"/, "it must offer a fresh link");

  // And the valid case says what setting a password will do before it is set.
  const valid = resetPasswordPage({ token: "aaaabbbbccccddddeeeeffff" });
  assert.match(valid, /<input[^>]*type="password"/);
  assert.match(valid, /signs out every device/i);
  // The token rides in a hidden field, never in a visible one.
  assert.match(valid, /<input type="hidden" name="token"/);
});

test("the activity log shows an event it has no label for", () => {
  // An audit trail that silently drops what it does not recognise is worse than
  // one showing an ugly identifier: the reader believes they have seen
  // everything that happened.
  const html = securityPage({
    user: sessionUser, sessions: [],
    events: [
      { event: "signed_in", detail: null, ip: "127.0.0.1", device: "Linux · Chrome", at: "2026-09-11T08:00:00.000Z" },
      { event: "some_future_event", detail: null, ip: "127.0.0.1", device: "Linux · Chrome", at: "2026-09-11T07:00:00.000Z" },
    ],
  });
  assert.match(html, /Signed in/, "a known event renders its label");
  assert.match(html, /some_future_event/, "an unknown event renders its identifier rather than vanishing");
});

test("the audit trail never renders a credential", () => {
  // An audit log is read by more people than the tables it describes, and is
  // exported and retained for longer. Nothing secret may reach it.
  const html = securityPage({
    user: sessionUser, sessions: [], twoFactorEnabled: true, recoveryCodesRemaining: 4,
    events: [
      { event: "password_changed", detail: null, ip: "127.0.0.1", device: "Linux · Chrome", at: "2026-09-11T08:00:00.000Z" },
    ],
  });
  for (const forbidden of [/password_hash/, /token_digest/, /scrypt\$/, /\b[A-Z2-7]{32}\b/]) {
    assert.ok(!forbidden.test(html), `something credential-shaped reached the page: ${forbidden}`);
  }
});

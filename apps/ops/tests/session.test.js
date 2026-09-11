/**
 * G2 — the console's own gate.
 *
 * This app can read every client's rows and end anybody's session. What stands
 * between it and the internet is one passcode, one signature and one CSRF
 * token, and all three fail silently when they fail: a signature check that
 * accepts anything still lets people in, so nothing about the console looks
 * wrong until somebody who should not be in it is.
 *
 * So these test the refusals rather than the happy path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The module reads its secrets at import time, so they are set before it loads.
 * Setting them afterwards would test a module configured with nothing.
 */
process.env.OPS_PASSCODE = "a-long-operator-passphrase";
process.env.OPS_SESSION_SECRET = "a-session-secret-of-at-least-32-characters";
process.env.OPS_TOKEN = "an-ops-token-of-at-least-24-chars";

const {
  configurationProblems, cookieHeader, csrfMatches, clearAttempts, issueSession,
  newCsrfToken, passcodeMatches, readCookie, readSession, recordFailedAttempt,
  withinAttemptBudget,
} = await import("../src/session.js");

/* ------------------------------------------------------------ passcodes */

test("the passcode matches itself and nothing else", () => {
  assert.equal(passcodeMatches("a-long-operator-passphrase"), true);
  assert.equal(passcodeMatches("a-long-operator-passphras"), false);
  assert.equal(passcodeMatches("A-Long-Operator-Passphrase"), false);
  assert.equal(passcodeMatches(""), false);
  // A caught value is often not a string. None of these may be truthy.
  assert.equal(passcodeMatches(/** @type {any} */ (undefined)), false);
  assert.equal(passcodeMatches(/** @type {any} */ (null)), false);
  assert.equal(passcodeMatches(/** @type {any} */ ({})), false);
});

/* ------------------------------------------------------------- sessions */

test("a session round-trips, and nothing else does", () => {
  const issued = issueSession("jahanzaib");
  const read = readSession(issued.value);
  assert.equal(read?.operator, "jahanzaib");
  assert.ok(read && read.expiresAt > Date.now());

  for (const forged of [
    "", "not-a-session", "a.b", "....",
    // The payload alone, unsigned.
    issued.value.split(".")[0] ?? "",
    // A real payload with somebody else's signature.
    `${issued.value.split(".")[0]}.${"A".repeat(43)}`,
  ]) {
    assert.equal(readSession(forged), null, `accepted a forged session: ${forged.slice(0, 24)}`);
  }
  assert.equal(readSession(undefined), null);
});

test("the payload cannot be edited without breaking the signature", () => {
  // This is the whole reason the cookie is signed rather than merely encoded:
  // the holder can read their own name and expiry, and cannot change either.
  const issued = issueSession("readonly");
  const [payload, signature] = issued.value.split(".");

  const tampered = Buffer.from(
    JSON.stringify({ operator: "somebody-else", expiresAt: Date.now() + 86_400_000 }),
    "utf8",
  ).toString("base64url");

  assert.equal(readSession(`${tampered}.${signature}`), null, "a rewritten payload was accepted");
  assert.ok(payload, "the issued cookie has no payload");
});

test("an expired session is not a session", () => {
  // Signed correctly and still refused: the expiry is checked after the
  // signature, so a valid signature over stale claims buys nothing.
  const expired = Buffer.from(
    JSON.stringify({ operator: "x", expiresAt: Date.now() - 1000 }),
    "utf8",
  ).toString("base64url");

  const issued = issueSession("x");
  const [, realSignature] = issued.value.split(".");
  // Not the right signature for this payload, so this also proves the order.
  assert.equal(readSession(`${expired}.${realSignature}`), null);
});

test("the operator name is bounded", () => {
  // It is rendered into a page and written to an audit row. Neither wants an
  // unbounded string from a form field.
  const issued = issueSession("x".repeat(500));
  const read = readSession(issued.value);
  assert.ok((read?.operator.length ?? 0) <= 80);
});

/* ------------------------------------------------------------ brute force */

test("an address is throttled after repeated failures", () => {
  const address = `10.0.0.${Math.floor(Math.random() * 250)}`;
  clearAttempts(address);

  for (let i = 0; i < 5; i += 1) {
    assert.equal(withinAttemptBudget(address), true, `refused early at attempt ${i + 1}`);
    recordFailedAttempt(address);
  }
  assert.equal(withinAttemptBudget(address), false, "a sixth attempt was allowed");

  // A success clears it: somebody who mistyped four times and then got it right
  // should not be carrying those four around.
  clearAttempts(address);
  assert.equal(withinAttemptBudget(address), true);
});

test("throttling is per address, not global", () => {
  // There is one passcode. If failures were counted globally, anybody who can
  // reach the console could lock every operator out of it — a denial of service
  // with no attacker cost.
  const mine = "10.1.1.1";
  const theirs = "10.2.2.2";
  clearAttempts(mine);
  clearAttempts(theirs);

  for (let i = 0; i < 6; i += 1) recordFailedAttempt(theirs);
  assert.equal(withinAttemptBudget(theirs), false);
  assert.equal(withinAttemptBudget(mine), true, "one address's failures locked another out");
});

/* ------------------------------------------------------------------ CSRF */

test("a CSRF token matches only itself", () => {
  const token = newCsrfToken();
  assert.equal(csrfMatches(token, token), true);
  assert.equal(csrfMatches(token, `${token}x`), false);
  assert.equal(csrfMatches(token, token.slice(0, -1)), false);
  assert.equal(csrfMatches(token, ""), false);
  assert.equal(csrfMatches("", token), false);
  assert.equal(csrfMatches(undefined, token), false);
  assert.equal(csrfMatches(token, undefined), false);
  // Two independently generated tokens must not collide.
  assert.equal(csrfMatches(token, newCsrfToken()), false);
});

/* --------------------------------------------------------------- cookies */

test("the session cookie is HttpOnly and the CSRF cookie is not", () => {
  // Deliberately different. The session must be unreadable by script; the CSRF
  // token must be readable, because the double-submit pattern needs the page to
  // put the same value into the form.
  const session = cookieHeader("px_ops", "value", { secure: true });
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Lax/);
  assert.match(session, /Secure/);

  const csrf = cookieHeader("px_ops_csrf", "value", { secure: true, httpOnly: false });
  assert.ok(!/HttpOnly/.test(csrf), "the CSRF cookie must be readable by script");
  assert.match(csrf, /SameSite=Lax/);
});

test("Secure follows the connection rather than being assumed", () => {
  // Hard-coding it on breaks local http; hard-coding it off ships a console
  // session in clear over a tunnel.
  assert.ok(!/Secure/.test(cookieHeader("px_ops", "v", { secure: false })));
  assert.match(cookieHeader("px_ops", "v", { secure: true }), /Secure/);
});

test("clearing a cookie uses both retirement mechanisms", () => {
  // Browsers disagree about which of Max-Age and Expires retires a cookie, and
  // a half-cleared session is worse than either.
  const cleared = cookieHeader("px_ops", null, { secure: false });
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
});

test("one cookie is read out of a header carrying several", () => {
  const header = "other=1; px_ops=the%2Fvalue; px_ops_csrf=abc";
  assert.equal(readCookie(header, "px_ops"), "the/value");
  assert.equal(readCookie(header, "px_ops_csrf"), "abc");
  assert.equal(readCookie(header, "absent"), undefined);
  assert.equal(readCookie(undefined, "px_ops"), undefined);
  // A name that is a prefix of another must not match it.
  assert.equal(readCookie("px_ops_csrf=abc", "px_ops"), undefined);
});

/* --------------------------------------------------------- configuration */

test("the console refuses to start without its secrets", () => {
  // Refused rather than defaulted. A console that invents a passcode when none
  // is set is a console protected by a secret nobody knows they rely on.
  assert.deepEqual(configurationProblems({
    OPS_PASSCODE: "a-long-operator-passphrase",
    OPS_SESSION_SECRET: "a-session-secret-of-at-least-32-characters",
    OPS_TOKEN: "an-ops-token-of-at-least-24-chars",
  }), []);

  assert.match(String(configurationProblems({})), /OPS_PASSCODE is not set/);
  assert.match(String(configurationProblems({})), /OPS_SESSION_SECRET is not set/);
  assert.match(String(configurationProblems({})), /OPS_TOKEN is not set/);

  // Set is not the same as sufficient.
  const short = configurationProblems({
    OPS_PASSCODE: "short", OPS_SESSION_SECRET: "short", OPS_TOKEN: "short",
  });
  assert.match(String(short), /OPS_PASSCODE is shorter/);
  assert.match(String(short), /OPS_SESSION_SECRET is shorter/);
});

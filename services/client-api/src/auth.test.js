/**
 * G2 — the parts of authentication that can be proven without a database.
 *
 * Password hashing, TOTP, base32 and the policy functions are pure, and they
 * are also the parts where a mistake is silent: a comparison that always
 * returns true, a verifier that accepts a malformed record, a TOTP window that
 * is wider than intended. None of those break a flow — they just quietly stop
 * protecting anything, which is why they are tested here rather than left to
 * the end-to-end suite.
 *
 * The database-backed half (register, login, sessions, lockout) is proven in
 * `tests/e2e/specs/auth.spec.js` against the real schema.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  base32Decode, base32Encode, currentTotp, describeUserAgent, hashPassword,
  passwordProblems, passwordScore, requireEmail, requireName, verifyPassword,
  verifyTotp,
} from "./auth.js";

/* ------------------------------------------------------------- passwords */

test("a password verifies against its own hash and nothing else", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("correct horse battery stapl", hash), false);
  assert.equal(await verifyPassword("", hash), false);
  // Case matters. A verifier that folds case halves the search space.
  assert.equal(await verifyPassword("Correct Horse Battery Staple", hash), false);
});

test("the same password hashes differently every time", async () => {
  const a = await hashPassword("the same password");
  const b = await hashPassword("the same password");
  assert.notEqual(a, b, "a repeated hash means the salt is not random");
  // Both still verify — the salt travels with the digest.
  assert.equal(await verifyPassword("the same password", a), true);
  assert.equal(await verifyPassword("the same password", b), true);
});

test("the stored format carries its own cost parameters", async () => {
  const hash = await hashPassword("a password");
  const parts = hash.split("$");
  assert.equal(parts.length, 6);
  assert.equal(parts[0], "scrypt");
  assert.ok(Number(parts[1]) >= 16_384, "scrypt N must not be weakened");
  // The plaintext must appear nowhere in the stored record.
  assert.ok(!hash.includes("a password"));
});

test("a malformed stored record is refused, not trusted and not thrown on", async () => {
  for (const broken of [
    "", "not-a-hash", "scrypt$", "scrypt$1$2$3$4", "bcrypt$16384$8$1$aaaa$bbbb",
    "scrypt$abc$8$1$aaaa$bbbb", "scrypt$16384$8$1$$", "scrypt$16384$8$1$aaaa$",
    // A hostile row asking for a cost parameter that would never return.
    "scrypt$999999999$8$1$aaaa$bbbb", "scrypt$16384$9999$1$aaaa$bbbb",
  ]) {
    assert.equal(
      await verifyPassword("anything", broken), false,
      `a corrupt record (${broken.slice(0, 24)}) must refuse, never authenticate`,
    );
  }
  // Including the undefined and null a database NULL becomes.
  assert.equal(await verifyPassword("anything", /** @type {any} */ (undefined)), false);
  assert.equal(await verifyPassword("anything", /** @type {any} */ (null)), false);
});

test("password policy names the rule that was broken", () => {
  assert.deepEqual(passwordProblems("a-long-enough-one"), []);

  const short = passwordProblems("short");
  assert.equal(short.length, 1);
  assert.match(short[0] ?? "", /at least 10 characters/);
  // The message says what they actually typed, so the fix is obvious.
  assert.match(short[0] ?? "", /has 5/);

  assert.match(String(passwordProblems("password123")), /commonly used/);
  assert.match(String(passwordProblems("aaaaaaaaaaaa")), /repeated character/);
  assert.match(String(passwordProblems("")), /Enter a password/);
  assert.match(String(passwordProblems(undefined)), /Enter a password/);
  assert.match(String(passwordProblems(12345678901)), /Enter a password/);
});

test("a password may not contain the email or the name it protects", () => {
  assert.match(
    String(passwordProblems("jahanzaib-secret", { email: "jahanzaib@example.com" })),
    /must not contain your email/,
  );
  assert.match(
    String(passwordProblems("winston smith 1984", { name: "Winston Smith" })),
    /must not contain your name/,
  );
  // A short local part must not make every password containing it illegal.
  assert.deepEqual(passwordProblems("a-fine-password", { email: "jo@example.com" }), []);
});

test("the strength meter never flatters a password the policy refuses", () => {
  // This is the coupling that matters: a meter is advice, the policy is the
  // gate, and a meter that scores a refused password highly teaches people to
  // trust it.
  for (const refused of ["password123", "aaaaaaaaaa", "0123456789"]) {
    assert.equal(passwordScore(refused), 0, `${refused} must score zero`);
    assert.ok(passwordProblems(refused).length > 0);
  }
  assert.equal(passwordScore(""), 0);
  assert.ok(passwordScore("Tr0ub4dor&3-longer-still") >= 3);
  assert.ok(passwordScore("short") < 2);
  // Scores stay inside the range the meter renders.
  for (const value of ["", "a", "abcdefghij", "A1!abcdefghijklmnopqrstuv"]) {
    const score = passwordScore(value);
    assert.ok(score >= 0 && score <= 4, `${value} scored ${score}, outside 0-4`);
  }
});

/* ----------------------------------------------------------- email, name */

test("email validation accepts real addresses and rejects non-addresses", () => {
  for (const good of [
    "a@b.co", "first.last@example.com", "user+tag@example.co.uk",
    "UPPER@EXAMPLE.COM", "  spaced@example.com  ",
  ]) {
    assert.doesNotThrow(() => requireEmail(good), `${good} should be accepted`);
  }
  // Normalised: stored and compared in one case, with no surrounding space.
  assert.equal(requireEmail("  UPPER@Example.COM "), "upper@example.com");

  for (const bad of ["", "no-at-sign", "@example.com", "a@b", "a b@example.com", "a@@b.com"]) {
    assert.throws(() => requireEmail(bad), /valid email/, `${bad} should be rejected`);
  }
  assert.throws(() => requireEmail(`${"a".repeat(250)}@example.com`), /valid email/);
});

test("names are normalised and control characters refused", () => {
  assert.equal(requireName("  Ada   Lovelace "), "Ada Lovelace");
  assert.equal(requireName("Ould-Aoudia"), "Ould-Aoudia");
  assert.throws(() => requireName("A"), /full name/);
  assert.throws(() => requireName(""), /full name/);
  assert.throws(() => requireName("x".repeat(200)), /too long/);
  // Newlines and tabs are folded into spaces before anything else looks at
  // the value, so a name pasted out of a spreadsheet is accepted and arrives
  // single-line. That is what stops a newline reaching a log line or an email
  // header — not a refusal, but the fact that it no longer exists by then.
  assert.equal(
    requireName("Ada\nBcc: someone@example.com"),
    "Ada Bcc: someone@example.com",
    "a newline must be collapsed, never stored",
  );
  assert.equal(requireName("Ada\tLovelace"), "Ada Lovelace");
  assert.ok(!requireName("Ada\r\nLovelace").includes("\n"));

  // The control characters that are not whitespace survive that fold, and are
  // refused. Nobody types a NUL into a name field by accident.
  assert.throws(() => requireName("Ada\u0000Lovelace"), /cannot store/);
  assert.throws(() => requireName("Ada\u007fLovelace"), /cannot store/);
});

/* ----------------------------------------------------------------- base32 */

test("base32 round-trips every length that matters", () => {
  for (let length = 1; length <= 40; length += 1) {
    const original = randomBytes(length);
    const encoded = base32Encode(original);
    assert.match(encoded, /^[A-Z2-7]+$/, "base32 must use the RFC 4648 alphabet");
    assert.deepEqual(base32Decode(encoded), original, `round trip failed at ${length} bytes`);
  }
});

test("base32 decoding refuses characters outside the alphabet", () => {
  // 0, 1 and 8 are excluded precisely because they are misread as O, I and B.
  assert.throws(() => base32Decode("ABC0DEF"), /valid authenticator secret/);
  assert.throws(() => base32Decode("hello!"), /valid authenticator secret/);
  // Padding and spaces are tolerated: people paste secrets with both.
  assert.doesNotThrow(() => base32Decode("MFRGG === "));
});

/* ------------------------------------------------------------------ TOTP */

test("a TOTP code verifies within its window and not outside it", () => {
  const secret = base32Encode(randomBytes(20));
  const now = 1_700_000_000_000;

  assert.equal(verifyTotp(secret, currentTotp(secret, now), now), true);

  // One step of drift either way is accepted — clocks disagree.
  assert.equal(verifyTotp(secret, currentTotp(secret, now - 30_000), now), true);
  assert.equal(verifyTotp(secret, currentTotp(secret, now + 30_000), now), true);

  // Two steps is not. A wider window is a longer replay opportunity.
  assert.equal(verifyTotp(secret, currentTotp(secret, now - 90_000), now), false);
  assert.equal(verifyTotp(secret, currentTotp(secret, now + 90_000), now), false);
});

test("a TOTP code from a different secret never verifies", () => {
  const mine = base32Encode(randomBytes(20));
  const theirs = base32Encode(randomBytes(20));
  const now = 1_700_000_000_000;
  assert.equal(verifyTotp(mine, currentTotp(theirs, now), now), false);
});

test("malformed TOTP input is refused without throwing", () => {
  const secret = base32Encode(randomBytes(20));
  for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56 78", "000000000"]) {
    assert.equal(verifyTotp(secret, bad), false, `${bad} must not verify`);
  }
  assert.equal(verifyTotp(secret, /** @type {any} */ (undefined)), false);
  assert.equal(verifyTotp(secret, /** @type {any} */ (null)), false);
  // Spaces inside a six-digit code are stripped — authenticators display them.
  const now = 1_700_000_000_000;
  const code = currentTotp(secret, now);
  assert.equal(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now), true);
});

test("TOTP output is six digits, always", () => {
  const secret = base32Encode(randomBytes(20));
  // Including the ~10% of counters whose truncated value is short enough to
  // need padding — an unpadded five-digit code is rejected by every app.
  for (let step = 0; step < 500; step += 1) {
    const code = currentTotp(secret, step * 30_000);
    assert.match(code, /^\d{6}$/, `step ${step} produced "${code}"`);
  }
});

test("TOTP matches the RFC 6238 published vectors", () => {
  // The RFC's SHA-1 test key is the ASCII "12345678901234567890".
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  /** @type {Array<[number, string]>} */
  const vectors = [
    [59_000, "287082"],
    [1_111_111_109_000, "081804"],
    [1_111_111_111_000, "050471"],
    [1_234_567_890_000, "005924"],
    [2_000_000_000_000, "279037"],
  ];
  for (const [ms, expected] of vectors) {
    assert.equal(currentTotp(secret, ms), expected, `RFC vector at ${ms} failed`);
  }
});

/* ------------------------------------------------------------ user agent */

test("a user agent is described as something a person recognises", () => {
  assert.equal(describeUserAgent(null), "Unknown device");
  assert.equal(describeUserAgent(""), "Unknown device");

  const chromeOnLinux =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  assert.equal(describeUserAgent(chromeOnLinux), "Linux · Chrome");

  // Every Chromium UA also claims Safari; Safari must not win that race.
  const safari =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  assert.equal(describeUserAgent(safari), "macOS · Safari");

  // And Edge claims Chrome, so ordering matters there too.
  const edge =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
  assert.equal(describeUserAgent(edge), "Windows · Edge");

  // The suite's own browser must be recognisable in the sessions list.
  const headless =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36";
  assert.equal(describeUserAgent(headless), "Linux · Headless Chrome");
});

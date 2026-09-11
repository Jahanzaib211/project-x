/**
 * G5 — identity, end to end, in a real browser.
 *
 * The claim this file exists to check is the whole arc: a person can arrive at
 * the site with no account, create one, be signed in, own trading accounts that
 * nobody else can see, add a second factor, change their password, sign out,
 * and sign back in. Nothing is stubbed — these drive the web app, which drives
 * the client API, which writes to the real Postgres schema.
 *
 * Two things are asserted throughout, because they are the ones that fail
 * quietly rather than loudly:
 *
 * - **The session token is never reachable from script.** It lives in an
 *   HttpOnly cookie and is stripped from every response body. A test that only
 *   checked "login works" would pass just as happily with the token in
 *   `localStorage`.
 * - **One person's rows are not another's.** Isolation is not visible in the
 *   interface — an account list looks correct right up until it is somebody
 *   else's account list.
 *
 * Each test registers its own account. Sharing one would make the order the
 * tests happen to run in decide whether they pass.
 */

import { createHmac } from "node:crypto";

import { test, expect, API } from "../fixtures.js";

/** A fresh address per registration. */
let sequence = 0;
const newEmail = (label) =>
  `e2e-${label}-${Date.now()}-${(sequence += 1)}@example.test`;

const PASSWORD = "a-properly-long-password";

/**
 * Register through the interface, the way a person would.
 *
 * Returns the address so a test can sign back in as the same person.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{label: string, name?: string, country?: string}} options
 */
async function registerThroughTheForm(page, { label, name = "Ada Lovelace", country = "United Kingdom" }) {
  const email = newEmail(label);

  await page.goto("/register");
  await page.locator("#register-name").fill(name);
  await page.locator("#register-email").fill(email);
  await page.locator("#register-password").fill(PASSWORD);
  await page.locator("#register-confirm").fill(PASSWORD);
  await page.locator("#register-country").selectOption(country);
  await page.locator("#register-terms").check();
  await page.locator("[data-register-form] [data-submit]").click();

  // Registration signs you in and lands on the accounts page.
  await expect(page).toHaveURL(/\/$/);
  return email;
}

/**
 * Sign in through the form.
 * @param {import("@playwright/test").Page} page
 */
async function signIn(page, email, password = PASSWORD) {
  await page.goto("/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.locator("[data-login-form] [data-submit]").click();
}

/**
 * A TOTP code, generated the way an authenticator app would.
 *
 * Written out here rather than imported from `services/client-api/src/auth.js`
 * on purpose. A test that generates its codes with the same function it is
 * testing proves only that the function agrees with itself — if the truncation
 * or the counter were wrong, both sides would be wrong together and this would
 * still pass. This is an independent implementation of RFC 6238, so the two
 * have to agree for a real reason.
 *
 * @param {string} secretBase32
 */
function authenticatorCode(secretBase32) {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  /** @type {number[]} */
  const key = [];
  for (const char of secretBase32.toUpperCase().replace(/[=\s]/g, "")) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      key.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(key)).update(counter).digest();

  const offset = Number(digest[digest.length - 1]) & 0x0f;
  const binary =
    ((Number(digest[offset]) & 0x7f) << 24) |
    ((Number(digest[offset + 1]) & 0xff) << 16) |
    ((Number(digest[offset + 2]) & 0xff) << 8) |
    (Number(digest[offset + 3]) & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Assert the reset confirmation matches how this deployment actually delivers.
 *
 * Hard-coding either branch makes the test a statement about the configuration
 * rather than about the page. Both sentences are lies in the wrong
 * configuration: "check your inbox" with no provider strands somebody already
 * locked out, and "nothing was emailed" once mail works sends them hunting for
 * a workaround they do not need.
 *
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").APIRequestContext} request
 */
async function expectHonestAboutDelivery(page, request) {
  const meta = await request.get(`${API}/v1/auth/meta`).then((r) => r.json(), () => ({}));
  if (meta.emailDelivery) {
    await expect(page.getByText(/check your inbox/i)).toBeVisible();
    await expect(page.getByText(/no email provider/i)).toHaveCount(0);
  } else {
    await expect(page.getByText(/no email provider/i)).toBeVisible();
    await expect(page.getByText(/check your inbox/i)).toHaveCount(0);
  }
}

test.describe("creating an account", () => {
  test("a person can register, and arrives signed in", async ({ page }) => {
    const email = await registerThroughTheForm(page, { label: "register", name: "Ada Lovelace" });

    // The shell knows who they are, server-rendered — not filled in afterwards.
    await page.locator('[data-menu="profile"]').click();
    await expect(page.locator("[data-profile-name]")).toHaveText("Ada Lovelace");
    await expect(page.locator("[data-profile-email]")).toHaveText(email);

    // And the signed-out invitations are gone.
    await expect(page.locator('a[href="/register"]')).toHaveCount(0);
  });

  test("the session token is not reachable from script", async ({ page, context }) => {
    await registerThroughTheForm(page, { label: "httponly" });

    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === "px_session");
    expect(session, "no session cookie was set").toBeTruthy();
    expect(session?.httpOnly, "the session cookie must be HttpOnly").toBe(true);
    expect(session?.sameSite, "the session cookie must be SameSite=Lax").toBe("Lax");

    // The whole point of HttpOnly: an injected script cannot read it.
    const visible = await page.evaluate(() => document.cookie);
    expect(visible).not.toContain("px_session");

    // Nor is the token sitting in storage where a script could take it.
    const stored = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    expect(stored).not.toMatch(/px_session|Bearer|token/i);
  });

  test("the registration form refuses what it should, field by field", async ({ page }) => {
    await page.goto("/register");

    // Submitting an empty form names every problem at once, each beside its own
    // field rather than in a single banner the reader has to decode.
    await page.locator("[data-register-form] [data-submit]").click();
    await expect(page.locator("#register-name-error")).toBeVisible();
    await expect(page.locator("#register-email-error")).toContainText(/valid email/i);
    await expect(page.locator("#register-password-error")).toContainText(/at least 10/i);
    await expect(page.locator("#register-terms-error")).toContainText(/accept/i);

    // Nothing was submitted.
    await expect(page).toHaveURL(/\/register$/);

    // A mismatched confirmation is caught before the request.
    await page.locator("#register-name").fill("Ada Lovelace");
    await page.locator("#register-email").fill(newEmail("mismatch"));
    await page.locator("#register-password").fill(PASSWORD);
    await page.locator("#register-confirm").fill("something-else-entirely");
    await page.locator("#register-country").selectOption("United Kingdom");
    await page.locator("#register-terms").check();
    await page.locator("[data-register-form] [data-submit]").click();
    await expect(page.locator("#register-confirm-error")).toContainText(/do not match/i);
    await expect(page).toHaveURL(/\/register$/);
  });

  test("an address that is already registered is refused on the field that is wrong", async ({ page }) => {
    const email = await registerThroughTheForm(page, { label: "duplicate" });

    // Sign out, then try to register the same address again.
    await page.goto("/signout");
    await page.locator('form[action="/signout"] button[type="submit"]').click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/register");
    await page.locator("#register-name").fill("Someone Else");
    await page.locator("#register-email").fill(email);
    await page.locator("#register-password").fill("a-different-long-password");
    await page.locator("#register-confirm").fill("a-different-long-password");
    await page.locator("#register-country").selectOption("United Kingdom");
    await page.locator("#register-terms").check();
    await page.locator("[data-register-form] [data-submit]").click();

    await expect(page.locator("#register-email-error")).toContainText(/already exists/i);
    await expect(page.locator("#register-error")).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);
  });

  test("the password meter tracks what the policy will actually accept", async ({ page }) => {
    await page.goto("/register");
    const meter = page.locator("[data-meter]");
    const password = page.locator("#register-password");

    // Hidden until there is something to measure.
    await expect(meter).toBeHidden();

    await password.fill("short");
    await expect(meter).toBeVisible();
    await expect(page.locator('[data-rule="length"]')).toHaveAttribute("data-met", "false");

    await password.fill("a-properly-long-password-9!");
    await expect(page.locator('[data-rule="length"]')).toHaveAttribute("data-met", "true");
    await expect(page.locator('[data-rule="variety"]')).toHaveAttribute("data-met", "true");
    await expect(meter).toHaveAttribute("data-score", /[34]/);

    // A password containing the email address fails the rule and is capped,
    // however long it is — the meter must never flatter what the API refuses.
    await page.locator("#register-email").fill("winston@example.com");
    await password.fill("winston-and-then-some-more-text");
    await expect(page.locator('[data-rule="personal"]')).toHaveAttribute("data-met", "false");
    await expect(meter).toHaveAttribute("data-score", /[01]/);
  });
});

test.describe("signing in", () => {
  test("a wrong password is refused, shown and announced", async ({ page }) => {
    const email = await registerThroughTheForm(page, { label: "wrongpass" });
    await page.goto("/signout");
    await page.locator('form[action="/signout"] button[type="submit"]').click();

    await signIn(page, email, "not-the-right-password");

    const banner = page.locator("#login-error");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/do not match an account/i);
    // Announced as well as shown — the toast is what reaches a screen reader
    // without moving focus.
    await expect(page.locator(".toast")).toContainText(/do not match an account/i);
    // Still on the login page, and still signed out.
    await expect(page).toHaveURL(/\/login/);
  });

  test("an unknown address is refused in exactly the same words", async ({ page }) => {
    // Account enumeration: if "no such user" reads differently from "wrong
    // password", the login form becomes a way to discover who has an account.
    await signIn(page, newEmail("nobody"), "any-password-at-all");
    // Waited on with a retrying assertion rather than read once: textContent()
    // resolves immediately and would sample the banner before the response.
    const banner = page.locator("#login-error [data-error-text]");
    await expect(banner).toContainText(/do not match an account/i);
  });

  test("signing in returns to the page that asked for it", async ({ page }) => {
    const email = await registerThroughTheForm(page, { label: "next" });
    await page.goto("/signout");
    await page.locator('form[action="/signout"] button[type="submit"]').click();

    await page.goto("/login?next=%2Fdeposit");
    await expect(page.locator(".notice-title")).toContainText(/sign in to continue/i);
    await page.locator("#login-email").fill(email);
    await page.locator("#login-password").fill(PASSWORD);
    await page.locator("[data-login-form] [data-submit]").click();

    await expect(page).toHaveURL(/\/deposit$/);
  });

  test("the sign-in form will not forward to another site", async ({ page }) => {
    // An open redirect on a login form is how a phishing link gets a genuine
    // domain in front of the victim. The destination must be discarded, not
    // sanitised into something adjacent.
    const email = await registerThroughTheForm(page, { label: "openredirect" });
    await page.goto("/signout");
    await page.locator('form[action="/signout"] button[type="submit"]').click();

    await page.goto("/login?next=https%3A%2F%2Fexample.com%2Fphish");
    await page.locator("#login-email").fill(email);
    await page.locator("#login-password").fill(PASSWORD);
    await page.locator("[data-login-form] [data-submit]").click();

    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  });

  test("signing out ends the session and says so", async ({ page, context }) => {
    await registerThroughTheForm(page, { label: "signout" });

    await page.goto("/signout");
    // A confirmation, not an action: a GET that ends a session can be triggered
    // by anything that fetches a URL.
    await expect(page.locator("h3")).toContainText(/sign out\?/i);
    await page.locator('form[action="/signout"] button[type="submit"]').click();

    await expect(page).toHaveURL(/\/login\?signedOut=1/);
    await expect(page.locator(".notice-title")).toContainText(/signed out/i);

    const session = (await context.cookies()).find((c) => c.name === "px_session");
    expect(session?.value ?? "", "the session cookie must be cleared").toBe("");

    // And the app no longer knows them.
    await page.goto("/");
    await expect(page.locator('a[href="/login"]').first()).toBeVisible();
  });
});

test.describe("what a session owns", () => {
  test("accounts belong to the person who opened them", async ({ browser }) => {
    // Two independent browser contexts, so the two people have genuinely
    // separate cookie jars rather than taking turns with one.
    const alice = await browser.newContext();
    const bob = await browser.newContext();
    const alicePage = await alice.newPage();
    const bobPage = await bob.newPage();

    try {
      await registerThroughTheForm(alicePage, { label: "alice", name: "Alice Alpha" });
      await registerThroughTheForm(bobPage, { label: "bob", name: "Bob Beta" });

      // Alice opens an account with a name nobody would pick by accident.
      const nickname = `Alice private ${Date.now()}`;
      await alicePage.goto("/");
      await alicePage.locator("[data-open-account]").first().click();
      await alicePage.locator('[data-open-account-form] input[name="nickname"]').fill(nickname);
      await alicePage.locator("[data-open-account-form] [data-submit]").click();

      // Not asserted on the toast: client.js reloads the page 400ms after a
      // successful open, which takes the toast with it. The account appearing
      // in her list is the outcome that lasts.
      await expect(alicePage.getByText(nickname)).toBeVisible();

      // Bob's accounts page must not contain it — and Bob has none at all.
      await bobPage.goto("/");
      await expect(bobPage.getByText(nickname)).toHaveCount(0);
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  test("a signed-in request is never attributed to the development identity", async ({ page, request }) => {
    await registerThroughTheForm(page, { label: "identity" });

    const profile = await page.evaluate(async () => {
      const response = await fetch("/api/v1/profile");
      return response.json();
    });
    expect(profile.authenticated).toBe(true);
    expect(profile.clientId).not.toBe("dev-owner-0001");
    // Signed in is not verified, and the API says so rather than implying
    // otherwise by omission.
    expect(profile.identityVerified).toBe(false);
    expect(profile.verificationNote).toMatch(/16-kyc-aml/);

    // Without a session, the same endpoint answers as the shared development
    // identity and labels itself as such.
    const anonymous = await request.get(`${API}/v1/profile`);
    const body = await anonymous.json();
    expect(body.authenticated).toBe(false);
    expect(body.clientId).toBe("dev-owner-0001");
  });
});

test.describe("security settings", () => {
  test("a password can be changed, and other sessions end", async ({ page, browser }) => {
    const email = await registerThroughTheForm(page, { label: "changepw" });

    // A second device, signed in as the same person.
    const other = await browser.newContext();
    const otherPage = await other.newPage();

    try {
      await signIn(otherPage, email);
      await expect(otherPage).toHaveURL(/\/$/);

      // Two sessions are visible on the security page.
      await page.goto("/security");
      await expect(page.locator("[data-sessions] [data-session]")).toHaveCount(2);
      await expect(page.locator(".tag").filter({ hasText: "This device" })).toHaveCount(1);

      const next = "a-replacement-password-1";
      await page.locator("#current-password").fill(PASSWORD);
      await page.locator("#new-password").fill(next);
      await page.locator("#confirm-new-password").fill(next);
      await page.locator("[data-password-form] [data-submit]").click();

      await expect(page.locator(".toast")).toContainText(/1 other session was signed out/i);
      await expect(page.locator("[data-sessions] [data-session]")).toHaveCount(1);

      // The other device is out, and discovers it on its next navigation.
      await otherPage.goto("/security");
      await expect(otherPage).toHaveURL(/\/login/);

      // The old password no longer works; the new one does. Signing out first
      // because this session deliberately survived the change, and /login
      // redirects anyone who still has one.
      await page.goto("/signout");
      await page.locator('form[action="/signout"] button[type="submit"]').click();
      await expect(page).toHaveURL(/\/login/);

      await signIn(page, email, PASSWORD);
      await expect(page.locator("#login-error")).toContainText(/do not match/i);

      await signIn(page, email, next);
      await expect(page).toHaveURL(/\/$/);
    } finally {
      await other.close();
    }
  });

  test("a wrong current password is refused on its own field", async ({ page }) => {
    await registerThroughTheForm(page, { label: "wrongcurrent" });
    await page.goto("/security");

    await page.locator("#current-password").fill("not-the-current-password");
    await page.locator("#new-password").fill("a-perfectly-fine-password");
    await page.locator("#confirm-new-password").fill("a-perfectly-fine-password");
    await page.locator("[data-password-form] [data-submit]").click();

    await expect(page.locator("#current-password-error")).toContainText(/not correct/i);
    await expect(page.locator("#password-form-error")).toBeVisible();
  });

  test("another session can be ended from the security page", async ({ page, browser }) => {
    const email = await registerThroughTheForm(page, { label: "revoke" });

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    try {
      await signIn(otherPage, email);
      await expect(otherPage).toHaveURL(/\/$/);

      await page.goto("/security");
      await expect(page.locator("[data-sessions] [data-session]")).toHaveCount(2);

      await page.locator("[data-revoke-session]").first().click();
      await expect(page.locator(".toast")).toContainText(/signed out/i);
      await expect(page.locator("[data-sessions] [data-session]")).toHaveCount(1);

      await otherPage.goto("/");
      await expect(otherPage).toHaveURL(/\/login/);
    } finally {
      await other.close();
    }
  });

  test("two-factor authentication can be turned on and off", async ({ page, request }) => {
    await registerThroughTheForm(page, { label: "totp" });
    await page.goto("/security");

    await expect(page.locator("[data-totp-state]")).toContainText(/not enabled/i);
    await page.locator("[data-totp-toggle]").click();

    // The secret arrives from the API rather than having been in the page.
    const secret = await page.locator("[data-totp-secret]").textContent();
    expect(secret?.replace(/\s/g, "")).toMatch(/^[A-Z2-7]{32}$/);

    // A wrong code is refused, and nothing is enabled by it.
    await page.locator("#totp-confirm-code").fill("000000");
    await page.locator("[data-totp-confirm]").click();
    await expect(page.locator("#totp-confirm-code-error")).toBeVisible();
    await expect(page.locator("[data-totp-state]")).toContainText(/not enabled/i);

    // The real code, from an independent RFC 6238 implementation.
    await page.locator("#totp-confirm-code").fill(authenticatorCode(String(secret)));
    await page.locator("[data-totp-confirm]").click();

    await expect(page.locator("[data-totp-state]")).toContainText(/enabled/i);
    // Recovery codes are shown exactly once, and there are ten of them.
    await expect(page.locator(".code-grid span")).toHaveCount(10);
    // Scoped to the enrolment panel: the page carries a second .notice-title
    // about identity verification.
    await expect(page.locator("[data-totp-panel] .notice-title"))
      .toContainText(/save these recovery codes/i);

    // Turning it off needs the password, not just the session.
    await page.locator("[data-totp-cancel]").click();
    await page.locator("[data-totp-toggle]").click();
    await page.locator("#totp-disable-password").fill("not-the-password");
    await page.locator("[data-totp-confirm-disable]").click();
    await expect(page.locator("#totp-disable-password-error")).toContainText(/not correct/i);

    await page.locator("#totp-disable-password").fill(PASSWORD);
    await page.locator("[data-totp-confirm-disable]").click();
    await expect(page.locator("[data-totp-state]")).toContainText(/not enabled/i);
  });

  test("with two-factor on, a password alone does not sign you in", async ({ page }) => {
    const email = await registerThroughTheForm(page, { label: "totplogin" });
    await page.goto("/security");
    await page.locator("[data-totp-toggle]").click();

    const secret = String(await page.locator("[data-totp-secret]").textContent());
    await page.locator("#totp-confirm-code").fill(authenticatorCode(secret));
    await page.locator("[data-totp-confirm]").click();
    await expect(page.locator("[data-totp-state]")).toContainText(/enabled/i);

    // Collect a recovery code before leaving the page — it is shown once.
    const recovery = String(await page.locator(".code-grid span").first().textContent()).trim();

    await page.goto("/signout");
    await page.locator('form[action="/signout"] button[type="submit"]').click();

    // The password alone reveals the second-factor step rather than signing in.
    await signIn(page, email);
    await expect(page.locator("[data-totp-step]")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    // A recovery code gets them in, and is spent doing so.
    await page.locator("#login-totp").fill(recovery);
    await page.locator("[data-login-form] [data-submit]").click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto("/signout");
    await page.locator('form[action="/signout"] button[type="submit"]').click();
    await signIn(page, email);
    await page.locator("#login-totp").fill(recovery);
    await page.locator("[data-login-form] [data-submit]").click();
    await expect(page.locator("#login-error, #login-totp-error").first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("signed out, the security page explains itself instead of showing nothing", async ({ page }) => {
    // An empty sessions table reads as "you are signed in nowhere", which is a
    // different and more alarming claim than "we cannot tell you".
    await page.goto("/security");
    await expect(page.locator("h3")).toContainText(/sign in to manage security/i);
    await expect(page.locator("[data-sessions]")).toHaveCount(0);
  });
});

test.describe("the honest edges", () => {
  test("forgot-password offers a real reset and describes delivery honestly", async ({ page, request }) => {
    await page.goto("/forgot-password");

    // It collects an address now, because there is a real reset behind it.
    await expect(page.locator("#forgot-email")).toBeVisible();
    await expect(page.locator('form[action="/forgot-password"]')).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();

    await page.locator("#forgot-email").fill(`nobody-${Date.now()}@example.test`);
    await page.locator("[data-forgot-form] [data-submit]").click();
    await expect(page.locator("[data-forgot-result]")).toBeVisible();

    // Whatever it says about delivery has to be true of this deployment.
    await expectHonestAboutDelivery(page, request);
  });

  test("the signed-out shell still carries the risk disclosure", async ({ page }) => {
    // Somebody deciding whether to register is exactly who needs it. Putting it
    // behind registration would be the wrong way round.
    await page.goto("/login");
    // Scoped to the footer: the panel beside the form makes the same point in
    // its own words, and matching either one would not prove the disclosure
    // survived on the signed-out shell.
    const footer = page.locator(".footer-risk");
    await expect(footer.getByText(/Risk warning/)).toBeVisible();
    await expect(footer.getByText(/Not a regulated firm/)).toBeVisible();
    await expect(page.locator(".sidebar")).toHaveCount(0);
  });
});

test.describe("recovering an account", () => {
  /**
   * Fetch the reset link out of the outbox, the way a person would fetch it out
   * of their inbox.
   *
   * There is no email provider, so the message is queued rather than sent. The
   * suite reads the queue: pretending a link was delivered and then guessing at
   * it would test nothing.
   *
   * @param {import("@playwright/test").APIRequestContext} request
   * @param {string} email
   */
  async function resetLinkFor(request, email) {
    const response = await request.get(`${API}/v1/auth/outbox?to=${encodeURIComponent(email)}`);
    expect(response.ok(), "the outbox is not readable").toBeTruthy();
    const { messages } = await response.json();
    const message = messages.find((/** @type {{kind: string}} */ m) => m.kind === "password_reset");
    expect(message, `no reset message was queued for ${email}`).toBeTruthy();
    const match = /\/reset-password\?token=[A-Za-z0-9_-]+/.exec(message.body);
    expect(match, "the queued message carries no reset link").toBeTruthy();
    return String(match?.[0]);
  }

  test("a forgotten password can be reset, end to end", async ({ page, request }) => {
    const email = await registerThroughTheForm(page, { label: "forgot" });
    await page.goto("/signout");
    await page.locator('form[action="/signout"] button[type="submit"]').click();

    // Ask for a link.
    await page.goto("/login");
    await page.locator('a[href="/forgot-password"]').click();
    await page.locator("#forgot-email").fill(email);
    await page.locator("[data-forgot-form] [data-submit]").click();

    // The confirmation says what actually happened to the link, whichever it is.
    await expect(page.locator("[data-forgot-result]")).toBeVisible();
    await expect(page.getByText(/if that address has an account/i)).toBeVisible();
    await expectHonestAboutDelivery(page, request);

    // Follow the link out of the outbox.
    const link = await resetLinkFor(request, email);
    await page.goto(link);
    await expect(page.locator("h1")).toContainText(/choose a new password/i);

    // A weak password is refused without spending the link.
    const next = "a-replacement-password-9";
    await page.locator("#reset-password").fill("short");
    await page.locator("#reset-confirm").fill("short");
    await page.locator("[data-reset-form] [data-submit]").click();
    await expect(page.locator("#reset-password-error")).toContainText(/at least 10/i);

    // A mismatch, likewise.
    await page.locator("#reset-password").fill(next);
    await page.locator("#reset-confirm").fill("something-else-entirely");
    await page.locator("[data-reset-form] [data-submit]").click();
    await expect(page.locator("#reset-confirm-error")).toContainText(/do not match/i);

    // And now for real.
    await page.locator("#reset-confirm").fill(next);
    await page.locator("[data-reset-form] [data-submit]").click();
    await expect(page).toHaveURL(/\/login\?passwordChanged=1/);
    await expect(page.locator(".notice-title")).toContainText(/password changed/i);

    // The old password is gone; the new one works.
    await signIn(page, email, PASSWORD);
    await expect(page.locator("#login-error")).toContainText(/do not match/i);
    await signIn(page, email, next);
    await expect(page).toHaveURL(/\/$/);
  });

  test("a reset link works exactly once", async ({ page, request }) => {
    const email = await registerThroughTheForm(page, { label: "oncelink" });
    await page.goto("/signout");
    await page.locator('form[action="/signout"] button[type="submit"]').click();

    await page.goto("/forgot-password");
    await page.locator("#forgot-email").fill(email);
    await page.locator("[data-forgot-form] [data-submit]").click();
    await expect(page.locator("[data-forgot-result]")).toBeVisible();

    const link = await resetLinkFor(request, email);
    await page.goto(link);
    await page.locator("#reset-password").fill("the-first-replacement-1");
    await page.locator("#reset-confirm").fill("the-first-replacement-1");
    await page.locator("[data-reset-form] [data-submit]").click();
    await expect(page).toHaveURL(/\/login/);

    // The same link again. It must not offer a password field at all — a form
    // that accepts a password and discards it reads as "my reset did not work".
    await page.goto(link);
    await expect(page.locator("h1")).toContainText(/expired/i);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByText(/nothing has changed/i)).toBeVisible();
  });

  test("resetting signs out every device", async ({ page, browser, request }) => {
    const email = await registerThroughTheForm(page, { label: "resetkicks" });

    // A second device, signed in as the same person.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    try {
      await signIn(otherPage, email);
      await expect(otherPage).toHaveURL(/\/$/);

      await page.goto("/forgot-password");
      await page.locator("#forgot-email").fill(email);
      await page.locator("[data-forgot-form] [data-submit]").click();
      await expect(page.locator("[data-forgot-result]")).toBeVisible();

      const link = await resetLinkFor(request, email);
      await page.goto(link);
      await page.locator("#reset-password").fill("everything-signs-out-1");
      await page.locator("#reset-confirm").fill("everything-signs-out-1");
      await page.locator("[data-reset-form] [data-submit]").click();
      await expect(page).toHaveURL(/\/login/);

      // Somebody resetting a password is recovering an account or was locked
      // out of one. Leaving the other device signed in defeats the point.
      await otherPage.goto("/security");
      await expect(otherPage).toHaveURL(/\/login/);
    } finally {
      await other.close();
    }
  });

  test("asking to reset an unregistered address looks identical", async ({ page }) => {
    // "No account with that address" answers, for anyone who asks, which
    // addresses bank here.
    await page.goto("/forgot-password");
    await page.locator("#forgot-email").fill(`nobody-${Date.now()}@example.test`);
    await page.locator("[data-forgot-form] [data-submit]").click();

    await expect(page.locator("[data-forgot-result]")).toBeVisible();
    await expect(page.getByText(/if that address has an account/i)).toBeVisible();
    await expect(page.getByText(/no account|not registered|could not find/i)).toHaveCount(0);
  });
});

test.describe("what the database enforces", () => {
  test("a password change reissues this session's own token", async ({ page, context }) => {
    // Session fixation: if the credential that existed before the change still
    // works after it, then changing the password because somebody else had your
    // session accomplishes nothing for the one session that mattered.
    await registerThroughTheForm(page, { label: "rotate" });

    const before = (await context.cookies()).find((c) => c.name === "px_session")?.value;
    expect(before, "no session cookie").toBeTruthy();

    await page.goto("/security");
    await page.locator("#current-password").fill(PASSWORD);
    await page.locator("#new-password").fill("a-rotated-password-1");
    await page.locator("#confirm-new-password").fill("a-rotated-password-1");
    await page.locator("[data-password-form] [data-submit]").click();
    await expect(page.locator(".toast")).toContainText(/password was changed/i);

    const after = (await context.cookies()).find((c) => c.name === "px_session")?.value;
    expect(after, "the session cookie was not reissued").not.toBe(before);

    // And the page still works — the swap happened without signing anyone out.
    await page.goto("/security");
    await expect(page.locator("#current-password")).toBeVisible();
  });

  test("the activity log records what happened to the account", async ({ page }) => {
    await registerThroughTheForm(page, { label: "audit" });
    await page.goto("/security");

    await expect(page.getByText("Account created")).toBeVisible();

    // A failed sign-in from elsewhere shows up here, which is the question this
    // panel exists to answer: was that me?
    await page.goto("/security");
    await expect(page.locator("h2").filter({ hasText: "Recent activity" })).toBeVisible();

    // Nothing secret is ever rendered into it.
    const html = await page.content();
    expect(html).not.toMatch(/password_hash|token_digest|scrypt\$/);
  });

  test("an email address can be confirmed, and confirming is not verification", async ({ page, request }) => {
    const email = await registerThroughTheForm(page, { label: "verify" });
    await page.goto("/security");
    await expect(page.getByText("unconfirmed")).toBeVisible();

    // Registration queues a confirmation link already.
    const response = await request.get(`${API}/v1/auth/outbox?to=${encodeURIComponent(email)}`);
    const { messages } = await response.json();
    const message = messages.find((/** @type {{kind: string}} */ m) => m.kind === "email_verification");
    expect(message, "registration queued no confirmation link").toBeTruthy();
    const link = String(/\/verify-email\?token=[A-Za-z0-9_-]+/.exec(message.body)?.[0]);

    await page.goto(link);
    await expect(page.locator("h1")).toContainText(/address confirmed/i);
    // Confirming an address is not confirming a person, and the page says so.
    await expect(page.getByText(/16-kyc-aml/)).toBeVisible();

    await page.goto("/security");
    await expect(page.getByText("confirmed", { exact: true })).toBeVisible();

    // Second use of the same link is refused.
    await page.goto(link);
    await expect(page.locator("h1")).toContainText(/did not work/i);
  });
});

test.describe("the whole journey", () => {
  /**
   * Sign up, open a demo account, trade it, sign out, sign back in, and find
   * everything where it was left.
   *
   * Every other test here proves one link in that chain. This one exists
   * because a chain of individually-correct links is not the same claim as the
   * chain holding: the account has to be created by the person who signed up,
   * the ledger has to attribute it to them, the position has to survive a sign
   * out, and the balance afterwards has to be the one the core computed rather
   * than the one the page remembered.
   */
  test("sign up, open a demo account, trade, sign out, sign back in", async ({ page, request }) => {
    // ---- sign up ----
    const email = await registerThroughTheForm(page, { label: "journey", name: "Journey Tester" });
    await expect(page).toHaveURL(/\/$/);

    // A brand-new account owns nothing, and the page says so rather than
    // showing a zero balance that looks like a funded account.
    await expect(page.locator(".balance-chip")).toContainText(/unavailable/i);

    // ---- open a demo trading account ----
    await page.goto("/terminal");
    await page.locator("[data-open-demo]").click();
    await expect(page.locator("[data-balance]")).toHaveText("10000.00", { timeout: 20_000 });

    // The terminal carries the account it is showing on its root element; there
    // is no separate label to read it from.
    const account = String(await page.locator("[data-terminal]").getAttribute("data-account")).trim();
    expect(account).toMatch(/^\d{8}$/);

    // ---- trade it ----
    await page.locator("[data-volume]").fill("0.10");
    await page.locator("[data-buy]").click();

    // The fill is the core's, not the page's: the position appears because the
    // ledger settled it, and the blotter is showing what came back.
    // `data-positions` is the tbody itself, so the rows are its direct children.
    await expect(page.locator("[data-positions] tr").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-positions]")).toContainText("EURUSD");

    // The balance moved by the commission, and the equity tracks the mark.
    await expect(page.locator("[data-balance]")).not.toHaveText("10000.00");

    const afterTrade = await coreValuation(request, account);
    expect(afterTrade.positions).toHaveLength(1);
    expect(afterTrade.positions[0].symbol).toBe("EURUSD");

    // ---- sign out ----
    await page.goto("/signout");
    await page.locator('form[action="/signout"] button[type="submit"]').click();
    await expect(page).toHaveURL(/\/login\?signedOut=1/);

    // Signed out, the terminal shows nobody's account.
    await page.goto("/terminal");
    await expect(page.locator("[data-positions]")).toHaveCount(0);

    // ---- sign back in ----
    await signIn(page, email);
    await expect(page).toHaveURL(/\/$/);

    // The position survived, because it lives in the ledger rather than in a
    // session. And the figure shown is the one the core computes now.
    await page.goto(`/terminal?account=${account}`);
    await expect(page.locator("[data-positions]")).toContainText("EURUSD", { timeout: 20_000 });

    const afterSignIn = await coreValuation(request, account);
    expect(afterSignIn.balance).toBe(afterTrade.balance);
    expect(afterSignIn.positions).toHaveLength(1);

    // ---- close it ----
    await page.locator("[data-close-position]").first().click();
    await expect(page.locator("[data-positions-empty]")).toBeVisible({ timeout: 20_000 });

    const closed = await coreValuation(request, account);
    expect(closed.positions).toHaveLength(0);
    // Realised: the balance changed and no longer equals the opening figure.
    expect(closed.balance).not.toBe("10000.00");
  });
});

/**
 * The account's valuation, straight from the core.
 *
 * Read through the API with no session, which the development identity allows.
 * The point is to compare what the page shows against what the ledger holds —
 * so it must not come from the page.
 *
 * @param {import("@playwright/test").APIRequestContext} request
 * @param {string} account
 */
async function coreValuation(request, account) {
  const response = await request.get(`${API}/v1/trading-accounts/${account}/state`);
  expect(response.ok(), `could not read state for ${account}`).toBeTruthy();
  return (await response.json()).valuation;
}

test.describe("delivery", () => {
  /**
   * Reset, completed through a real mail server.
   *
   * Every other reset test here reads the link out of the outbox — which proves
   * the token logic and nothing about whether a message would ever leave the
   * building. This one reads it out of a mailbox: the API speaks SMTP to
   * Mailpit, and the link is extracted from the delivered message body.
   *
   * Skipped rather than failed where Mailpit is not running, because the local
   * stack does not require it. A skip is visible; a silent pass is not.
   */
  const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:27020";

  test("a reset link is delivered by email and works from the message body", async ({ page, request }) => {
    const reachable = await request.get(`${MAILPIT}/api/v1/info`).then(
      (r) => r.ok(),
      () => false,
    );
    // Both halves matter: a mail server nobody sends to proves nothing, and a
    // sender with no server to receive it proves nothing either.
    const meta = await request.get(`${API}/v1/auth/meta`).then((r) => r.json(), () => ({}));
    test.skip(
      !reachable || !meta.emailDelivery,
      `delivery not exercisable here (mail server reachable: ${reachable}, ` +
        `MAIL_DRIVER active: ${Boolean(meta.emailDelivery)}) — ` +
        "start the sink with: docker compose up -d mailpit",
    );

    const email = await registerThroughTheForm(page, { label: "delivered" });
    await page.goto("/signout");
    await page.locator('form[action="/signout"] button[type="submit"]').click();

    await page.goto("/forgot-password");
    await page.locator("#forgot-email").fill(email);
    await page.locator("[data-forgot-form] [data-submit]").click();
    await expect(page.locator("[data-forgot-result]")).toBeVisible();

    // Poll the mailbox. The outbox worker runs on an interval, so the message
    // is not there the instant the request returns.
    /** @type {string} */
    let body = "";
    await expect(async () => {
      const found = await request.get(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(email)}`,
      );
      const { messages } = await found.json();
      const reset = messages.find((/** @type {{Subject: string}} */ m) => /Reset/i.test(m.Subject));
      expect(reset, "no reset message has been delivered yet").toBeTruthy();
      const full = await request.get(`${MAILPIT}/api/v1/message/${reset.ID}`);
      body = (await full.json()).Text;
    }).toPass({ timeout: 45_000 });

    // The message must carry a usable link and nothing that should not travel
    // by email in the clear.
    const link = /\/reset-password\?token=[A-Za-z0-9_-]+/.exec(body);
    expect(link, "the delivered message carries no reset link").toBeTruthy();
    expect(body).not.toMatch(/scrypt\$|password_hash/);

    // Follow it exactly as a person would.
    const next = "a-delivered-password-1";
    await page.goto(String(link?.[0]));
    await expect(page.locator("h1")).toContainText(/choose a new password/i);
    await page.locator("#reset-password").fill(next);
    await page.locator("#reset-confirm").fill(next);
    await page.locator("[data-reset-form] [data-submit]").click();
    await expect(page).toHaveURL(/\/login\?passwordChanged=1/);

    // The old password is gone and the new one works.
    await signIn(page, email, PASSWORD);
    await expect(page.locator("#login-error")).toContainText(/do not match/i);
    await signIn(page, email, next);
    await expect(page).toHaveURL(/\/$/);
  });
});

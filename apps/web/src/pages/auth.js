/**
 * Sign in, register, and the honest version of "forgot password".
 *
 * These are the only screens a signed-out person can reach, so they carry more
 * weight than their size suggests: they are the first thing anyone sees, and on
 * a financial site they are also the screen most often imitated. Three things
 * follow from that:
 *
 * - **The forms work without JavaScript.** Each one is a real `<form>` with a
 *   real `method="post"` and a real `action`. `client.js` upgrades them to
 *   fetch-and-toast; with scripting off, the server handles the post and
 *   re-renders with the error in place. A login you cannot complete because a
 *   script failed to load is a login you cannot complete.
 * - **Errors are attached to fields, not only announced.** A toast is
 *   transient and lands at the wrong end of the page; the field error stays
 *   next to the thing that is wrong. Both are rendered, and both are wired to
 *   `aria-describedby` / `aria-invalid` so the failure is not a purely visual
 *   event.
 * - **Nothing here claims a regulatory status.** The panel beside the form says
 *   what this platform is, because the alternative — a stock photograph and a
 *   row of invented licence numbers — is the house style of the sites this one
 *   is a reference implementation *against*.
 */

import { esc } from "../ui/layout.js";
import { icon } from "../ui/icons.js";

/**
 * A form field, with its label, control, hint and error slot wired together.
 *
 * The error slot is always rendered, always `aria-describedby`-linked, and
 * hidden when empty. Creating it on demand means the association is made after
 * the error appears, which some screen readers never announce.
 *
 * @param {{
 *   id: string, label: string, control: string,
 *   hint?: string, error?: string, optional?: boolean
 * }} options
 */
function field({ id, label, control, hint = "", error = "", optional = false }) {
  return `<div class="field" data-field="${esc(id)}">
    <label class="label" for="${esc(id)}">
      ${esc(label)}${optional ? ` <span class="muted micro">(optional)</span>` : ""}
    </label>
    ${control}
    ${hint ? `<span class="hint" id="${esc(id)}-hint">${esc(hint)}</span>` : ""}
    <p class="field-error" id="${esc(id)}-error" role="alert"${error ? "" : " hidden"}>${esc(error)}</p>
  </div>`;
}

/**
 * A password input with a reveal toggle.
 *
 * The toggle is a real button rather than a checkbox styled as one, so it is
 * reachable by keyboard and announces its state. Autocomplete is set
 * explicitly: `current-password` and `new-password` are what let a password
 * manager offer the right thing, and getting them wrong is why managers so
 * often offer to save a password on a login form.
 *
 * @param {{id: string, name: string, autocomplete: string, placeholder?: string,
 *          describedBy?: string, required?: boolean}} options
 */
function passwordInput({ id, name, autocomplete, placeholder = "", describedBy = "", required = true }) {
  return `<div class="input-affix">
    <input class="input" type="password" id="${esc(id)}" name="${esc(name)}"
           autocomplete="${esc(autocomplete)}" placeholder="${esc(placeholder)}"
           ${required ? "required" : ""}
           aria-describedby="${esc(describedBy || `${id}-error`)}"
           data-password>
    <button class="affix affix-btn" type="button" data-reveal="${esc(id)}"
            aria-label="Show password" aria-pressed="false">
      <span data-reveal-icon="show">${icon.eye(17)}</span>
      <span data-reveal-icon="hide" hidden>${icon.eyeOff(17)}</span>
    </button>
  </div>`;
}

/**
 * The panel beside every auth form.
 *
 * Deliberately not a testimonial or a statistic. What a person needs to know
 * before typing a password into a trading site is what the site is and who
 * holds the money — and here the answer to the second is "nobody", which is
 * worth saying plainly and early rather than in a footer.
 */
function asidePanel() {
  const points = [
    [icon.shield(18), "No client funds", "This platform holds no money and executes no orders on any market. Nothing you do here can move real value."],
    [icon.lock(18), "Passwords are never stored", "Only a scrypt digest is kept, and session tokens are stored as hashes. A copy of the database yields neither."],
    [icon.info(18), "Not a regulated firm", "Project X is a reference implementation. It publishes no licence number because it holds none."],
  ];

  return `<aside class="auth-aside">
    <div class="auth-aside-inner">
      <h2 class="h2">A brokerage platform, built in the open</h2>
      <p class="muted">Every financial law this system claims to hold is enforced
      as a test, and every figure it cannot obtain is reported as unavailable
      rather than as a zero.</p>
      <ul class="auth-points">
        ${points.map(([glyph, title, text]) => `<li>
          <span class="auth-point-icon">${glyph}</span>
          <div>
            <div class="auth-point-title">${esc(title)}</div>
            <p class="auth-point-text">${esc(text)}</p>
          </div>
        </li>`).join("")}
      </ul>
      <a class="auth-aside-link" href="/status">${icon.gauge(16)} Platform status</a>
    </div>
  </aside>`;
}

/**
 * Sign in.
 *
 * @param {{
 *   next?: string, error?: string, email?: string,
 *   twoFactor?: boolean, registered?: boolean, signedOut?: boolean,
 *   passwordChanged?: boolean
 * }} [options]
 */
export function loginPage({
  next = "/", error = "", email = "",
  twoFactor = false, registered = false, signedOut = false, passwordChanged = false,
} = {}) {
  // A notice, when arriving here from somewhere that had something to say. Only
  // one is ever shown: stacking "you registered" on "you signed out" on "your
  // password changed" turns the page into a changelog.
  const notice =
    registered
      ? ["checkCircle", "Account created", "Your account is ready. Sign in to continue."]
    : passwordChanged
      ? ["checkCircle", "Password changed", "Sign in again with your new password."]
    : signedOut
      ? ["check", "Signed out", "You have been signed out on this device."]
    : next && next !== "/"
      ? ["lock", "Sign in to continue", "That page belongs to your account, so it needs a session."]
    : null;

  return `<div class="auth-split">
    <div class="auth-main">
      <div class="auth-card">
        <div class="auth-head">
          <span class="brand-mark" aria-hidden="true">PX</span>
          <h1 class="h1">Sign in</h1>
          <p class="muted">Welcome back. Your accounts are where you left them.</p>
        </div>

        ${notice ? `<div class="notice notice-quiet">
          <span class="notice-icon">${icon[/** @type {"check"} */ (notice[0])](18)}</span>
          <div class="notice-body">
            <div class="notice-title">${esc(notice[1])}</div>
            <div class="notice-text">${esc(notice[2])}</div>
          </div>
        </div>` : ""}

        <p class="form-error" id="login-error" role="alert"${error ? "" : " hidden"}>
          <span class="form-error-icon">${icon.alert(16)}</span>
          <span data-error-text>${esc(error)}</span>
        </p>

        <form class="auth-form" method="post" action="/login" data-login-form novalidate>
          <input type="hidden" name="next" value="${esc(next)}">

          ${field({
            id: "login-email",
            label: "Email address",
            control: `<input class="input" type="email" id="login-email" name="email"
                        value="${esc(email)}" autocomplete="username" inputmode="email"
                        placeholder="you@example.com" required autofocus
                        aria-describedby="login-email-error">`,
          })}

          ${field({
            id: "login-password",
            label: "Password",
            control: passwordInput({
              id: "login-password", name: "password", autocomplete: "current-password",
              placeholder: "Your password",
            }),
          })}

          <!-- Shown only once the API has said this account carries a second
               factor. Rendered server-side when the page is reached that way, so
               the step survives a scriptless submit. -->
          <div data-totp-step${twoFactor ? "" : " hidden"}>
            ${field({
              id: "login-totp",
              label: "Authenticator code",
              hint: "Six digits from your authenticator app, or one recovery code.",
              control: `<input class="input input-code" type="text" id="login-totp" name="totp"
                          autocomplete="one-time-code" inputmode="numeric" maxlength="11"
                          placeholder="000000" aria-describedby="login-totp-hint login-totp-error">`,
            })}
          </div>

          <div class="auth-row">
            <label class="check">
              <input type="checkbox" name="remember" value="true" checked>
              <span>Keep me signed in</span>
            </label>
            <a class="small" href="/forgot-password">Forgot password?</a>
          </div>

          <button class="btn btn-primary btn-lg btn-block" type="submit" data-submit>
            <span data-submit-label>${icon.login(17)} Sign in</span>
            <span data-submit-busy hidden>Signing in…</span>
          </button>
        </form>

        <p class="auth-alt">
          New here? <a href="/register">Create an account</a>
        </p>
      </div>

      <p class="auth-foot micro muted">
        By signing in you agree to the <a href="/docs/terms">client agreement</a>
        and confirm you have read the <a href="/docs/risk">risk disclosure</a>.
      </p>
    </div>

    ${asidePanel()}
  </div>`;
}

/**
 * Create an account.
 *
 * The password requirements are listed *before* anything is typed rather than
 * revealed one refusal at a time. A form that rejects a password four times in
 * a row for four different reasons it never mentioned is a form people abandon.
 *
 * @param {{countries?: string[], currencies?: string[], error?: string,
 *          values?: {name?: string, email?: string, country?: string, baseCurrency?: string}}} [options]
 */
export function registerPage({
  countries = ["United Kingdom", "Other"],
  currencies = ["USD", "EUR", "GBP"],
  error = "",
  values = {},
} = {}) {
  const chosenCountry = values.country ?? "";
  const chosenCurrency = values.baseCurrency ?? "USD";

  return `<div class="auth-split">
    <div class="auth-main">
      <div class="auth-card auth-card-wide">
        <div class="auth-head">
          <span class="brand-mark" aria-hidden="true">PX</span>
          <h1 class="h1">Create an account</h1>
          <p class="muted">One account holds your trading accounts, funding and statements.</p>
        </div>

        <p class="form-error" id="register-error" role="alert"${error ? "" : " hidden"}>
          <span class="form-error-icon">${icon.alert(16)}</span>
          <span data-error-text>${esc(error)}</span>
        </p>

        <form class="auth-form" method="post" action="/register" data-register-form novalidate>
          ${field({
            id: "register-name",
            label: "Full name",
            hint: "As it appears on your identity document.",
            control: `<input class="input" type="text" id="register-name" name="name"
                        value="${esc(values.name ?? "")}" autocomplete="name"
                        placeholder="Ada Lovelace" required autofocus
                        aria-describedby="register-name-hint register-name-error">`,
          })}

          ${field({
            id: "register-email",
            label: "Email address",
            hint: "Used to sign in, and for account and security notices.",
            control: `<input class="input" type="email" id="register-email" name="email"
                        value="${esc(values.email ?? "")}" autocomplete="email" inputmode="email"
                        placeholder="you@example.com" required
                        aria-describedby="register-email-hint register-email-error">`,
          })}

          ${field({
            id: "register-password",
            label: "Password",
            control: `${passwordInput({
              id: "register-password", name: "password", autocomplete: "new-password",
              placeholder: "At least 10 characters",
              describedBy: "register-password-rules register-password-error",
            })}
            <div class="pw-meter" data-meter hidden>
              <div class="pw-meter-track" aria-hidden="true">
                ${[0, 1, 2, 3].map((i) => `<span class="pw-meter-seg" data-seg="${i}"></span>`).join("")}
              </div>
              <span class="pw-meter-label micro muted" data-meter-label aria-live="polite"></span>
            </div>
            <ul class="pw-rules" id="register-password-rules">
              <li data-rule="length">
                <span class="pw-rule-mark" aria-hidden="true">${icon.check(13)}</span>
                At least 10 characters
              </li>
              <li data-rule="variety">
                <span class="pw-rule-mark" aria-hidden="true">${icon.check(13)}</span>
                Mixes letters with numbers or symbols
              </li>
              <li data-rule="personal">
                <span class="pw-rule-mark" aria-hidden="true">${icon.check(13)}</span>
                Does not contain your name or email
              </li>
            </ul>`,
          })}

          ${field({
            id: "register-confirm",
            label: "Confirm password",
            control: passwordInput({
              id: "register-confirm", name: "confirmPassword", autocomplete: "new-password",
              placeholder: "Type it again",
            }),
          })}

          <div class="field-pair">
            ${field({
              id: "register-country",
              label: "Country of residence",
              control: `<select class="select" id="register-country" name="country" required
                          aria-describedby="register-country-error">
                <option value="" ${chosenCountry ? "" : "selected"} disabled>Choose a country</option>
                ${countries.map((c) => `<option value="${esc(c)}"${
                  c === chosenCountry ? " selected" : ""
                }>${esc(c)}</option>`).join("")}
              </select>`,
            })}

            ${field({
              id: "register-currency",
              label: "Account currency",
              hint: "The currency your statements are presented in.",
              control: `<select class="select" id="register-currency" name="baseCurrency"
                          aria-describedby="register-currency-hint register-currency-error">
                ${currencies.map((c) => `<option value="${esc(c)}"${
                  c === chosenCurrency ? " selected" : ""
                }>${esc(c)}</option>`).join("")}
              </select>`,
            })}
          </div>

          <div class="field" data-field="register-terms">
            <label class="check check-block">
              <input type="checkbox" id="register-terms" name="acceptedTerms" value="true"
                     aria-describedby="register-terms-error">
              <span>I have read and accept the
                <a href="/docs/terms">client agreement</a>,
                the <a href="/docs/risk">risk disclosure</a> and the
                <a href="/docs/privacy">privacy policy</a>.</span>
            </label>
            <p class="field-error" id="register-terms-error" role="alert" hidden></p>
          </div>

          <button class="btn btn-primary btn-lg btn-block" type="submit" data-submit>
            <span data-submit-label>${icon.userPlus(17)} Create account</span>
            <span data-submit-busy hidden>Creating your account…</span>
          </button>
        </form>

        <p class="auth-alt">
          Already registered? <a href="/login">Sign in</a>
        </p>
      </div>

      <div class="notice notice-quiet auth-foot">
        <span class="notice-icon">${icon.info(18)}</span>
        <div class="notice-body">
          <div class="notice-title">Registering does not verify your identity</div>
          <div class="notice-text">An account here proves you own this login and
          nothing more. Identity verification belongs to
          <code class="mono">16-kyc-aml</code>, which has not passed its gates, so
          no document is collected and none is checked.</div>
        </div>
      </div>
    </div>

    ${asidePanel()}
  </div>`;
}

/**
 * Forgot password.
 *
 * A real form now. It always reports the same thing whether or not the address
 * is registered — telling somebody "no account with that address" answers "does
 * this person bank here?" for anyone who cares to ask, and on a financial site
 * that answer is worth money.
 *
 * What it does *not* do is claim an email was sent. This platform has no email
 * provider, so the link is written to an outbox instead, and the page says so
 * rather than leaving somebody locked out waiting for a message that will never
 * arrive.
 *
 * @param {{sent?: boolean, email?: string, error?: string, devLink?: string|null,
 *          deliveryEnabled?: boolean}} [options]
 */
export function forgotPasswordPage({
  sent = false, email = "", error = "", devLink = null, deliveryEnabled = false,
} = {}) {
  const form = `<form class="auth-form" method="post" action="/forgot-password" data-forgot-form novalidate>
    ${field({
      id: "forgot-email",
      label: "Email address",
      hint: "The address you signed up with.",
      control: `<input class="input" type="email" id="forgot-email" name="email"
                  value="${esc(email)}" autocomplete="username" inputmode="email"
                  placeholder="you@example.com" required autofocus
                  aria-describedby="forgot-email-hint forgot-email-error">`,
    })}
    <button class="btn btn-primary btn-lg btn-block" type="submit" data-submit>
      <span data-submit-label>${icon.mail(17)} Send a reset link</span>
      <span data-submit-busy hidden>Working…</span>
    </button>
  </form>`;

  // What this says depends on whether a message will actually be sent. Saying
  // "check your inbox" with no provider strands somebody who is already locked
  // out; saying "nothing was emailed" once delivery works sends them looking
  // for a workaround they do not need. Neither sentence is safe to hard-code.
  const confirmation = `<div class="notice notice-quiet">
      <span class="notice-icon">${icon.checkCircle(18)}</span>
      <div class="notice-body">
        <div class="notice-title">If that address has an account, a link has been created</div>
        <div class="notice-text">It works once and expires in an hour. Requesting
        another link invalidates this one.</div>
      </div>
    </div>

    ${deliveryEnabled
      ? `<div class="notice notice-quiet" style="margin-top:var(--s-4)">
          <span class="notice-icon">${icon.mail(18)}</span>
          <div class="notice-body">
            <div class="notice-title">Check your inbox</div>
            <div class="notice-text">The link is on its way to that address. If it
            does not arrive, check the spam folder before requesting another —
            a new link invalidates the one already sent.</div>
          </div>
        </div>`
      : `<div class="notice notice-warning" style="margin-top:var(--s-4)">
          <span class="notice-icon">${icon.alert(18)}</span>
          <div class="notice-body">
            <div class="notice-title">Nothing was emailed to you</div>
            <div class="notice-text">This deployment has no email provider
            configured, so the link was written to an outbox rather than
            delivered. That is stated here rather than left for you to discover
            by waiting.</div>
          </div>
        </div>`}

    ${devLink ? `<div class="card card-pad" style="margin-top:var(--s-4)">
      <div class="eyebrow" style="margin-bottom:var(--s-2)">Development only</div>
      <p class="small muted" style="margin-bottom:var(--s-3)">The link that would
      have been emailed. Shown because there is nowhere to send it; never shown
      where an email provider exists.</p>
      <a class="btn btn-secondary btn-block" href="${esc(devLink)}">Open the reset link</a>
    </div>` : ""}`;

  return `<div class="auth-split">
    <div class="auth-main">
      <div class="auth-card">
        <div class="auth-head">
          <span class="brand-mark" aria-hidden="true">PX</span>
          <h1 class="h1">Forgot password</h1>
          <p class="muted">${
            sent
              ? "Here is what happens next."
              : "Enter your address and we will create a reset link."
          }</p>
        </div>

        <p class="form-error" id="forgot-error" role="alert"${error ? "" : " hidden"}>
          <span class="form-error-icon">${icon.alert(16)}</span>
          <span data-error-text>${esc(error)}</span>
        </p>

        <div data-forgot-result${sent ? "" : " hidden"}>${sent ? confirmation : ""}</div>
        <div data-forgot-ask${sent ? " hidden" : ""}>${form}</div>

        <div class="card card-pad" style="margin-top:var(--s-5)">
          <h2 class="h3" style="margin-bottom:var(--s-3)">Other ways in</h2>
          <ul class="plain-list">
            <li><strong>Still signed in somewhere?</strong> Open
              <a href="/security">Security</a> on that device and change your
              password there — it needs your current one, not a link.</li>
            <li><strong>Locked out after failed attempts?</strong> The lock clears
              itself after fifteen minutes, and a completed reset clears it
              immediately.</li>
            <li><strong>Lost your authenticator?</strong> Use one of the recovery
              codes issued when you turned two-factor on. Each works once, in the
              same box as the six-digit code.</li>
          </ul>
        </div>

        <p class="auth-alt"><a href="/login">Back to sign in</a></p>
      </div>
    </div>

    ${asidePanel()}
  </div>`;
}

/**
 * Set a new password from a reset link.
 *
 * The token's validity is checked before this renders, so a stale link says so
 * immediately instead of after somebody has typed a new password twice.
 *
 * @param {{token?: string, valid?: boolean, error?: string}} [options]
 */
export function resetPasswordPage({ token = "", valid = true, error = "" } = {}) {
  if (!valid) {
    return `<div class="auth-split">
      <div class="auth-main">
        <div class="auth-card">
          <div class="auth-head">
            <span class="brand-mark" aria-hidden="true">PX</span>
            <h1 class="h1">That link has expired</h1>
            <p class="muted">Reset links work once and last an hour.</p>
          </div>
          <div class="notice notice-warning">
            <span class="notice-icon">${icon.alert(18)}</span>
            <div class="notice-body">
              <div class="notice-title">Nothing has changed on your account</div>
              <div class="notice-text">An expired or already-used link cannot set a
              password. Request a new one and it will invalidate any older link.</div>
            </div>
          </div>
          <a class="btn btn-primary btn-lg btn-block" href="/forgot-password"
             style="margin-top:var(--s-5)">Request a new link</a>
          <p class="auth-alt"><a href="/login">Back to sign in</a></p>
        </div>
      </div>
      ${asidePanel()}
    </div>`;
  }

  return `<div class="auth-split">
    <div class="auth-main">
      <div class="auth-card">
        <div class="auth-head">
          <span class="brand-mark" aria-hidden="true">PX</span>
          <h1 class="h1">Choose a new password</h1>
          <p class="muted">Setting it signs out every device, including this one.</p>
        </div>

        <p class="form-error" id="reset-error" role="alert"${error ? "" : " hidden"}>
          <span class="form-error-icon">${icon.alert(16)}</span>
          <span data-error-text>${esc(error)}</span>
        </p>

        <form class="auth-form" method="post" action="/reset-password" data-reset-form novalidate>
          <input type="hidden" name="token" value="${esc(token)}">

          ${field({
            id: "reset-password",
            label: "New password",
            control: `${passwordInput({
              id: "reset-password", name: "newPassword", autocomplete: "new-password",
              placeholder: "At least 10 characters",
            })}`,
          })}

          ${field({
            id: "reset-confirm",
            label: "Confirm new password",
            control: passwordInput({
              id: "reset-confirm", name: "confirmPassword", autocomplete: "new-password",
              placeholder: "Type it again",
            }),
          })}

          <button class="btn btn-primary btn-lg btn-block" type="submit" data-submit>
            <span data-submit-label>${icon.key(17)} Set new password</span>
            <span data-submit-busy hidden>Setting…</span>
          </button>
        </form>

        <p class="auth-alt"><a href="/login">Back to sign in</a></p>
      </div>
    </div>

    ${asidePanel()}
  </div>`;
}

/**
 * The result of following an address-confirmation link.
 *
 * @param {{verified?: boolean, email?: string, error?: string}} [options]
 */
export function verifyEmailPage({ verified = false, email = "", error = "" } = {}) {
  return `<div class="auth-split">
    <div class="auth-main">
      <div class="auth-card">
        <div class="auth-head">
          <span class="brand-mark" aria-hidden="true">PX</span>
          <h1 class="h1">${verified ? "Address confirmed" : "That link did not work"}</h1>
          <p class="muted">${
            verified
              ? "Thank you — we now know this address reaches you."
              : "Confirmation links work once and expire after a day."
          }</p>
        </div>

        <div class="notice ${verified ? "notice-quiet" : "notice-warning"}">
          <span class="notice-icon">${verified ? icon.checkCircle(18) : icon.alert(18)}</span>
          <div class="notice-body">
            <div class="notice-title">${
              verified ? esc(email || "Your address is confirmed") : "Nothing has changed"
            }</div>
            <div class="notice-text">${
              verified
                ? "Confirming an address does not verify your identity — that belongs to 16-kyc-aml, which has not passed its gates."
                : esc(error || "Request a new confirmation link from your profile.")
            }</div>
          </div>
        </div>

        <a class="btn btn-primary btn-lg btn-block" href="/" style="margin-top:var(--s-5)">
          Go to my accounts
        </a>
      </div>
    </div>

    ${asidePanel()}
  </div>`;
}

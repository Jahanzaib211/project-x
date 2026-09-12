#!/usr/bin/env bash
# =============================================================================
# G4 — invariants of 19-client-api and 20-web
# =============================================================================
# The client area is the surface a person actually believes. Its laws are about
# what it is allowed to claim: it may report what the core computed, and it may
# report that it does not know. It may not split the difference by showing a
# comforting zero.
#
# Static checks always run. Live checks run too when the stack is up.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
pass() { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; fail=1; }

API="${API:-http://127.0.0.1:27001}"
WEB="${WEB:-http://127.0.0.1:27000}"

echo "client area invariants:"

# ---------------------------------------------------------------------------
# INV-184 — the edge stores no financial value.
# ---------------------------------------------------------------------------
if grep -qiE '^\s*(balance|equity|margin|free_margin|pnl)[a-z_]*\s+(BIGINT|NUMERIC|DECIMAL|INTEGER|REAL|DOUBLE)' \
     services/client-api/src/db.js; then
  bad "INV-184 the client-area schema declares a financial column"
else
  pass "INV-184 no balance/equity/margin column in the client-area schema"
fi

# The core's own ledger must not have grown one either.
if grep -qiE '^\s*balance\s+(BIGINT|NUMERIC|DECIMAL)' infra/postgres/init/001_schema.sql; then
  bad "INV-023 ledger.accounts grew a balance column"
else
  pass "INV-023 ledger balances remain a view over the journal"
fi

# ---------------------------------------------------------------------------
# INV-183 — unavailable means null plus a reason, never a zero.
# ---------------------------------------------------------------------------
if grep -q 'balance: null' services/client-api/src/accounts.js &&
   grep -q 'balanceUnavailableReason' services/client-api/src/accounts.js; then
  pass "INV-183 accounts report balance as null with a stated reason"
else
  bad "INV-183 account presentation does not return a null balance with a reason"
fi

# A zero standing in for an unknown balance is the exact failure this forbids.
if grep -nE '(balance|equity)"?\s*:\s*(0|"0\.00"|0\.0)\b' \
     services/client-api/src/*.js apps/web/src/pages/*.js 2>/dev/null | grep -q .; then
  bad "INV-183 a zero is being substituted for an unknown financial figure"
else
  pass "INV-183 no zero is substituted for an unknown figure"
fi

# ---------------------------------------------------------------------------
# INV-190 / INV-191 — the UI computes nothing about money.
# ---------------------------------------------------------------------------
if grep -nE '(amount|balance|equity|total|fee)\s*[-+*/]=?\s*[a-zA-Z0-9_.]*(amount|balance|price|equity|total)' \
     apps/web/src/**/*.js apps/web/src/*.js 2>/dev/null | grep -v '^\s*//' | grep -q .; then
  bad "INV-191 the web app performs arithmetic on money"
else
  pass "INV-191 the web app performs no arithmetic on money"
fi

if grep -nE '(parseFloat|parseInt|Number)\s*\(\s*[a-zA-Z_.]*(amount|balance|price|equity|margin)' \
     apps/web/src/*.js apps/web/src/*/*.js 2>/dev/null | grep -q .; then
  bad "INV-191 the web app parses money into a JavaScript number"
else
  pass "INV-191 money is never parsed into a JavaScript number"
fi

# ---------------------------------------------------------------------------
# INV-180 — the API forwards what the core computed; it computes nothing.
# ---------------------------------------------------------------------------
# Comment lines are excluded — including JSDoc continuations, which begin with
# `*`. A doc comment mentioning `08-pnl-margin` matched the arithmetic pattern
# and failed this check, which is the kind of false positive that gets a real
# check disabled rather than fixed.
if grep -nE '(balance|equity|margin|pnl|notional)\s*[-+*/]=?\s*[a-zA-Z0-9_.]' \
     services/client-api/src/server.js services/client-api/src/accounts.js 2>/dev/null \
     | grep -vE ':\s*(//|\*|/\*)' | grep -q .; then
  bad "INV-180 the API performs arithmetic on a financial figure"
else
  pass "INV-180 the API computes no financial figure"
fi

# ---------------------------------------------------------------------------
# INV-182 — a published schema version never changes meaning.
# The contract is pinned here; changing a documented key is a breaking change
# and has to be a deliberate edit to this list, not a drive-by rename.
# ---------------------------------------------------------------------------
CONTRACT_ACCOUNT="accountNumber platform accountType mode nickname currency leverage status balance balanceUnavailableReason"
missing=""
for key in $CONTRACT_ACCOUNT; do
  grep -q "$key" services/client-api/src/accounts.js || missing="$missing $key"
done
if [ -n "$missing" ]; then
  bad "INV-182 the account contract lost documented field(s):$missing"
else
  pass "INV-182 the published account contract is intact"
fi

# ---------------------------------------------------------------------------
# INV-181 — mutating endpoints require an idempotency key.
# ---------------------------------------------------------------------------
if grep -q 'requireIdempotencyKey' services/client-api/src/server.js; then
  pass "INV-181 mutating endpoints demand an idempotency key"
else
  bad "INV-181 no idempotency enforcement found"
fi

# ---------------------------------------------------------------------------
# INV-185 — a credential is never stored in a form it can be recovered from.
# ---------------------------------------------------------------------------
# The failure this forbids is not "we were breached" — it is "we were breached
# and the attacker now holds everyone's password". A password is a scrypt
# digest and a session token is a SHA-256 of itself, so a dump of this schema
# yields neither a password nor a usable session.
if grep -qE 'CREATE TABLE IF NOT EXISTS app\.users' services/client-api/src/db.js &&
   ! grep -qE '^\s*(password|secret|token)\s+TEXT' services/client-api/src/db.js; then
  pass "INV-185 no column stores a raw password or token"
else
  bad "INV-185 the identity schema appears to store a credential in the clear"
fi

if grep -q 'token_digest' services/client-api/src/db.js &&
   ! grep -qE '^\s*token\s+' services/client-api/src/db.js; then
  pass "INV-185 sessions are stored as a digest, not as the token"
else
  bad "INV-185 the sessions table stores the session token itself"
fi

if grep -q 'scrypt' services/client-api/src/auth.js &&
   grep -q 'timingSafeEqual' services/client-api/src/auth.js; then
  pass "INV-185 passwords are hashed with scrypt and compared in constant time"
else
  bad "INV-185 password hashing or constant-time comparison is missing"
fi

# The presenter is the boundary between a user row and the outside world. If it
# ever spreads the row, every column leaves with it — including the digest.
# `Boolean(row.totp_secret)` is allowed and is the point: whether a second
# factor exists is public, the secret behind it is not.
if python3 - <<'PRESENTER'
import re, sys
src = open("services/client-api/src/auth.js").read()
body = re.search(r"function presentUser\(row\)\s*\{(.*?)\n\}", src, re.S)
if not body:
    print("presentUser not found"); sys.exit(1)
text = body.group(1)
# Any mention of credential material that is not wrapped in Boolean() leaks it.
text = text.replace("Boolean(row.totp_secret)", "")
leaks = re.findall(r"row\.(password\w*|totp\w*|token\w*)|\.\.\.row", text)
sys.exit(1 if leaks else 0)
PRESENTER
then
  pass "INV-185 the user presenter exposes no credential material"
else
  bad "INV-185 the user presenter exposes credential material"
fi

# ---------------------------------------------------------------------------
# INV-186 — a refused sign-in does not say whether the address is registered.
# ---------------------------------------------------------------------------
# An error that distinguishes "no such user" from "wrong password" turns the
# login form into a way to discover who banks here.
# Matched loosely on purpose: the throw grew a `credentialRejected` option and
# an exact-text grep silently stopped matching, reporting the invariant broken
# when only its spelling had changed.
if grep -q 'BAD_CREDENTIALS' services/client-api/src/auth.js &&
   [ "$(grep -c 'HttpError(401, BAD_CREDENTIALS' services/client-api/src/auth.js)" -ge 2 ]; then
  pass "INV-186 one refusal message covers the missing user and the wrong password"
else
  bad "INV-186 sign-in refusals are not a single shared message"
fi

if grep -q 'absentUserDigest' services/client-api/src/auth.js; then
  pass "INV-186 an absent user still costs a full verification (no timing oracle)"
else
  bad "INV-186 a login for an unknown address returns without doing the work"
fi

# ---------------------------------------------------------------------------
# INV-187 — a session reaches only the rows its own user owns.
# ---------------------------------------------------------------------------
# Every statement touching a session addresses it by the user who owns it, or
# by a digest the caller proved they hold — never by a bare identifier. Checked
# per statement rather than per line, because the SQL here spans several lines
# and a line-wise grep reads "FROM app.sessions" as unscoped every time.
if python3 - <<'SCOPE'
import re, sys
src = open("services/client-api/src/auth.js").read()
offenders = []
for statement in re.findall(r"`([^`]*app\.sessions[^`]*)`", src, re.S):
    flat = " ".join(statement.split())
    if flat.lstrip().upper().startswith("INSERT"):
        continue  # an INSERT names the owner in its column list
    # A maintenance sweep is bounded by time, not by identity, and is allowed.
    if "expires_at <" in flat or "revoked_at <" in flat:
        continue
    if "user_id" in flat or "token_digest" in flat:
        continue
    offenders.append(flat[:90])
for o in offenders:
    print("   unscoped:", o)
sys.exit(1 if offenders else 0)
SCOPE
then
  pass "INV-187 every session statement is scoped by its owner or its digest"
else
  bad "INV-187 a session statement is not scoped to its owner"
fi

if grep -q 'WHERE user_id = \$1 AND session_id = \$2' services/client-api/src/auth.js; then
  pass "INV-187 revoking a session requires it to belong to the caller"
else
  bad "INV-187 a session can be revoked without owning it"
fi

# ---------------------------------------------------------------------------
# INV-189 — a password reset is single-use, expiring, and stored as a digest.
# ---------------------------------------------------------------------------
# The failure this forbids: a reset table that can be read to mint a reset, or a
# link that keeps working after it has been used. Either turns a read-only
# database disclosure, or one leaked email, into account takeover.
if grep -q 'token_digest TEXT        PRIMARY KEY' services/client-api/src/db.js &&
   ! grep -qE 'CREATE TABLE IF NOT EXISTS app\.one_time_tokens[^)]*token +TEXT' services/client-api/src/db.js; then
  pass "INV-189 reset tokens are stored as digests, never as tokens"
else
  bad "INV-189 the one-time token table appears to store the token itself"
fi

if grep -q 'consumed_at' services/client-api/src/auth.js &&
   grep -q 'expires_at > now()' services/client-api/src/auth.js; then
  pass "INV-189 a reset token is consumable and time-bounded"
else
  bad "INV-189 reset tokens are not marked consumed or not expired"
fi

# Completing a reset revokes everything. Somebody resetting a password is either
# recovering an account or was locked out of it; leaving old sessions alive
# defeats the purpose in both cases.
if grep -A 6 'password_reset_completed' services/client-api/src/auth.js \
     | grep -q 'revoked_at = now()' ||
   grep -B 12 'password_reset_completed' services/client-api/src/auth.js \
     | grep -q 'UPDATE app.sessions SET revoked_at = now()'; then
  pass "INV-189 completing a reset revokes every session"
else
  bad "INV-189 a completed reset leaves sessions alive"
fi

# The reset request answers identically whether or not the address exists.
if grep -q 'Always reports success' services/client-api/src/auth.js ||
   grep -q 'If that address has an account' services/client-api/src/auth.js; then
  pass "INV-189 a reset request does not reveal whether an address is registered"
else
  bad "INV-189 the reset request may disclose which addresses have accounts"
fi

# ---------------------------------------------------------------------------
# INV-192 — the session token is never reachable by script.
# ---------------------------------------------------------------------------
# It lives in an HttpOnly cookie the web server sets, and is stripped from the
# response body on the way past. Without both halves, an XSS becomes an account
# takeover rather than a defacement.
# Comments are stripped first. Both attributes are discussed at length in the
# doc comment above the cookie builder, so a plain grep stays green even after
# the code stops setting them — which is a check that cannot fail.
if python3 - <<'COOKIE'
import re, sys
src = open("apps/web/src/server.js").read()
code = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
code = re.sub(r"(?m)^\s*//.*$", "", code)
fn = re.search(r"function sessionCookie\(.*?\n\}", code, re.S)
if not fn:
    print("   sessionCookie() not found"); sys.exit(1)
body = fn.group(0)
missing = [a for a in ("HttpOnly", "SameSite=Lax") if a not in body]
for a in missing:
    print("   the session cookie no longer sets", a)
sys.exit(1 if missing else 0)
COOKIE
then
  pass "INV-192 the session cookie is HttpOnly and SameSite"
else
  bad "INV-192 the session cookie is not HttpOnly/SameSite"
fi

if grep -q 'const { token: _token, ...rest } = payload' apps/web/src/server.js; then
  pass "INV-192 the token is stripped from the proxied response body"
else
  bad "INV-192 the login response may carry the token into the browser"
fi

# localStorage holds preferences only. A token there is readable by any script
# on the page, which is the whole thing HttpOnly exists to prevent.
if grep -nE 'localStorage\.setItem' apps/web/src/client.js | grep -viE 'px-theme|px-rail' | grep -q .; then
  bad "INV-192 something other than a display preference is written to localStorage"
else
  pass "INV-192 localStorage holds display preferences only"
fi

# ---------------------------------------------------------------------------
# Live checks, when the stack is running.
# ---------------------------------------------------------------------------
if curl -sf --max-time 3 "$API/health" >/dev/null 2>&1; then
  echo "  (live checks — API is up)"

  # A session of this gate's own. The deployed configuration refuses anonymous
  # requests (AUTH_REQUIRED=true), and the money rules must hold for a signed-in
  # person just the same — so the checks below act as one rather than relying
  # on the development identity that a deployment does not have.
  gate_stamp="$(date +%s%N)"
  gate_reg="$(curl -s --max-time 5 -X POST "$API/v1/auth/register" -H 'content-type: application/json'     -H "x-forwarded-for: ${GATE_ADDR:-10.99.0.1}"     -d "{\"name\":\"Inv Gate\",\"email\":\"inv-gate-$gate_stamp@example.test\",\"password\":\"a-properly-long-password\",\"acceptedTerms\":true}")"
  gate_token="$(printf '%s' "$gate_reg" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  AS_GATE=(-H "authorization: Bearer $gate_token")

  # INV-183 is not "the balance is always null" — the ledger holds real demo
  # balances now, and a check that demanded null would fail the moment the
  # system started working. The rule is: a figure is either an exact decimal
  # string, or it is null *with a stated reason*. It is never a zero standing in
  # for something unknown.
  wallet="$(curl -s --max-time 3 "${AS_GATE[@]}" "$API/v1/wallet")"
  if echo "$wallet" | grep -qE '"balance":"-?[0-9]+\.[0-9]+"'; then
    pass "INV-183 live: /v1/wallet reports a balance as an exact decimal string"
  elif echo "$wallet" | grep -q '"balance":null' && echo "$wallet" | grep -q 'unavailableReason'; then
    pass "INV-183 live: /v1/wallet returns null with a reason"
  else
    bad "INV-183 live: /v1/wallet gave neither a decimal balance nor a null with a reason"
  fi

  # A mutating call without a key must be refused.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -X POST "$API/v1/accounts" \
          "${AS_GATE[@]}" -H 'content-type: application/json' -d '{}')"
  if [ "$code" = "400" ]; then
    pass "INV-181 live: a mutating call without an idempotency key is refused"
  else
    bad "INV-181 live: expected 400 without an idempotency key, got $code"
  fi

  # Money as a JSON number must be refused.
  refusal="$(curl -s --max-time 3 -X POST "$API/v1/funding/deposit" \
             "${AS_GATE[@]}" -H 'content-type: application/json' -H 'idempotency-key: inv-check-0001' \
             -d '{"amount":250.5,"method":"card"}')"
  if echo "$refusal" | grep -q 'exact decimal string'; then
    pass "INV-001 live: money sent as a JSON number is refused"
  else
    bad "INV-001 live: a floating-point amount was accepted"
  fi

  # ---- INV-185/186/187, against the API directly ----
  # Driven through $API rather than the web app, so these still run when only
  # the API is up. The one check that genuinely needs the browser-facing proxy
  # is INV-192, and it lives under the $WEB guard below — a gate that fails
  # because a service is down, rather than reporting it skipped, teaches people
  # to ignore it.
  stamp="$(date +%s%N)"
  # This gate's own sign-in failure budget — see the note in check_security.sh.
  GATE_ADDR="198.51.100.30"
  alice="inv-a-$stamp@example.test"; bob="inv-b-$stamp@example.test"
  secret="a-properly-long-password"

  register_as() {
    curl -s --max-time 5 -X POST "$API/v1/auth/register" -H 'content-type: application/json' -H "x-forwarded-for: $GATE_ADDR" \
      -d "{\"name\":\"Inv Person\",\"email\":\"$1\",\"password\":\"$secret\",\"acceptedTerms\":true}"
  }
  token_of() { printf '%s' "$1" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }

  reg_a="$(register_as "$alice")"
  reg_b="$(register_as "$bob")"
  tok_a="$(token_of "$reg_a")"; tok_b="$(token_of "$reg_b")"

  # INV-185: nothing credential-shaped comes back from registration. The session
  # token is expected here — this is the API, which speaks bearer tokens; it is
  # the *web* response that must not carry one, and INV-192 checks that.
  if echo "$reg_a" | grep -qiE '"(password|password_hash|passwordHash|totp_secret)"'; then
    bad "INV-185 live: the registration response carries credential material"
  else
    pass "INV-185 live: the registration response carries no credential material"
  fi

  # INV-186: a wrong password and an unknown address answer identically.
  wrong="$(curl -s --max-time 5 -X POST "$API/v1/auth/login" -H 'content-type: application/json' \
           -H "x-forwarded-for: $GATE_ADDR" \
           -d "{\"email\":\"$alice\",\"password\":\"definitely-not-it\"}")"
  absent="$(curl -s --max-time 5 -X POST "$API/v1/auth/login" -H 'content-type: application/json' \
            -H "x-forwarded-for: $GATE_ADDR" \
            -d "{\"email\":\"nobody-$stamp@example.test\",\"password\":\"definitely-not-it\"}")"
  if [ -n "$wrong" ] && [ "$wrong" = "$absent" ]; then
    pass "INV-186 live: a wrong password and an unknown address are indistinguishable"
  else
    bad "INV-186 live: sign-in refusals differ ($wrong vs $absent)"
  fi

  # INV-189: a reset link works once, and the second attempt is refused.
  reset_email="inv-reset-$stamp@example.test"
  register_as "$reset_email" >/dev/null
  curl -s --max-time 5 -o /dev/null -X POST "$API/v1/auth/password/forgot" \
    -H 'content-type: application/json' -d "{\"email\":\"$reset_email\"}"

  # From the outbox where it is exposed, otherwise from the mail sink. Neither
  # is assumed: the deployed configuration closes the outbox.
  reset_token="$(curl -s --max-time 5 "$API/v1/auth/outbox?to=$reset_email" 2>/dev/null \
    | grep -o 'reset-password?token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)"
  if [ -z "$reset_token" ]; then
    # Mailpit's search returns summaries, not bodies: find the message, then
    # read it. The outbox worker drains every five seconds, so wait for it.
    mailpit="${MAILPIT_URL:-http://127.0.0.1:27020}"
    for _ in 1 2 3 4 5 6 7 8; do
      msg_id="$(curl -s --max-time 5 "$mailpit/api/v1/search?query=to:$reset_email" 2>/dev/null \
        | grep -o '"ID":"[A-Za-z0-9]*"' | head -1 | cut -d'"' -f4)"
      if [ -n "$msg_id" ]; then
        reset_token="$(curl -s --max-time 5 "$mailpit/api/v1/message/$msg_id" 2>/dev/null \
          | grep -o 'reset-password?token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)"
      fi
      [ -n "$reset_token" ] && break
      sleep 2
    done
  fi

  if [ -n "$reset_token" ]; then
    first="$(curl -s --max-time 5 -X POST "$API/v1/auth/password/reset" \
      -H 'content-type: application/json' -H "x-forwarded-for: $GATE_ADDR" \
      -d "{\"token\":\"$reset_token\",\"newPassword\":\"a-replacement-password\"}")"
    second="$(curl -s --max-time 5 -X POST "$API/v1/auth/password/reset" \
      -H 'content-type: application/json' -H "x-forwarded-for: $GATE_ADDR" \
      -d "{\"token\":\"$reset_token\",\"newPassword\":\"yet-another-password\"}")"

    if echo "$first" | grep -q '"reset":true' && echo "$second" | grep -qi 'no longer valid\|already been used'; then
      pass "INV-189 live: a reset link works once and is refused the second time"
    else
      bad "INV-189 live: the reset link did not behave as single-use"
    fi

    # And the old password is genuinely gone.
    old_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST "$API/v1/auth/login" \
      -H 'content-type: application/json' -H "x-forwarded-for: $GATE_ADDR" \
      -d "{\"email\":\"$reset_email\",\"password\":\"$secret\"}")"
    if [ "$old_code" = "401" ]; then
      pass "INV-189 live: the password in use before the reset no longer works"
    else
      bad "INV-189 live: the pre-reset password still signs in (got $old_code)"
    fi
  else
    bad "INV-189 live: no reset link was produced"
  fi

  # INV-187: an account opened by one session is invisible to every other.
  if [ -n "$tok_a" ] && [ -n "$tok_b" ]; then
    nickname="inv-private-$stamp"
    curl -s --max-time 5 -o /dev/null -X POST "$API/v1/accounts" \
      -H 'content-type: application/json' -H "authorization: Bearer $tok_a" \
      -H "idempotency-key: inv-iso-$stamp" \
      -d "{\"accountType\":\"Standard\",\"platform\":\"MT5\",\"mode\":\"demo\",\"nickname\":\"$nickname\",\"currency\":\"USD\",\"leverage\":200}"

    mine="$(curl -s --max-time 5 -H "authorization: Bearer $tok_a" "$API/v1/accounts?status=active")"
    theirs="$(curl -s --max-time 5 -H "authorization: Bearer $tok_b" "$API/v1/accounts?status=active")"
    anon="$(curl -s --max-time 5 "$API/v1/accounts?status=active")"

    if echo "$mine" | grep -q "$nickname" &&
       ! echo "$theirs" | grep -q "$nickname" &&
       ! echo "$anon" | grep -q "$nickname"; then
      pass "INV-187 live: an account is visible only to the session that owns it"
    else
      bad "INV-187 live: an account leaked across sessions"
    fi
  else
    bad "INV-187 live: could not establish two sessions to compare"
  fi

  if curl -sf --max-time 3 "$WEB/api/health" >/dev/null 2>&1; then
    # INV-192: the web app is the only place a bearer token becomes a cookie,
    # so this is the only place the property can be observed.
    jar="$(mktemp)"
    web_reg="$(curl -s --max-time 5 -c "$jar" -X POST "$WEB/api/v1/auth/register" \
      -H 'content-type: application/json' \
      -d "{\"name\":\"Inv Web\",\"email\":\"inv-w-$stamp@example.test\",\"password\":\"$secret\",\"acceptedTerms\":true}")"

    if grep -q 'px_session' "$jar" && grep -qi '#HttpOnly' "$jar"; then
      pass "INV-192 live: the session arrives as an HttpOnly cookie"
    else
      bad "INV-192 live: no HttpOnly session cookie was set"
    fi

    # And the token reaches the browser in that cookie only — never in the body,
    # where any script on the page could read it.
    if echo "$web_reg" | grep -q '"token"'; then
      bad "INV-192 live: the web response body carries the session token"
    else
      pass "INV-192 live: the token is absent from the web response body"
    fi
    # Signed in as the person just registered — a deployment sends a signed-out
    # visitor to /login. The shell must show either the ledger's exact figure or
    # "Balance unavailable"; a fresh person has no account, so it is the latter.
    html="$(curl -s --max-time 5 -b "$jar" "$WEB/")"
    rm -f "$jar"
    if echo "$html" | grep -q 'Balance unavailable'; then
      pass "INV-190 live: the page reports balances as unavailable"
    elif echo "$html" | grep -qE 'data-wallet-balance>[0-9]+\.[0-9]{2} USD'; then
      pass "INV-190 live: the page shows the ledger's exact balance string"
    else
      bad "INV-190 live: the page did not report an unavailable balance"
    fi
  fi
else
  echo "  (live checks skipped — API not reachable at $API)"
fi

# ---------------------------------------------------------------------------
# INV-190 / INV-191 — the rendered-output suites.
#
# These render every screen in-process and assert on the result: no dead links,
# no duplicate ids, no unbalanced tags, no undefined CSS token, no unlabelled
# control, no fabricated financial figure, and the dialog rendered hidden.
#
# They exist because a CSS-only defect once shipped past every check in this
# file: `.modal-backdrop { display: grid }` overrode the user-agent
# `[hidden] { display: none }`, so the Open account dialog could not be closed.
# Nothing in the pipeline rendered CSS, so nothing noticed.
# ---------------------------------------------------------------------------
if [ -d apps/web/tests ] && command -v node >/dev/null 2>&1; then
  if (cd apps/web && node --test tests/) >/tmp/projectx-ui-inv.out 2>&1; then
    passed="$(grep -oE 'pass [0-9]+' /tmp/projectx-ui-inv.out | head -1)"
    pass "INV-190/191 rendered-output suites ($passed)"
  else
    bad "INV-190/191 rendered-output suites failed"
    sed 's/^/      /' /tmp/projectx-ui-inv.out | grep -E '^\s+✖|AssertionError' | head -12
  fi
else
  echo "  (rendered-output suites skipped — node unavailable)"
fi

echo
[ "$fail" -eq 0 ] && echo "✓ client area invariants hold" || echo "✗ client area invariants FAILED"
exit $fail

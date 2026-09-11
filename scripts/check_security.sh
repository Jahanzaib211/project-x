#!/usr/bin/env bash
# =============================================================================
# G8 — Security
# =============================================================================
# "Can someone take money, data or availability that is not theirs?"
#
# This gate was declared in gates/gates.yaml from the beginning and had no
# implementation: an empty command list marked "CI only", which means it had
# never once been answered. A blocking gate that runs nothing is worse than no
# gate, because the matrix shows it as required and everyone reads that as done.
#
# The five checks the registry asks for, in order:
#
#   1. authn/authz test matrix
#   2. input fuzzing on every external boundary
#   3. dependency and container image scanning
#   4. secret handling and key rotation tests
#   5. audit log completeness and tamper evidence
#
# Every check here runs against the live edge. Where a tool is unavailable the
# check says so and is skipped rather than silently passing — a skip is visible,
# a silent pass is not.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
skipped=0
pass()  { printf '  ✓ %s\n' "$1"; }
bad()   { printf '  ✗ %s\n' "$1"; fail=1; }
skip()  { printf '  ⋯ %s\n' "$1"; skipped=$((skipped + 1)); }

API="${API:-http://127.0.0.1:27001}"
WEB="${WEB:-http://127.0.0.1:27000}"

echo "security (G8):"

if ! curl -sf --max-time 3 "$API/health" >/dev/null 2>&1; then
  echo "  (skipped — the API is not reachable at $API)"
  exit 0
fi

stamp="$(date +%s%N)"
secret="a-properly-long-password"

# Each gate takes its own sign-in failure budget.
#
# The budget is keyed on the source address, and every gate runs from loopback —
# so without this they share one, and whichever ran first spent it. G8 in
# particular exhausts the budget deliberately, which then failed G4's live
# checks on the next run for reasons that had nothing to do with G4.
#
# The API honours `x-forwarded-for` from a trusted proxy, and loopback is one.
# These are documentation-range addresses (RFC 5737), so they cannot collide
# with anything real.
# One address per concern, and unique per run.
#
# Sharing one meant the fuzzer — which sends ~20 malformed credentials — spent
# the budget the authorization matrix needed, and the spray test spent the one
# the lockout test needed. Each section charges its own, and the run's own
# nanosecond stamp keeps two runs a minute apart from colliding.
octet="$(( (stamp / 1000) % 200 + 20 ))"
GATE_ADDR="198.51.100.$octet"       # the authorization matrix
FUZZ_ADDR="198.51.100.$((octet + 1))"   # malformed input
LOCK_ADDR="198.51.100.$((octet + 2))"   # per-account lockout
THROTTLE_ADDR="198.51.100.$((octet + 3))" # per-address spraying

# Two real accounts to test one against the other.
mk_user() {
  curl -s --max-time 10 -X POST "$API/v1/auth/register" -H 'content-type: application/json' \
    -H "x-forwarded-for: ${2:-$GATE_ADDR}" \
    -d "{\"name\":\"Sec Test\",\"email\":\"$1\",\"password\":\"$secret\",\"acceptedTerms\":true}"
}
tok() { printf '%s' "$1" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }

alice_email="sec-a-$stamp@example.test"
bob_email="sec-b-$stamp@example.test"
alice="$(tok "$(mk_user "$alice_email")")"
bob="$(tok "$(mk_user "$bob_email")")"

if [ -z "$alice" ] || [ -z "$bob" ]; then
  bad "could not establish two sessions — the rest of this gate cannot run"
  echo; echo "✗ security FAILED"; exit 1
fi

# ---------------------------------------------------------------------------
# 1. Authentication and authorisation matrix.
# ---------------------------------------------------------------------------
# Every endpoint that acts on a person's own account, against every caller that
# is not that person. The expectation is uniform: refused, and refused the same
# way whether the target exists or not.
echo "  -- authn/authz matrix --"

code() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local args=(-s -o /dev/null -w '%{http_code}' --max-time 10 -X "$method" "$API$path"
              -H 'content-type: application/json' -H "idempotency-key: sec-$stamp-$RANDOM"
              -H "x-forwarded-for: $GATE_ADDR")
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}"
}

# Endpoints that require a session, called with none.
anon_refused=0
anon_total=0
for spec in \
  "GET:/v1/auth/sessions" \
  "POST:/v1/auth/password" \
  "POST:/v1/auth/sessions/revoke" \
  "POST:/v1/auth/totp/begin" \
  "POST:/v1/auth/totp/confirm" \
  "POST:/v1/auth/totp/disable" \
  "GET:/v1/auth/events" \
  "POST:/v1/auth/email/verify/request"
do
  method="${spec%%:*}"; path="${spec#*:}"
  anon_total=$((anon_total + 1))
  got="$(code "$method" "$path" "" '{}')"
  [ "$got" = "401" ] && anon_refused=$((anon_refused + 1)) || printf '      %s %s -> %s (expected 401)\n' "$method" "$path" "$got"
done
if [ "$anon_refused" = "$anon_total" ]; then
  pass "every session-only endpoint refuses an anonymous caller ($anon_total/$anon_total)"
else
  bad "$((anon_total - anon_refused)) of $anon_total session-only endpoints answered without a session"
fi

# A forged bearer token is not a session.
forged=0
for token in "not-a-token" "$(printf 'A%.0s' {1..64})" "null" "undefined" "Bearer" "../../etc/passwd"; do
  got="$(code GET /v1/auth/sessions "$token")"
  [ "$got" = "401" ] || { forged=$((forged + 1)); printf '      forged %.12s -> %s\n' "$token" "$got"; }
done
if [ "$forged" -eq 0 ]; then
  pass "a forged or malformed bearer token is refused"
else
  bad "$forged forged token(s) were not refused"
fi

# Alice's session must not act on Bob's things.
bob_session="$(curl -s --max-time 10 -H "authorization: Bearer $bob" "$API/v1/auth/sessions" \
  | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p' | head -1)"
if [ -n "$bob_session" ]; then
  got="$(code POST /v1/auth/sessions/revoke "$alice" "{\"sessionId\":\"$bob_session\"}")"
  if [ "$got" = "404" ]; then
    # 404, not 403: confirming the id exists would be a disclosure in itself.
    pass "one session cannot revoke another account's session"
  else
    bad "revoking another account's session returned $got (expected 404)"
  fi
  # And Bob is still signed in.
  still="$(curl -s --max-time 10 -H "authorization: Bearer $bob" "$API/v1/auth/session")"
  if printf '%s' "$still" | grep -q '"authenticated":true'; then
    pass "the other account's session survived the attempt"
  else
    bad "another account's session was revoked by someone who does not own it"
  fi
else
  bad "could not read a session id to test cross-account revocation"
fi

# Changing a password requires the current one, not merely a session.
got="$(code POST /v1/auth/password "$alice" '{"currentPassword":"wrong-password","newPassword":"a-new-long-password"}')"
if [ "$got" = "403" ]; then
  pass "a borrowed session cannot change a password without the current one"
else
  bad "password change without the current password returned $got (expected 403)"
fi

# Turning off the second factor likewise.
got="$(code POST /v1/auth/totp/disable "$alice" '{"password":"wrong-password"}')"
if [ "$got" = "403" ]; then
  pass "a borrowed session cannot remove the second factor without the password"
else
  bad "two-factor disable without the password returned $got (expected 403)"
fi

# ---------------------------------------------------------------------------
# 2. Input fuzzing on every external boundary.
# ---------------------------------------------------------------------------
# The bar is not "rejects bad input" — it is **never answers 5xx**. A 500 is the
# service saying it did not anticipate this, which is where the interesting bugs
# live. Anything in 4xx is a considered refusal and is fine.
echo "  -- input fuzzing --"

crashes=0
attempts=0
fuzz_one() {
  local method="$1" path="$2" body="$3"
  attempts=$((attempts + 1))
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X "$method" "$API$path" \
    -H 'content-type: application/json' -H "idempotency-key: fuzz-$stamp-$RANDOM" \
    -H "authorization: Bearer $alice" -H "x-forwarded-for: $FUZZ_ADDR" -d "$body")"
  case "$got" in
    5*) crashes=$((crashes + 1)); printf '      %s %s <- %.40s -> %s\n' "$method" "$path" "$body" "$got" ;;
    000) crashes=$((crashes + 1)); printf '      %s %s <- %.40s -> no response (connection dropped)\n' "$method" "$path" "$body" ;;
  esac
}

# Shapes that break naive parsers: wrong types, nulls, deep nesting, huge
# numbers, unicode, injection payloads, prototype pollution.
payloads=(
  '{}'
  '[]'
  'null'
  '"a string"'
  '{"email":null,"password":null}'
  '{"email":{"$ne":null},"password":{"$ne":null}}'
  '{"email":["array"],"password":123}'
  '{"email":"a@b.co","password":true}'
  '{"__proto__":{"admin":true}}'
  '{"constructor":{"prototype":{"admin":true}}}'
  '{"email":"a@b.co'"'"' OR 1=1--","password":"x"}'
  '{"email":"<script>alert(1)</script>@b.co","password":"x"}'
  '{"name":"../../../../etc/passwd","email":"a@b.co","password":"aaaaaaaaaa","acceptedTerms":true}'
  '{"amount":1e309,"method":"card"}'
  '{"amount":-0,"method":"card"}'
  '{"volume":"NaN","symbol":"EURUSD","side":"BUY","account":"50000001"}'
  '{"symbol":"../../admin","side":"BUY","volume":"1","account":"50000001"}'
  '{"token":"'"$(printf 'x%.0s' {1..2000})"'","newPassword":"aaaaaaaaaa"}'
  '{"sessionId":"; DROP TABLE app.sessions; --"}'
  '{"code":"000000000000000000000"}'
  '{"nested":{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":{"j":1}}}}}}}}}}}'
)

for body in "${payloads[@]}"; do
  fuzz_one POST /v1/auth/login "$body"
  fuzz_one POST /v1/auth/register "$body"
  fuzz_one POST /v1/auth/password/forgot "$body"
  fuzz_one POST /v1/auth/password/reset "$body"
  fuzz_one POST /v1/auth/sessions/revoke "$body"
  fuzz_one POST /v1/orders "$body"
  fuzz_one POST /v1/funding/deposit "$body"
  fuzz_one POST /v1/accounts "$body"
done

# Malformed bodies that are not JSON at all.
for raw in 'not json' '{' '{"a":' $'\x00\x01\x02' '%%%%' '<xml/>'; do
  attempts=$((attempts + 1))
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$API/v1/auth/login" \
    -H 'content-type: application/json' -H "x-forwarded-for: $FUZZ_ADDR" --data-binary "$raw")"
  case "$got" in 5*|000) crashes=$((crashes + 1)); printf '      raw %.20s -> %s\n' "$raw" "$got" ;; esac
done

# Query-string boundaries.
for q in "symbol=$(printf 'A%.0s' {1..500})" "symbol=../../etc" "interval=%00" "limit=-1" "limit=1e99" "account=abc"; do
  attempts=$((attempts + 1))
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API/v1/candles?$q")"
  case "$got" in 5*|000) crashes=$((crashes + 1)); printf '      query %s -> %s\n' "$q" "$got" ;; esac
done

if [ "$crashes" -eq 0 ]; then
  pass "no 5xx from $attempts malformed requests across every boundary"
else
  bad "$crashes of $attempts malformed requests produced a 5xx or dropped the connection"
fi

# An oversized body is refused, not buffered into memory.
# Written to a file and streamed: passing 200KB as an argv element is what the
# shell refuses, not what the server refuses.
big_body="$(mktemp)"
{ printf '{"email":"'; head -c 200000 /dev/zero | tr '\0' 'a'; printf '","password":"x"}'; } > "$big_body"
got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$API/v1/auth/login" \
  -H 'content-type: application/json' -H "x-forwarded-for: $FUZZ_ADDR" --data-binary "@$big_body")"
rm -f "$big_body"
if [ "$got" = "413" ] || [ "$got" = "400" ]; then
  pass "an oversized request body is refused ($got)"
else
  bad "a 200KB body returned $got — the edge may be buffering unbounded input"
fi

# ---------------------------------------------------------------------------
# 3. Dependency and container image scanning.
# ---------------------------------------------------------------------------
echo "  -- dependency and image scanning --"

if command -v npm >/dev/null 2>&1; then
  audit_fail=0
  for pkg in services/client-api apps/web; do
    # High and critical only. A gate that blocks on every low advisory in a
    # transitive dev dependency is a gate that gets bypassed within a month.
    out="$(cd "$pkg" && npm audit --audit-level=high --omit=dev 2>&1)"
    if printf '%s' "$out" | grep -qE '[0-9]+ (high|critical)'; then
      bad "npm advisories (high or critical) in $pkg"
      printf '%s\n' "$out" | grep -E 'high|critical' | head -3 | sed 's/^/      /'
      audit_fail=1
    fi
  done
  [ "$audit_fail" -eq 0 ] && pass "no high or critical npm advisories in runtime dependencies"
else
  skip "npm not available — dependency advisories unchecked"
fi

if command -v cargo >/dev/null 2>&1 && cargo audit --version >/dev/null 2>&1; then
  if cargo audit --quiet >/dev/null 2>&1; then
    pass "no known advisories in the Rust dependency tree"
  else
    bad "cargo audit reported advisories"
  fi
else
  skip "cargo-audit not installed — Rust advisories unchecked (cargo install cargo-audit)"
fi

if command -v trivy >/dev/null 2>&1; then
  images="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^projectx' | head -6)"
  if [ -z "$images" ]; then
    skip "no projectx images built — image scanning has nothing to scan (make build)"
  else
    image_fail=0
    for image in $images; do
      out="$(trivy image --quiet --scanners vuln --severity HIGH,CRITICAL --exit-code 1 "$image" 2>&1)"
      if [ $? -ne 0 ]; then
        bad "HIGH/CRITICAL vulnerabilities in $image"
        printf '%s\n' "$out" | grep -E 'HIGH|CRITICAL' | head -3 | sed 's/^/      /'
        image_fail=1
      fi
    done
    [ "$image_fail" -eq 0 ] && pass "no HIGH/CRITICAL vulnerabilities in the built images"
  fi
else
  skip "trivy not available — container images unscanned"
fi

# ---------------------------------------------------------------------------
# 4. Secret handling and key rotation.
# ---------------------------------------------------------------------------
echo "  -- secrets and rotation --"

# No credential material may appear in a response, ever.
leaked=0
for probe in \
  "$API/v1/auth/session|$alice" \
  "$API/v1/profile|$alice" \
  "$API/v1/auth/sessions|$alice" \
  "$API/v1/auth/events|$alice"
do
  url="${probe%%|*}"; token="${probe#*|}"
  body="$(curl -s --max-time 10 -H "authorization: Bearer $token" "$url")"
  if printf '%s' "$body" | grep -qiE '"(password|password_hash|passwordHash|token_digest|totp_secret|totpSecret)"|scrypt\$'; then
    bad "credential material in the response from $url"
    leaked=1
  fi
done
[ "$leaked" -eq 0 ] && pass "no endpoint returns credential material"

# Rotation: changing a password must reissue this session's own token, or the
# credential that existed before the change still works after it.
rot_email="sec-rot-$stamp@example.test"
rot="$(tok "$(mk_user "$rot_email")")"
rotated="$(curl -s --max-time 15 -X POST "$API/v1/auth/password" -H 'content-type: application/json' \
  -H "authorization: Bearer $rot" -H "x-forwarded-for: $GATE_ADDR" \
  -d "{\"currentPassword\":\"$secret\",\"newPassword\":\"a-rotated-password-1\"}")"
new_token="$(tok "$rotated")"
if [ -n "$new_token" ] && [ "$new_token" != "$rot" ]; then
  old_state="$(curl -s --max-time 10 -H "authorization: Bearer $rot" "$API/v1/auth/session")"
  if printf '%s' "$old_state" | grep -q '"authenticated":false'; then
    pass "changing a password reissues the session token and retires the old one"
  else
    bad "the pre-change session token still authenticates"
  fi
else
  bad "changing a password did not reissue the session token"
fi

# A reset token is single-use.
curl -s --max-time 10 -o /dev/null -X POST "$API/v1/auth/password/forgot" \
  -H 'content-type: application/json' -H "x-forwarded-for: $GATE_ADDR" \
  -d "{\"email\":\"$alice_email\"}"
# The token, from wherever this deployment actually puts it. The outbox is the
# development path; a mail sink is the one that exists once delivery is on.
# Neither is assumed — a gate that only works in one configuration is a gate
# that stops running the moment the configuration changes.
reset_token="$(curl -s --max-time 10 "$API/v1/auth/outbox?to=$alice_email" 2>/dev/null \
  | grep -o 'reset-password?token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)"

if [ -z "$reset_token" ] && curl -sf --max-time 3 "${MAILPIT_URL:-http://127.0.0.1:27020}/api/v1/info" >/dev/null 2>&1; then
  for _ in 1 2 3 4 5 6 7 8; do
    reset_token="$(curl -s --max-time 10 "${MAILPIT_URL:-http://127.0.0.1:27020}/api/v1/search?query=$alice_email" 2>/dev/null \
      | grep -o 'reset-password?token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)"
    [ -n "$reset_token" ] && break
    curl -s -o /dev/null --max-time 6 "$API/health" || true
  done
fi

if [ -z "$reset_token" ]; then
  skip "no reset token retrievable (outbox closed and no mail sink) — single-use unverified"
elif [ -n "$reset_token" ]; then
  first="$(code POST /v1/auth/password/reset "" "{\"token\":\"$reset_token\",\"newPassword\":\"a-reset-password-1\"}")"
  second="$(code POST /v1/auth/password/reset "" "{\"token\":\"$reset_token\",\"newPassword\":\"a-reset-password-2\"}")"
  if [ "$first" = "200" ] && [ "$second" = "400" ]; then
    pass "a reset token is spent by its first use"
  else
    bad "reset token reuse returned $first then $second (expected 200 then 400)"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Audit log completeness and tamper evidence.
# ---------------------------------------------------------------------------
echo "  -- audit log --"

aud_email="sec-aud-$stamp@example.test"
aud="$(tok "$(mk_user "$aud_email")")"
# Do things that must be recorded.
curl -s --max-time 10 -o /dev/null -X POST "$API/v1/auth/login" -H 'content-type: application/json' \
  -H "x-forwarded-for: $GATE_ADDR" \
  -d "{\"email\":\"$aud_email\",\"password\":\"wrong-on-purpose\"}"
# The change rotates this session's token, so the read that follows has to use
# the new one. Using the old one here previously reported the audit log as empty
# when it was the request that had been refused.
aud_rotated="$(tok "$(curl -s --max-time 15 -X POST "$API/v1/auth/password" \
  -H 'content-type: application/json' -H "authorization: Bearer $aud" \
  -H "x-forwarded-for: $GATE_ADDR" \
  -d "{\"currentPassword\":\"$secret\",\"newPassword\":\"an-audited-password-1\"}")")"
[ -n "$aud_rotated" ] && aud="$aud_rotated"

events="$(curl -s --max-time 10 -H "authorization: Bearer $aud" "$API/v1/auth/events?limit=50")"
missing=""
for event in registered sign_in_failed password_changed email_verification_requested; do
  printf '%s' "$events" | grep -q "\"$event\"" || missing="$missing $event"
done
if [ -z "$missing" ]; then
  pass "every security-relevant action is recorded"
else
  bad "the audit log is missing:$missing"
fi

# Tamper evidence: the serving roles may append and read, never rewrite history.
if command -v docker >/dev/null 2>&1 && docker exec projectx-postgres pg_isready -U projectx >/dev/null 2>&1; then
  writable="$(docker exec projectx-postgres psql -U projectx -d projectx -tAq -c \
    "SELECT count(*) FROM information_schema.role_table_grants
      WHERE table_schema='app' AND table_name='security_events'
        AND grantee IN ('projectx_app','projectx_auth')
        AND privilege_type IN ('UPDATE','DELETE')" 2>/dev/null | tr -d '[:space:]')"
  if [ "$writable" = "0" ]; then
    pass "the audit log is append-only to every serving role"
  else
    bad "a serving role can UPDATE or DELETE audit rows — history is rewritable"
  fi

  # And an attempt actually fails, rather than merely lacking a grant on paper.
  denied="$(docker exec -i -e PGPASSWORD="${DB_APP_PASSWORD:-dev_only_app_role}" projectx-postgres \
    psql -U projectx_app -d projectx -tAq -c "DELETE FROM app.security_events;" 2>&1)"
  if printf '%s' "$denied" | grep -q 'permission denied'; then
    pass "deleting audit history is refused by the database"
  else
    bad "the audit log could be deleted by the request role"
  fi
else
  skip "postgres not reachable — audit tamper evidence unchecked"
fi

# The audit log must never carry the thing it describes.
if printf '%s' "$events" | grep -qiE 'scrypt\$|password_hash|token_digest|[A-Z2-7]{32}'; then
  bad "the audit log carries credential material"
else
  pass "the audit log carries no credential material"
fi

# ---------------------------------------------------------------------------
# 6. Throttling. Deliberately last.
# ---------------------------------------------------------------------------
# These checks exhaust the per-address sign-in budget on purpose, so anything
# after them would be answered with a 429 regardless of whether it was correct.
# An earlier draft had them in the middle and failed six unrelated checks.
echo "  -- throttling --"

# The per-account lockout, first: it needs its five attempts to be answered
# as credential rejections, and the per-address test below spends the budget
# that would otherwise turn them into 429s.
lock_email="sec-lock-$stamp@example.test"
mk_user "$lock_email" >/dev/null
locked=""
for i in 1 2 3 4 5 6; do
  locked="$(curl -s --max-time 10 -X POST "$API/v1/auth/login" -H 'content-type: application/json' \
    -H "x-forwarded-for: $LOCK_ADDR" \
    -d "{\"email\":\"$lock_email\",\"password\":\"wrong-$i\"}")"
  printf '%s' "$locked" | grep -qi 'too many failed' && break
done
if printf '%s' "$locked" | grep -qi 'too many failed'; then
  pass "a single account locks out after repeated failures"
else
  bad "an account did not lock out after six failed sign-ins"
fi

# The per-address budget, which exists for a different attack than the lockout.
#
# A lockout stops somebody grinding one account. It does nothing against
# somebody trying one likely password across thousands of accounts — each
# account sees a single failure and never locks. That is what this budget is
# for, so this tests it the way the attack works: one guess each, across many
# distinct addresses, so the per-account lockout never fires and the only thing
# that can stop it is the per-address count.
sprayed=0
for i in $(seq 1 45); do
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$API/v1/auth/login" \
    -H 'content-type: application/json' -H "x-forwarded-for: $THROTTLE_ADDR" \
    -d "{\"email\":\"spray-$stamp-$i@example.test\",\"password\":\"one-common-password\"}")"
  if [ "$got" = "429" ]; then sprayed=$i; break; fi
done
if [ "$sprayed" -gt 0 ]; then
  pass "spraying one password across many accounts is throttled (stopped at attempt $sprayed)"
else
  bad "45 accounts were sprayed from one address without being throttled"
fi

# And the budget must not be escapable by claiming to be somebody else.
#
# This is the attack, run as the attacker would run it: spray through the public
# surface, sending a **different forged `x-forwarded-for` on every request**.
#
# If the header were believed from the client, each request would open a fresh
# budget and none would ever be throttled — the limiter would be present,
# running, and counting to one forever. The web app replaces the header with the
# socket address it actually saw, so every one of these lands on the same
# budget and the throttle bites.
#
# Runs last in the gate for the same reason as everything in this section: it
# spends loopback's budget on purpose.
if curl -sf --max-time 3 "$WEB/api/health" >/dev/null 2>&1; then
  evaded=1
  for i in $(seq 1 45); do
    got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$WEB/api/v1/auth/login" \
      -H 'content-type: application/json' \
      -H "x-forwarded-for: 203.0.113.$((i % 250 + 1))" \
      -d "{\"email\":\"evade-$stamp-$i@example.test\",\"password\":\"one-common-password\"}")"
    if [ "$got" = "429" ]; then evaded=0; break; fi
  done
  if [ "$evaded" -eq 0 ]; then
    pass "rotating a forged x-forwarded-for does not escape the sign-in limit"
  else
    bad "45 guesses with a rotating forged x-forwarded-for were never throttled"
  fi

  # The mechanism behind it: the proxy replaces the header rather than passing
  # on what the client claimed. Appending would leave the client's value
  # left-most, which is the one that gets read.
  if grep -q 'headers\["x-forwarded-for"\] = remote' apps/web/src/server.js; then
    pass "the web proxy replaces x-forwarded-for rather than trusting the client's"
  else
    bad "the web proxy may be forwarding a client-supplied x-forwarded-for"
  fi
else
  skip "the web app is not reachable — forwarded-header spoofing unchecked"
fi

# The API must not believe the header from just anyone either.
if grep -q 'TRUSTED_PROXIES.has(peer)' services/client-api/src/server.js; then
  pass "the API honours x-forwarded-for only from a trusted proxy"
else
  bad "the API believes x-forwarded-for from any caller"
fi

echo
if [ "$fail" -eq 0 ]; then
  [ "$skipped" -gt 0 ] && echo "✓ security holds ($skipped check(s) skipped — tooling unavailable)" \
                       || echo "✓ security holds"
else
  echo "✗ security FAILED"
fi
exit $fail

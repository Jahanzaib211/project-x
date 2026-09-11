#!/usr/bin/env bash
# =============================================================================
# G4/G8 — client isolation, proved against the database itself
# =============================================================================
# INV-188. One client's rows are unreachable to another, and the thing enforcing
# that is Postgres, not the application.
#
# Why this exists as its own script, driving psql rather than the API:
#
# Testing isolation through the API proves the API's WHERE clauses are correct
# today. It cannot prove the property survives the next handler somebody writes.
# These checks connect **as the application's own database role**, issue the
# statements a buggy handler would issue, and assert the database refuses them.
#
# The load-bearing case is the first one: a SELECT with no scope set and no
# WHERE clause returns **zero rows**. Fail-closed, not fail-open. Every other
# check here follows from that one being true.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
pass() { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; fail=1; }

CONTAINER="${POSTGRES_CONTAINER:-projectx-postgres}"
DB="${POSTGRES_DB:-projectx}"
ADMIN="${POSTGRES_USER:-projectx}"
APP_PASSWORD="${DB_APP_PASSWORD:-dev_only_app_role}"
AUTH_PASSWORD="${DB_AUTH_PASSWORD:-dev_only_auth_role}"

echo "client isolation (INV-188):"

if ! docker exec "$CONTAINER" pg_isready -U "$ADMIN" -d "$DB" >/dev/null 2>&1; then
  echo "  (skipped — $CONTAINER is not reachable)"
  exit 0
fi

# Run a statement as one of the least-privilege serving roles.
as_role() {
  local role="$1" password="$2"
  docker exec -i -e PGPASSWORD="$password" "$CONTAINER" \
    psql -U "$role" -d "$DB" -tAq -v ON_ERROR_STOP=0 -f - 2>&1
}
as_admin() {
  docker exec -i "$CONTAINER" psql -U "$ADMIN" -d "$DB" -tAq -v ON_ERROR_STOP=0 -f - 2>&1
}

# ---------------------------------------------------------------------------
# The roles themselves. Every policy below is decoration if these are wrong:
# a superuser, or a role with BYPASSRLS, ignores row-level security in silence.
# ---------------------------------------------------------------------------
roles="$(printf "SELECT rolname||':'||rolsuper::text||':'||rolbypassrls::text FROM pg_roles WHERE rolname IN ('projectx_app','projectx_auth') ORDER BY rolname;" | as_admin)"

if [ "$(printf '%s\n' "$roles" | grep -c .)" -eq 2 ]; then
  pass "both serving roles exist"
else
  bad "a serving role is missing (found: ${roles:-none})"
fi

if printf '%s\n' "$roles" | grep -q ':t:'; then
  bad "a serving role is a superuser or can bypass RLS — every policy below is inert"
else
  pass "neither serving role is a superuser or may bypass RLS"
fi

# ---------------------------------------------------------------------------
# Every table in `app` is protected, and FORCE is set so the owning role is
# subject to its own policies too.
# ---------------------------------------------------------------------------
unprotected="$(printf "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);" | as_admin | grep -c . )"
if [ "$unprotected" -eq 0 ]; then
  pass "every table in app has row-level security, forced"
else
  bad "$unprotected table(s) in app are not protected by forced row-level security"
fi

# ---------------------------------------------------------------------------
# Two owners, created directly so this script depends on no running service.
# ---------------------------------------------------------------------------
stamp="$(date +%s%N)"
alice="00000000-0000-4000-8000-$(printf '%012d' "$((stamp % 1000000000000))")"
bob="00000000-0000-4000-8001-$(printf '%012d' "$((stamp % 1000000000000))")"

setup="$(cat <<SQL
INSERT INTO app.users (user_id, email, password_hash, name)
VALUES ('$alice', 'iso-alice-$stamp@example.test', 'scrypt\$16384\$8\$1\$aaaa\$bbbb', 'Iso Alice'),
       ('$bob',   'iso-bob-$stamp@example.test',   'scrypt\$16384\$8\$1\$aaaa\$bbbb', 'Iso Bob');
INSERT INTO app.accounts (account_number, owner_id, platform, account_type, mode, nickname, currency, leverage)
VALUES (nextval('app.account_number_seq'), '$alice', 'MT5', 'Standard', 'demo', 'ISO-ALICE-$stamp', 'USD', 200),
       (nextval('app.account_number_seq'), '$bob',   'MT5', 'Standard', 'demo', 'ISO-BOB-$stamp',   'USD', 200);
SQL
)"
printf '%s\n' "$setup" | as_admin >/dev/null

cleanup() {
  printf "DELETE FROM app.users WHERE user_id IN ('%s','%s');\n" "$alice" "$bob" | as_admin >/dev/null 2>&1
  printf "DELETE FROM app.accounts WHERE owner_id IN ('%s','%s');\n" "$alice" "$bob" | as_admin >/dev/null 2>&1
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. The one that matters: unscoped reads nothing.
# ---------------------------------------------------------------------------
# A handler that forgets `asOwner`, or forgets its WHERE clause, must come back
# empty-handed rather than with the whole table.
n="$(printf 'SELECT count(*) FROM app.accounts;\n' | as_role projectx_app "$APP_PASSWORD" | tr -d '[:space:]')"
if [ "$n" = "0" ]; then
  pass "INV-188 an unscoped SELECT returns no rows (fail closed)"
else
  bad "INV-188 an unscoped SELECT returned $n row(s) — isolation is not being enforced"
fi

# ---------------------------------------------------------------------------
# 2. Scoped, each owner sees exactly their own.
# ---------------------------------------------------------------------------
a_rows="$(printf "BEGIN; SELECT set_config('app.current_user_id','$alice',true); SELECT count(*) FROM app.accounts; COMMIT;\n" | as_role projectx_app "$APP_PASSWORD" | sed -n '2p' | tr -d '[:space:]')"
b_rows="$(printf "BEGIN; SELECT set_config('app.current_user_id','$bob',true); SELECT count(*) FROM app.accounts; COMMIT;\n" | as_role projectx_app "$APP_PASSWORD" | sed -n '2p' | tr -d '[:space:]')"
if [ "$a_rows" = "1" ] && [ "$b_rows" = "1" ]; then
  pass "INV-188 each owner sees exactly their own rows"
else
  bad "INV-188 scoped reads returned alice=$a_rows bob=$b_rows, expected 1 and 1"
fi

# ---------------------------------------------------------------------------
# 3. Asking for the other client's row by name returns nothing.
# ---------------------------------------------------------------------------
leak="$(printf "BEGIN; SELECT set_config('app.current_user_id','$alice',true); SELECT count(*) FROM app.accounts WHERE nickname='ISO-BOB-$stamp'; COMMIT;\n" | as_role projectx_app "$APP_PASSWORD" | sed -n '2p' | tr -d '[:space:]')"
if [ "$leak" = "0" ]; then
  pass "INV-188 naming another client's row directly returns nothing"
else
  bad "INV-188 one client read another's row by name"
fi

# ---------------------------------------------------------------------------
# 4. Writing into another client's data is refused, not merely hidden.
# ---------------------------------------------------------------------------
# WITH CHECK. Without it a client could insert rows they could not then see —
# which is worse than a read leak, because nothing would ever surface it.
write="$(printf "BEGIN; SELECT set_config('app.current_user_id','$alice',true); INSERT INTO app.accounts (account_number, owner_id, platform, account_type, mode, nickname, currency, leverage) VALUES (nextval('app.account_number_seq'), '$bob', 'MT5','Standard','demo','PLANTED-$stamp','USD',200); COMMIT;\n" | as_role projectx_app "$APP_PASSWORD")"
if printf '%s' "$write" | grep -q 'violates row-level security'; then
  pass "INV-188 writing a row owned by another client is refused"
else
  bad "INV-188 a client inserted a row owned by somebody else"
fi

# Likewise an UPDATE that tries to hand a row to somebody else.
steal="$(printf "BEGIN; SELECT set_config('app.current_user_id','$alice',true); UPDATE app.accounts SET owner_id='$bob' WHERE nickname='ISO-ALICE-$stamp'; COMMIT;\n" | as_role projectx_app "$APP_PASSWORD")"
if printf '%s' "$steal" | grep -q 'violates row-level security'; then
  pass "INV-188 reassigning a row to another client is refused"
else
  bad "INV-188 a client reassigned one of its rows to somebody else"
fi

# ---------------------------------------------------------------------------
# 5. The credential role cannot reach client data at all.
# ---------------------------------------------------------------------------
# Confined by the absence of a grant rather than by a predicate: signing in
# cannot read a trading account, whatever the query says.
denied="$(printf 'SELECT count(*) FROM app.accounts;\n' | as_role projectx_auth "$AUTH_PASSWORD")"
if printf '%s' "$denied" | grep -q 'permission denied'; then
  pass "INV-188 the credential role has no access to client accounts"
else
  bad "INV-188 the credential role can read app.accounts"
fi

# And the serving role cannot create or delete identities.
for privilege in INSERT DELETE; do
  granted="$(printf "SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='app' AND table_name='users' AND grantee='projectx_app' AND privilege_type='%s';\n" "$privilege" | as_admin | tr -d '[:space:]')"
  if [ "$granted" = "0" ]; then
    pass "INV-188 the request role may not $privilege an identity"
  else
    bad "INV-188 the request role holds $privilege on app.users"
  fi
done

# ---------------------------------------------------------------------------
# 6. The scope does not survive its transaction.
# ---------------------------------------------------------------------------
# set_config(..., true) is transaction-local. If it were not, a pooled
# connection would carry one client's identity into the next client's request —
# the standard way an RLS deployment becomes a cross-tenant leak.
after="$(printf "BEGIN; SELECT set_config('app.current_user_id','$alice',true); COMMIT; SELECT count(*) FROM app.accounts;\n" | as_role projectx_app "$APP_PASSWORD" | tail -1 | tr -d '[:space:]')"
if [ "$after" = "0" ]; then
  pass "INV-188 the scope does not outlive its transaction"
else
  bad "INV-188 a scope set in one transaction leaked into the next ($after row(s))"
fi

echo
[ "$fail" -eq 0 ] && echo "✓ client isolation holds" || echo "✗ client isolation FAILED"
exit $fail

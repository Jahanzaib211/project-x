#!/usr/bin/env bash
# =============================================================================
# G5 — prove the database actually enforces the ledger invariants.
# =============================================================================
# The application enforces INV-020 in code. The database enforces it again with
# constraints and triggers. Stating a law in two independent places is how you
# find out when one of them is wrong — but only if you test the second one.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PSQL=(docker compose exec -T postgres psql -U "${POSTGRES_USER:-projectx}" -d "${POSTGRES_DB:-projectx}" -v ON_ERROR_STOP=1 -q)
fail=0

expect_rejected() {
  local label="$1" sql="$2"
  if echo "$sql" | "${PSQL[@]}" >/dev/null 2>&1; then
    echo "  ✗ $label — the database ACCEPTED what it must reject"
    fail=1
  else
    echo "  ✓ $label — rejected, as required"
  fi
}

expect_accepted() {
  local label="$1" sql="$2"
  if echo "$sql" | "${PSQL[@]}" >/dev/null 2>&1; then
    echo "  ✓ $label"
  else
    echo "  ✗ $label — the database rejected something valid"
    fail=1
  fi
}

echo "verifying ledger constraints:"

echo "  setting up fixtures..."
"${PSQL[@]}" >/dev/null 2>&1 <<'SQL'
INSERT INTO ledger.accounts (account_id, kind, currency) VALUES
  ('test-client-1', 'client', 'USD'),
  ('test-house-1',  'house',  'USD')
ON CONFLICT (account_id) DO NOTHING;
INSERT INTO events.event_log
  (event_id, event_type, aggregate_type, aggregate_id, sequence, correlation_id, schema_version, payload)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'test.seed', 'test', 'test-agg', 1,
   '22222222-2222-2222-2222-222222222222', 1, '{}'::jsonb)
ON CONFLICT (event_id) DO NOTHING;
SQL

# INV-020 / INV-021 — debits must equal credits.
expect_rejected "INV-020 unbalanced transaction" "
BEGIN;
INSERT INTO ledger.transactions (transaction_id, event_id, kind, description)
VALUES ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111', 'test', 'unbalanced');
INSERT INTO ledger.entries (transaction_id, account_id, currency, amount_minor, scale)
VALUES ('33333333-3333-3333-3333-333333333333', 'test-client-1', 'USD', 100, 2);
COMMIT;"

expect_accepted "INV-020 balanced transaction" "
BEGIN;
INSERT INTO ledger.transactions (transaction_id, event_id, kind, description)
VALUES ('44444444-4444-4444-4444-444444444444',
        '11111111-1111-1111-1111-111111111111', 'test', 'balanced');
INSERT INTO ledger.entries (transaction_id, account_id, currency, amount_minor, scale)
VALUES ('44444444-4444-4444-4444-444444444444', 'test-client-1', 'USD',  100, 2),
       ('44444444-4444-4444-4444-444444444444', 'test-house-1',  'USD', -100, 2);
COMMIT;"

# INV-021 — balanced overall but not per currency must still be rejected.
expect_rejected "INV-021 cross-currency false balance" "
BEGIN;
INSERT INTO ledger.transactions (transaction_id, event_id, kind, description)
VALUES ('55555555-5555-5555-5555-555555555555',
        '11111111-1111-1111-1111-111111111111', 'test', 'currency-crossed');
INSERT INTO ledger.entries (transaction_id, account_id, currency, amount_minor, scale)
VALUES ('55555555-5555-5555-5555-555555555555', 'test-client-1', 'USD',  100, 2),
       ('55555555-5555-5555-5555-555555555555', 'test-house-1',  'EUR', -100, 2);
COMMIT;"

# INV-012 — the event log is append-only.
expect_rejected "INV-012 event log update" "
UPDATE events.event_log SET event_type = 'tampered'
WHERE event_id = '11111111-1111-1111-1111-111111111111';"

expect_rejected "INV-012 event log delete" "
DELETE FROM events.event_log
WHERE event_id = '11111111-1111-1111-1111-111111111111';"

# INV-022 — journal entries are immutable.
expect_rejected "INV-022 entry mutation" "
UPDATE ledger.entries SET amount_minor = amount_minor * 2
WHERE transaction_id = '44444444-4444-4444-4444-444444444444';"

# INV-010 — duplicate event_id cannot be appended twice.
expect_rejected "INV-010 duplicate event id" "
INSERT INTO events.event_log
  (event_id, event_type, aggregate_type, aggregate_id, sequence, correlation_id, schema_version, payload)
VALUES ('11111111-1111-1111-1111-111111111111', 'test.dup', 'test', 'test-agg', 2,
        '22222222-2222-2222-2222-222222222222', 1, '{}'::jsonb);"

# INV-011 — a duplicate sequence on one aggregate cannot exist.
expect_rejected "INV-011 duplicate aggregate sequence" "
INSERT INTO events.event_log
  (event_id, event_type, aggregate_type, aggregate_id, sequence, correlation_id, schema_version, payload)
VALUES ('66666666-6666-6666-6666-666666666666', 'test.dup-seq', 'test', 'test-agg', 1,
        '22222222-2222-2222-2222-222222222222', 1, '{}'::jsonb);"

# INV-020 monitor — the imbalance view must be empty.
echo "  checking the invariant monitor..."
imbalances="$("${PSQL[@]}" -t -c 'SELECT count(*) FROM ledger.imbalances;' 2>/dev/null | tr -d '[:space:]')"
if [ "$imbalances" = "0" ]; then
  echo "  ✓ INV-020 monitor reports zero imbalances"
else
  echo "  ✗ INV-020 monitor reports $imbalances imbalance(s) — money is wrong"
  fail=1
fi

echo
[ "$fail" -eq 0 ] && echo "✓ the database enforces the ledger invariants" \
                  || echo "✗ ledger constraint verification FAILED"
exit $fail

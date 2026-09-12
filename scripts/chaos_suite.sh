#!/usr/bin/env bash
# =============================================================================
# G7 — fault and chaos
# =============================================================================
# The rule that makes this meaningful: after EVERY injected fault, the
# invariants must still hold AND replay equivalence must still hold. A chaos
# suite that only checks "did it come back up" is reassurance, not proof.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
echo "chaos suite:"

snapshot_ledger() {
  docker compose exec -T postgres psql -U "${POSTGRES_USER:-projectx}" \
    -d "${POSTGRES_DB:-projectx}" -t -A -F',' \
    -c 'SELECT account_id, currency, balance_minor FROM ledger.balances ORDER BY account_id, currency;' 2>/dev/null
}

count_imbalances() {
  docker compose exec -T postgres psql -U "${POSTGRES_USER:-projectx}" \
    -d "${POSTGRES_DB:-projectx}" -t -A \
    -c 'SELECT count(*) FROM ledger.imbalances;' 2>/dev/null | tr -d '[:space:]'
}

# ---------------------------------------------------------------------------
# INV-024 — the ledger after crash recovery is identical to before the crash.
# ---------------------------------------------------------------------------
echo "  [1/4] kill -9 the database mid-flight, restart, compare the ledger"
before="$(snapshot_ledger)"
if [ -z "$before" ]; then
  echo "      SKIPPED — infrastructure is not running (make up-infra)"
else
  docker compose kill -s SIGKILL postgres >/dev/null 2>&1
  docker compose up -d postgres >/dev/null 2>&1
  for _ in $(seq 1 60); do
    docker compose exec -T postgres pg_isready -q >/dev/null 2>&1 && break
    sleep 2
  done
  after="$(snapshot_ledger)"
  if [ "$before" = "$after" ]; then
    echo "      ✓ INV-024 ledger identical after recovery"
  else
    echo "      ✗ INV-024 VIOLATED — the ledger changed across a crash"
    diff <(echo "$before") <(echo "$after") | sed 's/^/        /'
    fail=1
  fi
fi

# ---------------------------------------------------------------------------
# INV-020 must hold after the fault, not merely before it.
# ---------------------------------------------------------------------------
echo "  [2/4] invariants after the fault"
imbalances="$(count_imbalances)"
if [ "${imbalances:-0}" = "0" ]; then
  echo "      ✓ INV-020 debits == credits after recovery"
else
  echo "      ✗ INV-020 VIOLATED — $imbalances unbalanced transaction(s) after recovery"
  fail=1
fi

# ---------------------------------------------------------------------------
# INV-014 / INV-104 — replay equivalence must survive the fault.
# ---------------------------------------------------------------------------
echo "  [3/4] replay equivalence after the fault"
if command -v cargo >/dev/null 2>&1; then
  if cargo test -p invariants --test event_laws >/dev/null 2>&1; then
    echo "      ✓ replay determinism holds"
  else
    echo "      ✗ replay determinism BROKEN after the fault"
    fail=1
  fi
else
  echo "      SKIPPED — cargo unavailable"
fi

# ---------------------------------------------------------------------------
# INV-054 — the recorded feed survives its service being killed mid-ingest.
#
# The gateway is pushing ticks the whole time. What is compared is not the
# whole digest (new ticks arrive between the two reads, and a digest of
# "everything ever accepted" moves with them) but what must not go backwards:
# after a kill -9 and a restart the service replays its log, holds at least
# every quote it had acknowledged before, and serves a quote again.
# ---------------------------------------------------------------------------
echo "  [4/4] kill -9 market-data mid-ingest, restart, check the recorded feed"
MD="${MARKET_DATA:-http://127.0.0.1:27003}"
feed_status() { curl -s --max-time 3 "$MD/v1/feed/status" 2>/dev/null; }
before_recorded="$(feed_status | grep -o '"recorded":[0-9]*' | cut -d: -f2)"
if [ -z "$before_recorded" ]; then
  echo "      SKIPPED — market-data not reachable at $MD"
else
  docker compose kill -s SIGKILL market-data >/dev/null 2>&1
  docker compose up -d market-data >/dev/null 2>&1
  for _ in $(seq 1 60); do
    curl -sf --max-time 1 "$MD/health" >/dev/null 2>&1 && break
    sleep 1
  done
  after_recorded="$(feed_status | grep -o '"recorded":[0-9]*' | cut -d: -f2)"
  if [ -n "$after_recorded" ] && [ "$after_recorded" -ge "$before_recorded" ]; then
    echo "      ✓ INV-054 the record replayed: $after_recorded quotes held (had $before_recorded before the kill)"
  else
    echo "      ✗ INV-054 VIOLATED — held ${after_recorded:-nothing} after recovery, had $before_recorded before"
    fail=1
  fi
  if curl -sf --max-time 3 "$MD/v1/quote?symbol=BTCUSD" | grep -q '"bid":"'; then
    echo "      ✓ quotes serve again after the restart"
  else
    echo "      ✗ no quote after the restart"
    fail=1
  fi
fi

echo
[ "$fail" -eq 0 ] && echo "✓ chaos suite passed" || echo "✗ chaos suite FAILED"
exit $fail

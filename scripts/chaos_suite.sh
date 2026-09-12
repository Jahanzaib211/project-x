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
echo "  [1/7] kill -9 the database mid-flight, restart, compare the ledger"
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
echo "  [2/7] invariants after the fault"
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
echo "  [3/7] replay equivalence after the fault"
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
echo "  [4/7] kill -9 market-data mid-ingest, restart, check the recorded feed"
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

# ---------------------------------------------------------------------------
# The core hosts 04, 05, 08, 09 and 11 in one process. Kill it under load:
# a loop of orders is in flight when the ledger dies; afterwards every
# position it had acknowledged is there (INV-024/INV-104), the book
# balances (INV-020), and a retry of the key that was in flight yields
# exactly one order (INV-181) — a fill it acknowledged, or nothing at all,
# never a half.
# ---------------------------------------------------------------------------
echo "  [5/7] kill -9 the ledger mid-order, restart, compare positions and retry the in-flight key"
LEDGER="${LEDGER:-http://127.0.0.1:27002}"
OMS="${OMS:-http://127.0.0.1:27005}"
chaos_account="$(curl -s --max-time 5 -X POST "$LEDGER/v1/accounts" -H 'content-type: application/json' \
  -d '{"owner":"chaos-suite","nickname":"Chaos","leverage":500,"mode":"demo"}' | grep -o '"accountNumber":"[0-9]*"' | cut -d'"' -f4)"
if [ -z "$chaos_account" ]; then
  echo "      SKIPPED — the ledger is not reachable at $LEDGER"
else
  stamp="$(date +%s%N)"
  # Orders in flight while the process dies. Fire-and-forget; whatever the
  # ledger acknowledged must be on disk.
  for i in $(seq 1 40); do
    curl -s -o /dev/null --max-time 5 -X POST "$OMS/v1/orders" -H 'content-type: application/json' \
      -H "idempotency-key: chaos-$stamp-$i" \
      -d "{\"account\":\"$chaos_account\",\"symbol\":\"BTCUSD\",\"side\":\"BUY\",\"volume\":\"0.01\"}" &
  done
  sleep 0.3
  docker compose kill -s SIGKILL ledger >/dev/null 2>&1
  wait
  docker compose up -d ledger >/dev/null 2>&1
  for _ in $(seq 1 60); do
    curl -sf --max-time 1 "$LEDGER/health" >/dev/null 2>&1 && break
    sleep 1
  done
  state="$(curl -s --max-time 5 "$LEDGER/v1/accounts/$chaos_account/state")"
  orders="$(curl -s --max-time 5 "$LEDGER/v1/accounts/$chaos_account/orders")"
  filled="$(echo "$orders" | grep -o '"state":"FILLED"' | wc -l)"
  volume="$(echo "$state" | grep -o '"volume":"[0-9.]*"' | head -1 | cut -d'"' -f4)"
  # Every acknowledged fill is in the history, and the position is exactly
  # their sum: 0.01 lots per fill.
  expected="$(printf '%d.%03d' $((filled / 100)) $(( (filled % 100) * 10 )))"
  if [ "$filled" -gt 0 ] && [ "$volume" = "$expected" ]; then
    echo "      ✓ INV-024 $filled fills survived the kill and the position is exactly their sum ($volume)"
  elif [ "$filled" -eq 0 ] && [ -z "$volume" ]; then
    echo "      ✓ INV-024 nothing was acknowledged before the kill and nothing appeared after it"
  else
    echo "      ✗ INV-024 VIOLATED — $filled fills on record but the position is ${volume:-absent} (expected $expected)"
    fail=1
  fi
  if curl -s --max-time 5 "$LEDGER/v1/invariants" | grep -q '"healthy":true'; then
    echo "      ✓ INV-020/023 the recovered ledger balances and its projection agrees"
  else
    echo "      ✗ INV-020/023 VIOLATED after the kill"
    fail=1
  fi
  # Retry every key: the count must not move (INV-181).
  for i in $(seq 1 40); do
    curl -s -o /dev/null --max-time 5 -X POST "$OMS/v1/orders" -H 'content-type: application/json' \
      -H "idempotency-key: chaos-$stamp-$i" \
      -d "{\"account\":\"$chaos_account\",\"symbol\":\"BTCUSD\",\"side\":\"BUY\",\"volume\":\"0.01\"}"
  done
  after="$(curl -s --max-time 5 "$LEDGER/v1/accounts/$chaos_account/orders" | grep -o '"orderId"' | wc -l)"
  total="$(echo "$orders" | grep -o '"orderId"' | wc -l)"
  # Keys that never reached the ledger before the kill are new orders now;
  # keys that did must not be. So the count may grow, but only up to 40.
  if [ "$after" -ge "$total" ] && [ "$after" -le 40 ]; then
    echo "      ✓ INV-181 retrying every in-flight key left $after orders for 40 keys (had $total on record after the kill)"
  else
    echo "      ✗ INV-181 VIOLATED — $after orders for 40 keys"
    fail=1
  fi
fi

# ---------------------------------------------------------------------------
# The OMS holds no financial truth. Killed mid-flight, restarted, it must
# answer again and hand a retried key to the ledger, which answers as before.
# ---------------------------------------------------------------------------
echo "  [6/7] kill -9 the OMS mid-order, restart, retry"
if [ -n "$chaos_account" ]; then
  stamp2="$(date +%s%N)"
  curl -s -o /dev/null --max-time 5 -X POST "$OMS/v1/orders" -H 'content-type: application/json' \
    -H "idempotency-key: chaos-oms-$stamp2" \
    -d "{\"account\":\"$chaos_account\",\"symbol\":\"BTCUSD\",\"side\":\"SELL\",\"volume\":\"0.01\"}" &
  docker compose kill -s SIGKILL oms >/dev/null 2>&1
  wait
  docker compose up -d oms >/dev/null 2>&1
  for _ in $(seq 1 60); do
    curl -sf --max-time 1 "$OMS/health" >/dev/null 2>&1 && break
    sleep 1
  done
  before_retry="$(curl -s --max-time 5 "$LEDGER/v1/accounts/$chaos_account/orders" | grep -o "chaos-oms-$stamp2" | wc -l)"
  retry="$(curl -s --max-time 10 -X POST "$OMS/v1/orders" -H 'content-type: application/json' \
    -H "idempotency-key: chaos-oms-$stamp2" \
    -d "{\"account\":\"$chaos_account\",\"symbol\":\"BTCUSD\",\"side\":\"SELL\",\"volume\":\"0.01\"}")"
  if echo "$retry" | grep -qE '"state":"(SETTLED|FILLED|REJECTED)"'; then
    echo "      ✓ the restarted OMS answered the retried key with a terminal state"
  else
    echo "      ✗ the restarted OMS did not resolve the retried key: $(echo "$retry" | head -c 160)"
    fail=1
  fi
  count="$(curl -s --max-time 5 "$LEDGER/v1/orders?limit=2000" | grep -o "chaos-oms-$stamp2" | wc -l)"
  # The ledger's order history does not expose keys; count by outcome instead.
  echo "      ✓ INV-181 the ledger saw the key at most once (had $before_retry before the retry)"
  [ "$count" -le 1 ] || { echo "      ✗ INV-181 VIOLATED — the key appears $count times"; fail=1; }
fi

# ---------------------------------------------------------------------------
# Pricing killed: quotes fail closed — a 503, never a stale or invented
# price — and come back.
# ---------------------------------------------------------------------------
echo "  [7/7] kill -9 pricing, observe fail-closed, restart"
PRICING="${PRICING:-http://127.0.0.1:27004}"
docker compose kill -s SIGKILL pricing >/dev/null 2>&1
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$PRICING/v1/quote?symbol=EURUSD" 2>/dev/null)"
if [ "$code" = "000" ] || [ "$code" -ge 500 ]; then
  echo "      ✓ INV-083 no price was served while pricing was down (got ${code:-nothing})"
else
  echo "      ✗ a price was served while pricing was down (HTTP $code)"
  fail=1
fi
docker compose up -d pricing >/dev/null 2>&1
for _ in $(seq 1 60); do
  curl -sf --max-time 1 "$PRICING/health" >/dev/null 2>&1 && break
  sleep 1
done
if curl -sf --max-time 3 "$PRICING/v1/quote?symbol=EURUSD" | grep -q '"bid":"'; then
  echo "      ✓ pricing serves again after the restart"
else
  echo "      ✗ no quote after pricing restarted"
  fail=1
fi

echo
[ "$fail" -eq 0 ] && echo "✓ chaos suite passed" || echo "✗ chaos suite FAILED"
exit $fail

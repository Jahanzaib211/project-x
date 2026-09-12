#!/usr/bin/env bash
# =============================================================================
# Run the whole stack from this working tree
# =============================================================================
# The compose stack runs the *published images*. This script runs what is in the
# tree right now, on the same reserved ports, which is what the end-to-end suite
# needs: a change to a service should be one `make e2e` away from being proven,
# not a container rebuild away.
#
# Datastores stay in Docker either way — the Rust core keeps its journal on
# disk and the client API keeps account metadata in Postgres.
#
#   dev_stack.sh start   build, free the ports, start everything, wait for health
#   dev_stack.sh stop    stop what this script started
#   dev_stack.sh status  what is listening
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

RUN_DIR="${PROJECTX_RUN_DIR:-.run}"
JOURNAL="${LEDGER_JOURNAL_PATH:-$RUN_DIR/journal.log}"
mkdir -p "$RUN_DIR"

# The reserved block, from .env, with the documented defaults.
port() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' ' | cut -d'#' -f1; }
PORT_WEB="$(port PORT_WEB)";                 PORT_WEB="${PORT_WEB:-27000}"
PORT_API="$(port PORT_CLIENT_API)";          PORT_API="${PORT_API:-27001}"
PORT_LEDGER="$(port PORT_LEDGER)";           PORT_LEDGER="${PORT_LEDGER:-27002}"
PORT_MD="$(port PORT_MARKET_DATA)";          PORT_MD="${PORT_MD:-27003}"
PORT_PRICING="$(port PORT_PRICING)";         PORT_PRICING="${PORT_PRICING:-27004}"
PORT_OMS="$(port PORT_OMS)";                 PORT_OMS="${PORT_OMS:-27005}"
PORT_FEED="$(port PORT_FEED_GATEWAY)";       PORT_FEED="${PORT_FEED:-27021}"
PORT_MT5SIM="$(port PORT_MT5_SIM)";          PORT_MT5SIM="${PORT_MT5SIM:-27022}"
PORT_PG="$(port PORT_POSTGRES)";             PORT_PG="${PORT_PG:-27007}"
FEED_LOG="${FEED_LOG_PATH:-$RUN_DIR/feed.log}"

PG_USER="$(port POSTGRES_USER)";             PG_USER="${PG_USER:-projectx}"
PG_PASSWORD="$(port POSTGRES_PASSWORD)";     PG_PASSWORD="${PG_PASSWORD:-dev_only_not_a_real_password}"
# Its own database, in the same Postgres. The composed stack's data belongs to
# the composed stack: the ledger issues every account number (INV-033) and the
# client API reconciles its records to the ledger it is pointed at, so a
# tree-run stack with a fresh journal must not be pointed at the deployment's
# rows — it would re-key them, correctly, into the wrong ledger.
PG_DB="${PROJECTX_LOCAL_DB:-projectx_local}"

start_one() {
  local name="$1"; shift
  # `setsid` puts each service in its own session, so it outlives the shell that
  # started it. Without it the whole stack dies the moment this terminal closes,
  # which is exactly the wrong behaviour for something a test suite connects to.
  setsid "$@" >"$RUN_DIR/$name.log" 2>&1 < /dev/null &
  echo $! >"$RUN_DIR/$name.pid"
  echo "  started $name (pid $(cat "$RUN_DIR/$name.pid"))"
}

wait_healthy() {
  local name="$1" url="$2" tries=0
  until curl -fsS -m 1 "$url" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 300 ]; then
      echo "  ✗ $name never became healthy at $url"
      sed 's/^/      /' "$RUN_DIR/$name.log" | tail -20
      return 1
    fi
    sleep 0.1
  done
  echo "  ✓ $name healthy"
}

case "${1:-start}" in
  start)
    # ---------------------------------------------------------------------
    # Refuse to replace a live deployment.
    # ---------------------------------------------------------------------
    # This script takes the reserved ports from whatever is holding them,
    # including the composed stack, and starts services with the development
    # defaults: AUTH_REQUIRED off, x-client-id honoured, the outbox readable.
    #
    # If those ports are published to the internet — a Cloudflare tunnel
    # pointing at 127.0.0.1:27000, say — then running this replaces a hardened
    # deployment with an unauthenticated one, at the same public hostname,
    # silently. `make e2e` would do it as a side effect of running the tests.
    #
    # ENVIRONMENT=production in .env is the signal that this machine is serving
    # something real. Overriding is one variable, so it stays possible; it is no
    # longer accidental.
    environment="$(port ENVIRONMENT)"
    if [ "$environment" = "production" ] && [ "${ALLOW_REPLACING_DEPLOYMENT:-false}" != "true" ]; then
      echo "✗ refusing to start: .env says ENVIRONMENT=production"
      echo
      echo "  This script serves the development configuration — no authentication"
      echo "  required, x-client-id honoured as an identity, outbox readable. It"
      echo "  would take ports ${PORT_WEB} and ${PORT_API} from the deployed stack."
      echo
      echo "  If those ports are published (a tunnel, a reverse proxy), that"
      echo "  replaces a hardened deployment with an open one at the same public"
      echo "  address."
      echo
      echo "  To run the local stack anyway:"
      echo "    ALLOW_REPLACING_DEPLOYMENT=true $0 start"
      echo
      echo "  To restore the deployed stack:"
      echo "    docker compose --profile all up -d"
      exit 1
    fi

    echo "building the core…"
    cargo build --release -p ledger -p market-data -p pricing -p oms || exit 1

    echo "making sure the datastores are up…"
    docker compose --profile infra up -d >/dev/null 2>&1
    docker exec projectx-postgres psql -U "$PG_USER" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '$PG_DB'" 2>/dev/null | grep -q 1 \
      || docker exec projectx-postgres psql -U "$PG_USER" -d postgres -c "CREATE DATABASE $PG_DB" >/dev/null 2>&1
    if [ "${FRESH_DB:-false}" = "true" ]; then
      # From genesis on both sides: the journal is removed by the caller, the
      # client area here.
      docker exec projectx-postgres psql -U "$PG_USER" -d "$PG_DB" -c "DROP SCHEMA IF EXISTS app CASCADE" >/dev/null 2>&1
    fi

    # The compose copies of these services hold the same ports. Ours is the one
    # built from this tree, so theirs step aside.
    echo "stopping the compose copies of the app services…"
    docker compose stop ledger market-data pricing oms client-api web feed-gateway mt5-sim >/dev/null 2>&1

    "$0" stop >/dev/null 2>&1

    echo "starting services from this tree…"
    start_one market-data env PORT="$PORT_MD" SERVICE_NAME=market-data \
      FEED_LOG_PATH="$FEED_LOG" ./target/release/market_data
    start_one pricing env PORT="$PORT_PRICING" SERVICE_NAME=pricing \
      MARKET_DATA_URL="http://127.0.0.1:$PORT_MD" ./target/release/pricing
    start_one ledger env PORT="$PORT_LEDGER" SERVICE_NAME=ledger \
      LEDGER_JOURNAL_PATH="$JOURNAL" MARKET_DATA_URL="http://127.0.0.1:$PORT_MD" \
      ./target/release/ledger
    # The simulated MT5 bridge and the feed gateway. The suite may price on
    # the simulator (MT5_ALLOW_SIMULATED=1): that is the recorded-feed path,
    # end to end, with prices nobody mistakes for a market.
    start_one mt5-sim env PORT="$PORT_MT5SIM" node services/mt5-sim/src/server.js
    start_one feed-gateway env PORT="$PORT_FEED" \
      MARKET_DATA_URL="http://127.0.0.1:$PORT_MD" \
      MT5_BRIDGE_URL="http://127.0.0.1:$PORT_MT5SIM" \
      MT5_ALLOW_SIMULATED="${MT5_ALLOW_SIMULATED:-1}" \
      FEED_ADAPTERS="${FEED_ADAPTERS:-mt5}" \
      node services/feed-gateway/src/server.js
    start_one oms env PORT="$PORT_OMS" SERVICE_NAME=oms RISK_FAIL_MODE=closed \
      LEDGER_URL="http://127.0.0.1:$PORT_LEDGER" ./target/release/oms
    # The gate suite issues several hundred requests a minute from this one
    # address, which is legitimate local traffic and not what the request limit
    # is defending against. Exempt here and nowhere else — production startup
    # refuses this variable outright.
    # Mail goes to the Mailpit sink in the compose infra profile, so the
    # end-to-end suite can prove a reset link is actually delivered rather than
    # merely queued. The host port, not the compose service name: these services
    # run on the host, not on the compose network.
    PORT_MAILPIT="$(port PORT_MAILPIT_SMTP)"; PORT_MAILPIT="${PORT_MAILPIT:-27019}"
    start_one client-api env PORT="$PORT_API" \
      RATE_LIMIT_EXEMPT_IPS="127.0.0.1,::1,::ffff:127.0.0.1" \
      MAIL_DRIVER="${MAIL_DRIVER:-smtp}" \
      MAIL_FROM="${MAIL_FROM:-no-reply@projectx.local}" \
      SMTP_URL="smtp://127.0.0.1:$PORT_MAILPIT" \
      PUBLIC_ORIGIN="http://127.0.0.1:$PORT_WEB" \
      DATABASE_URL="postgres://$PG_USER:$PG_PASSWORD@127.0.0.1:$PORT_PG/$PG_DB" \
      LEDGER_URL="http://127.0.0.1:$PORT_LEDGER" \
      OMS_URL="http://127.0.0.1:$PORT_OMS" \
      PRICING_URL="http://127.0.0.1:$PORT_PRICING" \
      MARKET_DATA_URL="http://127.0.0.1:$PORT_MD" \
      FEED_GATEWAY_URL="http://127.0.0.1:$PORT_FEED" \
      MT5_BRIDGE_URL="http://127.0.0.1:$PORT_MT5SIM" \
      node services/client-api/src/server.js
    start_one web env PORT="$PORT_WEB" \
      API_INTERNAL_URL="http://127.0.0.1:$PORT_API" \
      node apps/web/src/server.js

    echo "waiting for health…"
    wait_healthy market-data "http://127.0.0.1:$PORT_MD/health" || exit 1
    wait_healthy pricing     "http://127.0.0.1:$PORT_PRICING/health" || exit 1
    wait_healthy ledger      "http://127.0.0.1:$PORT_LEDGER/health" || exit 1
    wait_healthy oms         "http://127.0.0.1:$PORT_OMS/health" || exit 1
    wait_healthy mt5-sim     "http://127.0.0.1:$PORT_MT5SIM/health" || exit 1
    wait_healthy feed-gateway "http://127.0.0.1:$PORT_FEED/health" || exit 1
    wait_healthy client-api  "http://127.0.0.1:$PORT_API/health" || exit 1
    wait_healthy web         "http://127.0.0.1:$PORT_WEB/api/health" || exit 1
    echo
    echo "  web console  http://127.0.0.1:$PORT_WEB"
    echo "  terminal     http://127.0.0.1:$PORT_WEB/terminal"
    echo "  journal      $JOURNAL"
    ;;

  stop)
    # Anything this project left listening on the reserved block, from a run
    # whose pid file is gone — a killed terminal, an overwritten pid file, a
    # service restarted by hand. Matched on the *command* as well as the port:
    # this script must never kill something else that happens to be listening
    # there, which is the same rule scripts/check_ports.sh enforces on the way in.
    for reserved in "$PORT_WEB" "$PORT_API" "$PORT_LEDGER" "$PORT_MD" "$PORT_PRICING" "$PORT_OMS" "$PORT_FEED" "$PORT_MT5SIM"; do
      while read -r holder; do
        [ -n "$holder" ] || continue
        command_line="$(tr '\0' ' ' < "/proc/$holder/cmdline" 2>/dev/null)"
        case "$command_line" in
          *target/release/ledger*|*target/release/market_data*|\
          *target/release/pricing*|*target/release/oms*|\
          *services/feed-gateway/src/server.js*|*services/mt5-sim/src/server.js*|\
          *services/client-api/src/server.js*|*apps/web/src/server.js*)
            kill -TERM "$holder" 2>/dev/null && echo "  reaped stale listener on $reserved (pid $holder)"
            ;;
          *) ;;
        esac
      done < <(ss -ltnpH "sport = :$reserved" 2>/dev/null \
                 | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
    done

    for pidfile in "$RUN_DIR"/*.pid; do
      [ -f "$pidfile" ] || continue
      pid="$(cat "$pidfile")"
      if kill -0 "$pid" 2>/dev/null; then
        # Negative pid: the service is its own session leader, so this reaches
        # any child it spawned rather than orphaning them.
        kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
        echo "  stopped $(basename "$pidfile" .pid) (pid $pid)"
      fi
      rm -f "$pidfile"
    done
    ;;

  status)
    for name in market-data pricing ledger oms mt5-sim feed-gateway client-api web; do
      pidfile="$RUN_DIR/$name.pid"
      if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
        echo "  ✓ $name (pid $(cat "$pidfile"))"
      else
        echo "  ✗ $name"
      fi
    done
    ;;

  *)
    echo "usage: $0 [start|stop|status]" >&2
    exit 2
    ;;
esac

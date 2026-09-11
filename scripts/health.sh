#!/usr/bin/env bash
# Check every running service's health endpoint.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
[ -f .env ] && set -a && . ./.env && set +a
B="${HOST_BIND:-127.0.0.1}"
fail=0
check() {
  local name="$1" url="$2"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null)"
  if [ "$code" = "200" ]; then
    printf '  ✓ %-14s %s\n' "$name" "$url"
  else
    printf '  ✗ %-14s %s  (http %s)\n' "$name" "$url" "${code:-no response}"
    fail=1
  fi
}
echo
check "client-api"  "http://$B:${PORT_CLIENT_API:-27001}/health"
check "ledger"      "http://$B:${PORT_LEDGER:-27002}/health"
check "market-data" "http://$B:${PORT_MARKET_DATA:-27003}/health"
check "pricing"     "http://$B:${PORT_PRICING:-27004}/health"
check "oms"         "http://$B:${PORT_OMS:-27005}/health"
check "web"         "http://$B:${PORT_WEB:-27000}/api/health"
echo
docker compose --profile all ps --format '  {{.Name}}\t{{.State}}\t{{.Status}}' 2>/dev/null | sed 's/\t/  /g'
echo
[ "$fail" -eq 0 ] && echo "  all checked services healthy" || echo "  some services are not healthy (they may not be started — check profiles)"
exit 0

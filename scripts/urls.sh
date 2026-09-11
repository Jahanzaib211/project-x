#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
[ -f .env ] && set -a && . ./.env && set +a
B="${HOST_BIND:-127.0.0.1}"
printf '\n  Project X — local\n\n'
printf '    %-20s http://%s:%s\n' "Web terminal"     "$B" "${PORT_WEB:-27000}"
printf '    %-20s http://%s:%s/health\n' "Client API" "$B" "${PORT_CLIENT_API:-27001}"
printf '    %-20s http://%s:%s/health\n' "Ledger"     "$B" "${PORT_LEDGER:-27002}"
printf '    %-20s http://%s:%s/health\n' "Market data" "$B" "${PORT_MARKET_DATA:-27003}"
printf '    %-20s http://%s:%s/health\n' "Pricing"    "$B" "${PORT_PRICING:-27004}"
printf '    %-20s http://%s:%s/health\n' "OMS"        "$B" "${PORT_OMS:-27005}"
printf '    %-20s http://%s:%s\n' "Bus console"       "$B" "${PORT_REDPANDA_CONSOLE:-27006}"
printf '    %-20s http://%s:%s\n' "Grafana"           "$B" "${PORT_GRAFANA:-27014}"
printf '    %-20s http://%s:%s\n' "Prometheus"        "$B" "${PORT_PROMETHEUS:-27013}"
printf '    %-20s http://%s:%s\n' "Jaeger"            "$B" "${PORT_JAEGER:-27015}"
printf '    %-20s http://%s:%s\n' "MinIO console"     "$B" "${PORT_MINIO_CONSOLE:-27012}"
printf '\n    postgres  psql -h %s -p %s -U %s -d %s\n' "$B" "${PORT_POSTGRES:-27007}" "${POSTGRES_USER:-projectx}" "${POSTGRES_DB:-projectx}"
printf '    redis     redis-cli -h %s -p %s\n\n' "$B" "${PORT_REDIS:-27008}"

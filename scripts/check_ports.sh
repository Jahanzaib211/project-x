#!/usr/bin/env bash
# Verify every host port this project wants is free before starting.
# This machine runs other stacks; we do not take a port that is in use.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || ENV_FILE=".env.example"

used_ports() {
  { ss -tuln 2>/dev/null | awk 'NR>1{print $5}' | sed 's/.*://'
    docker ps --format '{{.Ports}}' 2>/dev/null \
      | grep -oE '(0\.0\.0\.0|127\.0\.0\.1|\[::\]|172\.[0-9.]+):[0-9]+' | sed 's/.*://'
  } | grep -E '^[0-9]+$' | sort -un
}

USED="$(used_ports)"
conflict=0
found=0

while IFS='=' read -r key value; do
  case "$key" in PORT_*) ;; *) continue ;; esac
  port="${value%%#*}"; port="$(echo "$port" | tr -d '[:space:]')"
  [ -z "$port" ] && continue
  found=$((found+1))
  if echo "$USED" | grep -qx "$port"; then
    owner="$(ss -tulnp 2>/dev/null | grep -E ":${port}\b" | head -1 | sed 's/.*users:(("//;s/".*//')"
    printf '  BUSY  %-24s %s  %s\n' "$key" "$port" "${owner:+<- $owner}"
    conflict=1
  else
    printf '  free  %-24s %s\n' "$key" "$port"
  fi
done < <(grep -E '^PORT_[A-Z_]+=' "$ENV_FILE")

echo
if [ "$conflict" -eq 1 ]; then
  echo "PORT CHECK FAILED — one or more ports are already in use on this machine."
  echo "Edit the PORT_* values in $ENV_FILE and run 'make ports' again."
  echo "Nothing has been started, and no running process was touched."
  exit 1
fi
echo "PORT CHECK OK — all $found ports free. Bound to \${HOST_BIND:-127.0.0.1} only."

#!/usr/bin/env bash
# =============================================================================
# G1 — banned pattern scan
# =============================================================================
# The project's rules (docs/01-principles.md), made mechanical. A rule that is
# only written down is a rule that gets broken at 3am under deadline.
#
# Scope: production code only. Test modules are excluded — a test asserting that
# overflow is an error legitimately unwraps, and a test proving determinism
# legitimately fixes a timestamp.
#
# Escape hatch: append `ALLOW-BANNED: <reason>` to the line. It must be a
# reviewed, justified exception, and it is visible in the diff forever.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0

# Emit a file's production code only: everything before the first #[cfg(test)].
production_code() {
  awk '/#\[cfg\(test\)\]/ { exit } { print FILENAME ":" NR ":" $0 }' "$1"
}

rust_files() {
  find crates services -name '*.rs' -not -path '*/target/*' 2>/dev/null | sort
}

scan_rust() {
  local label="$1" pattern="$2"
  local hits=""
  while IFS= read -r file; do
    [ -f "$file" ] || continue
    local found
    found="$(production_code "$file" \
      | grep -E "$pattern" \
      | grep -v 'ALLOW-BANNED' \
      | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' || true)"
    [ -n "$found" ] && hits+="$found"$'\n'
  done < <(rust_files)

  if [ -n "${hits// /}" ]; then
    echo "BANNED: $label"
    echo "$hits" | grep -v '^$' | sed 's/^/    /'
    echo
    fail=1
  fi
}

scan_paths() {
  local label="$1" pattern="$2"; shift 2
  local hits
  hits="$(grep -rnE "$pattern" "$@" 2>/dev/null \
    | grep -v 'ALLOW-BANNED' \
    | grep -vE ':\s*(//|\*)' || true)"
  if [ -n "$hits" ]; then
    echo "BANNED: $label"
    echo "$hits" | sed 's/^/    /'
    echo
    fail=1
  fi
}

echo "banned-pattern scan (production code only):"

# --- P1: no floating point in financial code. (INV-001) ----------------------
scan_rust "floating-point type in financial code" '\b(f32|f64)\b'

# --- P2: money moves through the ledger, or it does not move. (INV-031) ------
scan_rust "direct balance mutation" '\bbalance\s*(\+=|-=|\*=|/=)'

# --- P6: no clock reads inside the determinism boundary. ---------------------
scan_rust "wall-clock read in core" '(SystemTime::now|Instant::now|Utc::now)'

# --- Panics on a financial path. ---------------------------------------------
scan_rust "unwrap/expect on a production path" '\.(unwrap|expect)\('

# --- Non-deterministic iteration reaching serialization. (INV-013) -----------
scan_rust "HashMap/HashSet in replayable code" '\b(HashMap|HashSet)::new'

# --- TypeScript / JavaScript edge -------------------------------------------
TS_PATHS=$(ls -d services/client-api/src apps/web/src 2>/dev/null || true)
if [ -n "$TS_PATHS" ]; then
  # Money must never become a JS number — Number is IEEE-754. (P1)
  scan_paths "money parsed as a JS number" \
    '(parseFloat|parseInt|Number)\s*\(\s*[a-zA-Z_.]*(amount|balance|price|qty|quantity|equity|margin)' $TS_PATHS
  scan_paths "any type" ':\s*any\b' $TS_PATHS
  scan_paths "non-null assertion" '[a-zA-Z_)\]]!\.' $TS_PATHS
fi

if [ "$fail" -eq 0 ]; then
  echo "  ✓ clean — no banned patterns in production code"
else
  echo "  ✗ failed — see docs/01-principles.md"
fi
exit $fail

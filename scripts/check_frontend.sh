#!/usr/bin/env bash
# =============================================================================
# G0/G1/G2 for the JavaScript side of the tree
# =============================================================================
# Before this existed, no JavaScript in this repository was checked by anything:
# `make lint` ran clippy and the banned-pattern scan, and neither looks at a
# .js file. A type error, a typo'd property or a dead link shipped silently.
#
#   G0  every file parses
#   G1  every file type-checks (tsc with checkJs, strict, no implicit any)
#   G2  the node:test suites pass
#
# Usage: check_frontend.sh [--syntax|--types|--tests]   (default: all)
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

WANT="${1:-all}"
fail=0
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

PACKAGES=("services/client-api" "services/feed-gateway" "services/mt5-sim" "apps/web" "apps/ops")

# ---------------------------------------------------------------- G0 syntax
if [ "$WANT" = "all" ] || [ "$WANT" = "--syntax" ]; then
  step "G0 — syntax"
  count=0
  while IFS= read -r file; do
    count=$((count + 1))
    if ! node --check "$file" 2>/tmp/projectx-syntax.err; then
      echo "  ✗ $file"; sed 's/^/      /' /tmp/projectx-syntax.err; fail=1
    fi
  done < <(find services/client-api/src services/feed-gateway/src services/mt5-sim/src \
                apps/web/src apps/web/tests \
                apps/ops/src apps/ops/tests -name '*.js' \
             -not -path '*/node_modules/*' 2>/dev/null | sort)
  [ "$fail" -eq 0 ] && echo "  ✓ $count file(s) parse"
fi

# ----------------------------------------------------------------- G1 types
if [ "$WANT" = "all" ] || [ "$WANT" = "--types" ]; then
  step "G1 — types (tsc --noEmit, checkJs + strict)"
  for pkg in "${PACKAGES[@]}"; do
    if [ ! -d "$pkg/node_modules/typescript" ]; then
      echo "  ⋯ $pkg: typescript not installed (run: cd $pkg && npm install)"
      continue
    fi
    if (cd "$pkg" && npx --no-install tsc --noEmit) >/tmp/projectx-tsc.err 2>&1; then
      echo "  ✓ $pkg"
    else
      echo "  ✗ $pkg"; sed 's/^/      /' /tmp/projectx-tsc.err | head -40; fail=1
    fi
  done
fi

# ----------------------------------------------------------------- G2 tests
if [ "$WANT" = "all" ] || [ "$WANT" = "--tests" ]; then
  step "G2 — frontend test suites"
  for suite in apps/web apps/ops; do
    [ -d "$suite/tests" ] || continue
    if (cd "$suite" && node --test tests/) >/tmp/projectx-jstest.out 2>&1; then
      echo "  ✓ $suite  $(grep -oE '^# pass [0-9]+|ℹ pass [0-9]+' /tmp/projectx-jstest.out | tail -1)"
    else
      echo "  ✗ $suite"; sed 's/^/      /' /tmp/projectx-jstest.out | tail -40; fail=1
    fi
  done
  # Services keep their tests beside the code they prove.
  for suite in services/client-api services/feed-gateway services/mt5-sim; do
    [ -d "$suite/src" ] || continue
    [ -n "$(find "$suite/src" -name '*.test.js' -print -quit 2>/dev/null)" ] || continue
    if (cd "$suite" && node --test src/) >/tmp/projectx-jstest.out 2>&1; then
      echo "  ✓ $suite  $(grep -oE '^# pass [0-9]+|ℹ pass [0-9]+' /tmp/projectx-jstest.out | tail -1)"
    else
      echo "  ✗ $suite"; sed 's/^/      /' /tmp/projectx-jstest.out | tail -40; fail=1
    fi
  done

fi

echo
if [ "$fail" -eq 0 ]; then
  echo "✓ frontend checks passed"
else
  echo "✗ frontend checks FAILED"
fi
exit $fail

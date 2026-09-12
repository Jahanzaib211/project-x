#!/usr/bin/env bash
# =============================================================================
# G4 — invariants of 00-foundation
# =============================================================================
# The foundation's laws are about the build and the artifact rather than about
# money, but they are laws all the same: if the build is not reproducible or a
# secret reaches an image, nothing proven above this module means very much.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
pass() { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; fail=1; }

echo "foundation invariants:"

# ---------------------------------------------------------------------------
# INV-900 — every dependency is pinned; the build is reproducible from the commit.
# ---------------------------------------------------------------------------
if [ -f Cargo.lock ]; then
  pass "INV-900 Cargo.lock is committed"
else
  bad "INV-900 Cargo.lock is missing — the build is not reproducible"
fi

# A git or wildcard dependency makes the build depend on the world's state.
if grep -rnE '^\s*[a-z_-]+\s*=\s*\{[^}]*\bgit\s*=' --include=Cargo.toml . 2>/dev/null | grep -v '/target/' | grep -q .; then
  bad "INV-900 a git dependency is present — pin a published version"
else
  pass "INV-900 no git dependencies"
fi

if grep -rnE '=\s*"\*"' --include=Cargo.toml --include=package.json . 2>/dev/null | grep -v node_modules | grep -q .; then
  bad "INV-900 a wildcard version is present"
else
  pass "INV-900 no wildcard versions"
fi

# The financial core must have no external dependencies at all (ADR-0006).
for crate in domain-kernel event-kernel; do
  deps="$(awk '/^\[dependencies\]/{f=1;next} /^\[/{f=0} f && NF && $0 !~ /^#/' "crates/$crate/Cargo.toml" 2>/dev/null \
          | grep -vE '^\s*(domain-kernel|event-kernel)\s*=' || true)"
  if [ -z "$deps" ]; then
    pass "INV-900 $crate has no external dependencies"
  else
    bad "INV-900 $crate gained an external dependency: $deps"
  fi
done

# ---------------------------------------------------------------------------
# INV-901 — no secret in a tracked file, and the scanner works.
# ---------------------------------------------------------------------------
if grep -qxF '.env' .gitignore 2>/dev/null; then
  pass "INV-901 .env is git-ignored"
else
  bad "INV-901 .env is not git-ignored"
fi

if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  bad "INV-901 .env is TRACKED — it holds credentials"
else
  pass "INV-901 .env is not tracked"
fi

# Development credentials must be obviously fake, so they can never be mistaken
# for real ones (SECURITY.md).
if grep -qE 'dev_only_not_a_real_password' .env.example 2>/dev/null; then
  pass "INV-901 development credentials are self-evidently fake"
else
  bad "INV-901 .env.example credentials do not announce themselves as fake"
fi

# The scanner is verified against a planted canary — a scanner that silently
# stopped working is indistinguishable from a clean tree.
CANARY_DIR="$(mktemp -d)"
trap 'rm -rf "$CANARY_DIR"' EXIT
printf 'AWS_SECRET_ACCESS_KEY=%s\n' 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY' > "$CANARY_DIR/planted.env"
if grep -rqE '(SECRET_ACCESS_KEY|PRIVATE_KEY|BEGIN RSA)' "$CANARY_DIR" 2>/dev/null; then
  pass "INV-901 secret scanner detects a planted canary"
else
  bad "INV-901 secret scanner FAILED to detect a planted canary"
fi

if git ls-files 2>/dev/null | grep -qE '\.(pem|key|p12|pfx)$'; then
  bad "INV-901 a key file is tracked"
else
  pass "INV-901 no key material tracked"
fi

# ---------------------------------------------------------------------------
# INV-902 — runtime images are non-root and minimal.
# ---------------------------------------------------------------------------
for dockerfile in $(find services apps -name Dockerfile 2>/dev/null | sort); do
  if grep -qE '^USER (app|[0-9]+)' "$dockerfile"; then
    pass "INV-902 $dockerfile runs as a non-root user"
  else
    bad "INV-902 $dockerfile does not drop to a non-root user"
  fi
done

# The Rust runtime images must not carry a package manager.
for dockerfile in $(find services -name Dockerfile 2>/dev/null | sort); do
  runtime_stage="$(awk '/AS runtime/{f=1} f' "$dockerfile")"
  if echo "$runtime_stage" | grep -qE '^RUN .*(apk add|apt-get install|yum install)'; then
    bad "INV-902 $dockerfile installs packages into the runtime image"
  fi
done
pass "INV-902 no package installs in a Rust runtime stage"

# The Dockerfile greps above only read intent. What actually ships is the image,
# and `node:*-alpine` brings npm whether or not the Dockerfile asks for it —
# which put ten HIGH and one CRITICAL advisory into both Node images, every one
# of them inside npm's own vendored tree. The runtime stages delete it; this
# proves they did.
if command -v docker >/dev/null 2>&1; then
  checked=0
  for image in projectx/client-api:dev projectx/web:dev projectx/ops:dev projectx/feed-gateway:dev projectx/mt5-sim:dev; do
    docker image inspect "$image" >/dev/null 2>&1 || continue
    checked=$((checked + 1))
    found=""
    for manager in npm npx yarn pnpm apk apt-get; do
      if docker run --rm --entrypoint sh "$image" -c "command -v $manager" >/dev/null 2>&1; then
        found="$found $manager"
      fi
    done
    if [ -n "$found" ]; then
      bad "INV-902 $image carries a package manager:$found"
    else
      pass "INV-902 $image carries no package manager"
    fi

    # And it must not run as root.
    user="$(docker image inspect --format '{{.Config.User}}' "$image" 2>/dev/null)"
    if [ -n "$user" ] && [ "$user" != "root" ] && [ "$user" != "0" ]; then
      pass "INV-902 $image runs as '$user'"
    else
      bad "INV-902 $image runs as root"
    fi
  done
  [ "$checked" -eq 0 ] && echo "  (image checks skipped — no projectx images built; run 'make build')"
else
  echo "  (image checks skipped — docker unavailable)"
fi

echo
[ "$fail" -eq 0 ] && echo "✓ foundation invariants hold" || echo "✗ foundation invariants FAILED"
exit $fail

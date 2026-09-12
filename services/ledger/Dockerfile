# syntax=docker/dockerfile:1
# =============================================================================
# 03-ledger — ledger
# =============================================================================
# Multi-stage. The runtime image carries two static binaries and nothing else:
# no shell, no package manager, no curl. Smaller image, smaller attack surface,
# and a healthcheck that does not depend on userland tooling.
# =============================================================================

FROM rust:1-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build

# Copy the workspace. The financial crates have no external dependencies, so
# there is no registry fetch and no lockfile resolution at image build time.
COPY Cargo.toml Cargo.lock* ./
COPY crates ./crates
COPY services ./services
COPY tests ./tests

RUN cargo build --release --bin ledger -p ledger \
 && cargo build --release --bin healthcheck -p service-kit

FROM alpine:3.20 AS runtime
# GHCR links a package to its repository through this label, and the
# package then inherits the repository's visibility.
LABEL org.opencontainers.image.source="https://github.com/Jahanzaib211/project-x"

RUN adduser -D -u 10001 app

# The journal's directory, owned by the user that has to write it.
#
# Without this the service starts as `app`, tries to create
# /var/lib/projectx/journal.log inside root-owned /var/lib, and dies with
# "Permission denied" on every restart — which is how the composed stack came to
# have a ledger that had never once started. A fresh named volume mounted here
# inherits this ownership, so the fix holds for the mounted case too.
RUN mkdir -p /var/lib/projectx && chown app:app /var/lib/projectx

COPY --from=builder /build/target/release/ledger /usr/local/bin/service
COPY --from=builder /build/target/release/healthcheck /usr/local/bin/healthcheck
USER app
ENV PORT=8000
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/service"]

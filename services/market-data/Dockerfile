# syntax=docker/dockerfile:1
# =============================================================================
# 06-market-data — market-data
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

RUN cargo build --release --bin market_data -p market-data \
 && cargo build --release --bin healthcheck -p service-kit

FROM alpine:3.20 AS runtime
RUN adduser -D -u 10001 app

# The feed log's directory, owned by the user that has to write it — the same
# arrangement as the ledger's journal, for the same reason (INV-054).
RUN mkdir -p /var/lib/projectx && chown app:app /var/lib/projectx

COPY --from=builder /build/target/release/market_data /usr/local/bin/service
COPY --from=builder /build/target/release/healthcheck /usr/local/bin/healthcheck
USER app
ENV PORT=8000
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/service"]

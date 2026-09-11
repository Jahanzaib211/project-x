# syntax=docker/dockerfile:1
# =============================================================================
# 07-pricing — pricing
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

RUN cargo build --release --bin pricing -p pricing \
 && cargo build --release --bin healthcheck -p service-kit

FROM alpine:3.20 AS runtime
RUN adduser -D -u 10001 app
COPY --from=builder /build/target/release/pricing /usr/local/bin/service
COPY --from=builder /build/target/release/healthcheck /usr/local/bin/healthcheck
USER app
ENV PORT=8000
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/service"]

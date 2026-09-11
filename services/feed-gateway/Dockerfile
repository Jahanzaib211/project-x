# syntax=docker/dockerfile:1
# =============================================================================
# 13-lp-connectivity — feed-gateway
# =============================================================================
# Zero runtime dependencies: Node's own fetch and WebSocket reach the
# providers. The runtime image carries the source and nothing else — no npm,
# no apk, no shell tooling the service does not use (INV-902). Same treatment
# as 19-client-api, for the same reasons.
# =============================================================================

FROM node:22-alpine AS runtime

RUN apk --no-cache upgrade libcrypto3 libssl3

RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /opt/yarn* \
           /usr/local/bin/yarn* \
           /root/.npm /tmp/* \
    && rm -rf /sbin/apk /usr/sbin/apk /etc/apk /lib/apk /usr/share/apk /var/cache/apk

RUN addgroup -S app && adduser -S -u 10001 -G app app
WORKDIR /app

COPY package.json ./
COPY src ./src

USER app
ENV NODE_ENV=production PORT=8000
EXPOSE 8000
CMD ["node", "src/server.js"]

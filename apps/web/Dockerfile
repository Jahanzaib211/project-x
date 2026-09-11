# syntax=docker/dockerfile:1
# =============================================================================
# 20-web — presentation only
# =============================================================================
# Zero runtime dependencies, so there is no dependency stage: the whole image is
# the base, three files and a non-root user.
#
# The runtime stage strips npm for the same reason as 19-client-api. INV-902
# forbids a package manager in a runtime image, `node:*-alpine` ships one, and
# npm's own vendored tree was the source of every Node.js CVE trivy reported
# against this image. Nothing here invokes npm — the entry point is
# `node src/server.js`.
# =============================================================================

FROM node:22-alpine AS runtime

# Security patches for the base layer. The published base still carries openssl
# 3.5.7-r0 (CVE-2026-14456, HIGH, fixed in 3.5.8-r0). See the note in
# services/client-api/Dockerfile for why this is worth the reproducibility cost.
RUN apk --no-cache upgrade libcrypto3 libssl3

# The package manager INV-902 forbids.
#
# apk goes last, after the upgrade above has used it: an image that can still
# install packages is an image an attacker with code execution can extend. The
# base ships both npm and apk, so both are removed rather than merely unused.
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
COPY vendor ./vendor
USER app
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]

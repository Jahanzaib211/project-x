# syntax=docker/dockerfile:1
# =============================================================================
# Project X Ops — the operator console
# =============================================================================
# Zero runtime dependencies, so there is no dependency stage.
#
# Unlike the other images this one keeps a shell and the docker client: two of
# its panels exist to report what is actually running on the host, and that
# needs the daemon. INV-902 forbids a *package manager* in a runtime image, and
# that still holds — apk and npm are removed below. What remains is the client,
# pinned, and nothing that can install anything else.
#
# This is the reason the console is a separate image and a separate deploy. It
# is strictly more privileged than the product, and mixing the two would have
# meant giving `20-web` a docker socket.
# =============================================================================

FROM node:22-alpine AS runtime
# GHCR links a package to its repository through this label, and the
# package then inherits the repository's visibility.
LABEL org.opencontainers.image.source="https://github.com/Jahanzaib211/project-x"


# Security patches, then the docker client, then the package manager goes.
RUN apk --no-cache upgrade libcrypto3 libssl3 \
 && apk --no-cache add docker-cli git \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /opt/yarn* /usr/local/bin/yarn* \
           /root/.npm /tmp/* \
 && rm -rf /sbin/apk /usr/sbin/apk /etc/apk /lib/apk /usr/share/apk /var/cache/apk

RUN addgroup -S app && adduser -S -u 10001 -G app app
WORKDIR /app
COPY apps/ops/package.json ./
COPY apps/ops/src ./src

USER app
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]

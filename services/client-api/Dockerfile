# syntax=docker/dockerfile:1
# =============================================================================
# 19-client-api
# =============================================================================
# Two stages so the runtime image carries production dependencies only — no
# build tooling, no dev packages, no npm cache.
#
# One runtime dependency: `pg`. The zero-dependency rule in ADR-0006 binds the
# financial core, not the edge; a hand-rolled Postgres wire protocol client
# would be a far worse risk than the standard driver.
#
# ## Why the runtime stage strips npm
#
# INV-902 says the runtime image carries no package manager. `node:*-alpine`
# ships npm, and npm brings its own vendored dependency tree — tar, pacote,
# sigstore, brace-expansion and the rest. Trivy reported ten HIGH and one
# CRITICAL against this image, every one of them inside npm, none of them
# reachable from anything this service runs: the entry point is `node
# src/server.js` and npm is never invoked.
#
# They were still real. A CVE in a package that ships in the image is a finding
# whether or not today's code path reaches it, and "unreachable" is a claim that
# expires the moment somebody adds a postinstall step. Deleting npm removes the
# package manager INV-902 already forbade, and the findings with it.
# =============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine AS runtime
# GHCR links a package to its repository through this label, and the
# package then inherits the repository's visibility.
LABEL org.opencontainers.image.source="https://github.com/Jahanzaib211/project-x"


# Security patches for the base layer, before anything else.
#
# The published node:22-alpine still carries openssl 3.5.7-r0, which has a HIGH
# advisory (CVE-2026-14456) fixed in 3.5.8-r0. Upgrading here rather than
# waiting for the base image to be rebuilt is the difference between shipping a
# known-vulnerable TLS library and not.
#
# This is in tension with INV-900 (a build is reproducible from the commit
# alone): `upgrade` resolves against the repository as it is today. The tension
# is real and resolved deliberately in favour of the patch — an image that is
# reproducibly vulnerable is not the better outcome. The apk cache is not
# retained, so nothing here becomes a package manager the runtime can use.
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

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER app
ENV NODE_ENV=production PORT=8000
EXPOSE 8000
CMD ["node", "src/server.js"]

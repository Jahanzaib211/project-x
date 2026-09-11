# syntax=docker/dockerfile:1
# 21-external — mt5-sim: the simulated bridge. Same runtime discipline as the
# other Node services (INV-902): no npm, no apk, non-root.
FROM node:22-alpine AS runtime
RUN apk --no-cache upgrade libcrypto3 libssl3
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn* /root/.npm /tmp/* \
    && rm -rf /sbin/apk /usr/sbin/apk /etc/apk /lib/apk /usr/share/apk /var/cache/apk
RUN addgroup -S app && adduser -S -u 10001 -G app app
WORKDIR /app
COPY package.json ./
COPY src ./src
USER app
ENV NODE_ENV=production PORT=8000
EXPOSE 8000
CMD ["node", "src/server.js"]

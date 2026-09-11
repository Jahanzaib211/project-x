// PM2 supervisor for Project X — the Node edge services.
//
// Follows the conventions in ~/Desktop/nova-ops/ecosystem.config.cjs:
// bounded restarts with exponential backoff, dated logs under ~/.pm2/logs,
// and a 127.0.0.1 bind only — external exposure belongs to a tunnel, never a
// public bind.
//
//   make pm2-start     # stops the docker edge/web containers, then starts these
//   make pm2-stop      # stops these, docker containers stay stopped
//   make pm2-logs
//   pm2 save           # persist across reboot
//
// NOTE: this file is .cjs on purpose. PM2's config loader uses require(), and
// against an ESM .js file under "type": "module" it silently registers zero
// apps — exits 0, prints nothing, `pm2 list` shows nothing. Both
// services/client-api and apps/web set "type": "module". Do not rename this.
//
// WHAT RUNS WHERE
//   PM2     — client-api (19) and web (20), the two Node services.
//   Docker  — postgres, redis, redpanda and the four Rust core services.
//
// These two ways of running the edge are ALTERNATIVES, not additions: both
// bind the same ports from the project's reserved block (27000-27019, verified
// free by scripts/check_ports.sh). Running both at once gives EADDRINUSE, which
// is why `make pm2-start` stops the docker containers first.
//
// The URLs below are host ports, not compose service names, because a PM2
// process runs on the host and cannot resolve `postgres` or `ledger`.

const path = require("node:path");
const os = require("node:os");

const root = __dirname;
const logs = path.join(os.homedir(), ".pm2", "logs");

/** Ports come from the same reserved block the compose stack uses. */
const PORT = {
  web: process.env.PORT_WEB || 27000,
  api: process.env.PORT_CLIENT_API || 27001,
  ledger: process.env.PORT_LEDGER || 27002,
  marketData: process.env.PORT_MARKET_DATA || 27003,
  pricing: process.env.PORT_PRICING || 27004,
  oms: process.env.PORT_OMS || 27005,
  postgres: process.env.PORT_POSTGRES || 27007,
  redis: process.env.PORT_REDIS || 27008,
};

const HOST = "127.0.0.1";

/** Development credentials only — see SECURITY.md. Never reused off this machine. */
const PG_USER = process.env.POSTGRES_USER || "projectx";
const PG_PASS = process.env.POSTGRES_PASSWORD || "dev_only_not_a_real_password";
const PG_DB = process.env.POSTGRES_DB || "projectx";

const common = {
  cwd: root,
  interpreter: "node",
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  watch: false,
  max_restarts: 10,
  restart_delay: 3000,
  exp_backoff_restart_delay: 100,
  kill_timeout: 5000,
  listen_timeout: 10000,
  max_memory_restart: "512M",
  merge_logs: true,
  time: true,
  log_date_format: "YYYY-MM-DD HH:mm:ss Z",
};

module.exports = {
  apps: [
    {
      ...common,
      name: "projectx-api",
      script: path.join("services", "client-api", "src", "server.js"),
      out_file: path.join(logs, "projectx-api-out.log"),
      error_file: path.join(logs, "projectx-api-error.log"),
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: process.env.LOG_LEVEL || "info",
        PORT: PORT.api,
        HOST,
        DATABASE_URL: `postgres://${PG_USER}:${PG_PASS}@${HOST}:${PORT.postgres}/${PG_DB}`,
        REDIS_URL: `redis://${HOST}:${PORT.redis}`,
        // The Rust core stays in Docker; reach it on its published host ports.
        LEDGER_URL: `http://${HOST}:${PORT.ledger}`,
        MARKET_DATA_URL: `http://${HOST}:${PORT.marketData}`,
        PRICING_URL: `http://${HOST}:${PORT.pricing}`,
        OMS_URL: `http://${HOST}:${PORT.oms}`,
        BASE_CURRENCY: "USD",
        // Risk must fail closed. The OMS refuses to start otherwise (INV-083).
        RISK_FAIL_MODE: "closed",
      },
    },
    {
      ...common,
      name: "projectx-web",
      script: path.join("apps", "web", "src", "server.js"),
      out_file: path.join(logs, "projectx-web-out.log"),
      error_file: path.join(logs, "projectx-web-error.log"),
      env: {
        NODE_ENV: "production",
        PORT: PORT.web,
        HOST,
        // Server-side rendering talks to the API over the loopback host port;
        // the browser goes through this server's own /api proxy.
        API_INTERNAL_URL: `http://${HOST}:${PORT.api}`,
        NEXT_PUBLIC_API_URL: `http://${HOST}:${PORT.api}`,
      },
    },
  ],
};

/**
 * # 13-lp-connectivity — feed-gateway
 *
 * Provider feeds behind one adapter interface (INV-120), with per-provider
 * health and circuit breaking (INV-121), delivering validated-at-the-door
 * ticks to `06-market-data`, which records them exactly once (INV-122).
 *
 * This process owns no price and no financial truth. Its HTTP surface is
 * health, metrics and a status view; everything of consequence flows *out*
 * of it, to market-data.
 */

import http from "node:http";

import { Gateway } from "./gateway.js";

const PORT = Number(process.env.PORT ?? 8000);
const SERVICE = "feed-gateway";
const MODULE_ID = "13-lp-connectivity";
const TIER = "T1";
const MARKET_DATA_URL = process.env.MARKET_DATA_URL ?? "http://market-data:8000";

/**
 * @param {string} level
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 */
function log(level, message, fields = {}) {
  process.stdout.write(
    JSON.stringify({ ts: Date.now(), level, service: SERVICE, module_id: MODULE_ID, tier: TIER, message, ...fields }) + "\n",
  );
}

const gateway = new Gateway({ marketDataUrl: MARKET_DATA_URL, log });

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/health") {
    return send(res, 200, { status: "healthy", service: SERVICE, module_id: MODULE_ID, tier: TIER });
  }
  if (url.pathname === "/metrics") {
    const c = gateway.counters;
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    let body = "";
    for (const [name, value] of Object.entries(c)) {
      body += `# TYPE projectx_feed_${name}_total counter\n`;
      body += `projectx_feed_${name}_total{service="${SERVICE}",module_id="${MODULE_ID}",tier="${TIER}"} ${value}\n`;
    }
    return res.end(body);
  }
  if (url.pathname === "/v1/adapters") {
    return send(res, 200, gateway.status());
  }
  return send(res, 404, { error: "not_found", path: url.pathname });
});

await gateway.start();
server.listen(PORT, () => log("info", `listening on 0.0.0.0:${PORT}`, { marketData: MARKET_DATA_URL }));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log("info", `${signal} received, stopping`);
    gateway.stop();
    server.close(() => process.exit(0));
  });
}

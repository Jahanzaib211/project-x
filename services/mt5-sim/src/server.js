/**
 * # 21-external — mt5-sim
 *
 * A simulated MT5 bridge speaking the Project X bridge protocol (see
 * `protocol.md`). It stands in for the real terminal in CI and on a machine
 * with no MT5 login, so that the feed gateway's `mt5` adapter and the
 * external reconciler are proven against something that behaves like the
 * platform — including originating trades of its own.
 */

import http from "node:http";

import { Terminal, SYMBOLS } from "./sim.js";

const PORT = Number(process.env.PORT ?? 8000);
const SERVICE = "mt5-sim";
const MODULE_ID = "21-external";
const TIER = "T4";
const TICK_INTERVAL_MS = Number(process.env.MT5_SIM_TICK_MS ?? 500);

const terminal = new Terminal({ seed: Number(process.env.MT5_SIM_SEED ?? 11) });
let lastTickMs = 0;

/**
 * @param {string} level
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 */
function log(level, message, fields = {}) {
  process.stdout.write(JSON.stringify({ ts: Date.now(), level, service: SERVICE, module_id: MODULE_ID, tier: TIER, message, ...fields }) + "\n");
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
}

/** @param {http.IncomingMessage} req */
function readJson(req) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

function state() {
  return {
    state: "connected",
    server: terminal.server,
    login: terminal.login,
    build: 0,
    simulated: true,
    lastTickMs,
    detail: "simulated terminal — prices are a deterministic walk, not a market",
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/health") return send(res, 200, { status: "healthy", service: SERVICE, module_id: MODULE_ID, tier: TIER, bridge: { state: "connected" } });
  if (path === "/v1/state") return send(res, 200, state());
  if (path === "/v1/symbols") return send(res, 200, terminal.symbols());

  if (path === "/v1/ticks") {
    const wanted = (url.searchParams.get("symbols") ?? Object.keys(SYMBOLS).join(","))
      .split(",").map((s) => s.trim()).filter((s) => Object.hasOwn(SYMBOLS, s));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": bridge protocol v1\n\n");
    const timer = setInterval(() => {
      const now = Date.now();
      for (const symbol of wanted) {
        const tick = terminal.tick(symbol, now);
        if (tick) res.write(`data: ${JSON.stringify(tick)}\n\n`);
      }
      lastTickMs = now;
    }, TICK_INTERVAL_MS);
    const heartbeat = setInterval(() => res.write("event: heartbeat\ndata: {}\n\n"), 5_000);
    req.on("close", () => { clearInterval(timer); clearInterval(heartbeat); });
    return undefined;
  }

  if (path === "/v1/candles") {
    const symbol = url.searchParams.get("symbol") ?? "";
    const timeframe = url.searchParams.get("timeframe") ?? "M1";
    const count = Math.min(2_000, Math.max(1, Number(url.searchParams.get("count") ?? 200)));
    if (!Object.hasOwn(SYMBOLS, symbol)) return send(res, 404, { error: "unknown_symbol" });
    return send(res, 200, terminal.candles(symbol, timeframe, count));
  }

  if (path === "/v1/account") return send(res, 200, terminal.account());
  if (path === "/v1/positions") return send(res, 200, terminal.listPositions());
  if (path === "/v1/deals") return send(res, 200, terminal.dealsSince(Number(url.searchParams.get("since") ?? 0)));

  if (path === "/v1/orders" && method === "POST") {
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: "bad_json" });
    const result = terminal.open({ symbol: String(body.symbol ?? ""), type: body.type, volume: String(body.volume ?? ""), comment: typeof body.comment === "string" ? body.comment : "" });
    log("info", "order", { ...result, symbol: body.symbol, type: body.type, volume: body.volume, comment: body.comment });
    return send(res, result.retcode === 10009 ? 200 : 422, result);
  }

  if (path === "/v1/positions/close" && method === "POST") {
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: "bad_json" });
    const result = terminal.close(Number(body.ticket));
    return send(res, result.retcode === 10009 ? 200 : 422, result);
  }

  // Simulator only: a trade that originated on the platform.
  if (path === "/v1/sim/trade" && method === "POST") {
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: "bad_json" });
    const result = terminal.open({ symbol: String(body.symbol ?? ""), type: body.type, volume: String(body.volume ?? ""), comment: typeof body.comment === "string" ? body.comment : "terminal" });
    log("info", "platform-originated trade", { ...result });
    return send(res, result.retcode === 10009 ? 200 : 422, result);
  }

  return send(res, 404, { error: "not_found", path });
});

server.listen(PORT, () => log("info", `listening on 0.0.0.0:${PORT}`, { login: terminal.login, server: terminal.server }));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));

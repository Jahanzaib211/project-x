/**
 * The financial core, as this service reaches it.
 *
 * One place that knows the core's addresses and one function that talks to
 * them. Everything else in this service — accounts, funding, the routes — goes
 * through `forward`, which hands back exactly what the core said, status and
 * all (INV-180: the edge forwards, it does not decide).
 */

import { HttpError } from "./money.js";

export const UPSTREAM = {
  ledger: process.env.LEDGER_URL ?? "http://ledger:8000",
  oms: process.env.OMS_URL ?? "http://oms:8000",
  pricing: process.env.PRICING_URL ?? "http://pricing:8000",
  marketData: process.env.MARKET_DATA_URL ?? "http://market-data:8000",
  feedGateway: process.env.FEED_GATEWAY_URL ?? "http://feed-gateway:8000",
};

/**
 * Forward a request to the core and hand back exactly what it said.
 *
 * The status is preserved rather than translated. A 422 from risk means "your
 * order was refused, and here is which rule refused it"; flattening that to a
 * 400 or a 500 would throw away the only part of the answer a client can act
 * on.
 *
 * @param {string} base
 * @param {string} path
 * @param {{method?: string, body?: unknown, idempotencyKey?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, status: number, body: Record<string, any>}>}
 */
export async function forward(base, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    /** @type {Record<string, string>} */
    const headers = { "content-type": "application/json" };
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  } catch {
    // P7 — fail closed. An edge that cannot reach the core says so, and says
    // which core, rather than returning an empty success.
    throw new HttpError(503, `upstream ${base} unavailable`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forward, and treat anything but success as a 502.
 * @param {string} base
 * @param {string} path
 */
export async function upstream(base, path) {
  const { ok, status, body } = await forward(base, path);
  if (!ok) throw new HttpError(502, `upstream ${base}${path} returned ${status}`);
  return body;
}

/**
 * Lift a core refusal into an HttpError that keeps the core's status and text.
 * @param {{ok: boolean, status: number, body: Record<string, any>}} result
 * @param {string} fallback
 */
export function refusal(result, fallback) {
  const detail = String(result.body.detail ?? result.body.error ?? fallback);
  const error = new HttpError(result.status >= 400 ? result.status : 502, detail);
  error.code = typeof result.body.error === "string" ? result.body.error : undefined;
  return error;
}

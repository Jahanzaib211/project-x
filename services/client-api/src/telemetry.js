/**
 * Per-user telemetry, for the operator console.
 *
 * What each identity has been doing at the edge: requests by endpoint,
 * errors, throttles, orders, the last thing they touched and when. Held in
 * memory as a bounded ring per user — this is operational awareness, not a
 * record, and it is not a balance: nothing here is a financial figure
 * (INV-180). The live figures the console shows beside it (equity, margin
 * level) are read from the ledger at the moment of asking.
 *
 * This is personal data. It is served on the operator surface alone and is
 * never exported to `/metrics`, where a label would turn a person into a
 * time series anybody with the scrape endpoint could read.
 */

/** How many users are tracked at once; the least recently seen is evicted. */
const MAX_USERS = 500;
/** How long the per-minute rates look back. */
const WINDOW_MS = 60_000;
/** Events kept per user for the rates. */
const RING = 240;

/**
 * @typedef {object} Sample
 * @property {number} at
 * @property {string} path
 * @property {string} method
 * @property {number} status
 * @property {number} ms
 */

/**
 * @typedef {object} UserTelemetry
 * @property {string} owner
 * @property {boolean} authenticated
 * @property {number} firstSeen
 * @property {number} lastSeen
 * @property {string} lastPath
 * @property {number} lastStatus
 * @property {number} requests
 * @property {number} errors
 * @property {number} throttled
 * @property {number} orders
 * @property {number} refusedOrders
 * @property {number} streams
 * @property {Sample[]} ring
 */

/** @type {Map<string, UserTelemetry>} */
const users = new Map();

/** Anything that should not become the "endpoint" label: ids, numbers. */
function shape(/** @type {string} */ path) {
  return path
    .replace(/\/\d{6,12}(?=\/|$)/g, "/{account}")
    .replace(/\/[0-9a-f-]{36}(?=\/|$)/g, "/{id}");
}

/**
 * Record one finished request.
 * @param {{owner: string, authenticated: boolean, path: string, method: string, status: number, ms: number}} event
 */
export function record(event) {
  let user = users.get(event.owner);
  const now = Date.now();
  if (!user) {
    if (users.size >= MAX_USERS) {
      let oldest = null;
      for (const candidate of users.values()) {
        if (!oldest || candidate.lastSeen < oldest.lastSeen) oldest = candidate;
      }
      if (oldest) users.delete(oldest.owner);
    }
    user = {
      owner: event.owner, authenticated: event.authenticated, firstSeen: now, lastSeen: now,
      lastPath: "", lastStatus: 0, requests: 0, errors: 0, throttled: 0, orders: 0, refusedOrders: 0, streams: 0, ring: [],
    };
    users.set(event.owner, user);
  }
  const path = shape(event.path);
  user.authenticated = user.authenticated || event.authenticated;
  user.lastSeen = now;
  user.lastPath = `${event.method} ${path}`;
  user.lastStatus = event.status;
  user.requests += 1;
  if (event.status >= 500) user.errors += 1;
  if (event.status === 429) user.throttled += 1;
  if (event.method === "POST" && path === "/v1/orders") {
    if (event.status < 400) user.orders += 1;
    else user.refusedOrders += 1;
  }
  if (path === "/v1/stream") user.streams += 1;
  user.ring.push({ at: now, path, method: event.method, status: event.status, ms: event.ms });
  if (user.ring.length > RING) user.ring.splice(0, user.ring.length - RING);
}

/**
 * The console's view: everyone seen recently, most active first.
 * @param {{limit?: number, activeWithinMs?: number}} [options]
 */
export function snapshot({ limit = 50, activeWithinMs = 15 * 60_000 } = {}) {
  const now = Date.now();
  const rows = [];
  for (const user of users.values()) {
    if (now - user.lastSeen > activeWithinMs) continue;
    const recent = user.ring.filter((s) => s.at >= now - WINDOW_MS);
    /** @type {Record<string, number>} */
    const byEndpoint = {};
    let slowest = 0;
    let totalMs = 0;
    for (const s of recent) {
      byEndpoint[s.path] = (byEndpoint[s.path] ?? 0) + 1;
      slowest = Math.max(slowest, s.ms);
      totalMs += s.ms;
    }
    rows.push({
      owner: user.owner,
      authenticated: user.authenticated,
      lastSeen: new Date(user.lastSeen).toISOString(),
      lastPath: user.lastPath,
      lastStatus: user.lastStatus,
      requests: user.requests,
      requestsPerMinute: recent.length,
      errorsPerMinute: recent.filter((s) => s.status >= 500).length,
      throttledPerMinute: recent.filter((s) => s.status === 429).length,
      ordersPerMinute: recent.filter((s) => s.method === "POST" && s.path === "/v1/orders" && s.status < 400).length,
      orders: user.orders,
      refusedOrders: user.refusedOrders,
      errors: user.errors,
      throttled: user.throttled,
      streams: user.streams,
      meanMs: recent.length ? Math.round(totalMs / recent.length) : 0,
      slowestMs: slowest,
      topEndpoints: Object.entries(byEndpoint).sort((a, b) => b[1] - a[1]).slice(0, 3),
    });
  }
  rows.sort((a, b) => b.requestsPerMinute - a.requestsPerMinute || b.lastSeen.localeCompare(a.lastSeen));
  return { at: new Date(now).toISOString(), tracked: users.size, users: rows.slice(0, limit) };
}

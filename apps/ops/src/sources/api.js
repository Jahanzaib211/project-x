/**
 * The console's one link to the platform.
 *
 * Everything about clients, sessions, accounts and the audit trail comes from
 * `19-client-api`'s operator surface. The console holds no database credential
 * and issues no SQL: "what may an operator see" is decided in one place, by the
 * service that owns the data, rather than re-derived here per screen.
 *
 * The token is attached here and nowhere else. It is never rendered into a
 * page, never sent to the browser, and never appears in a URL.
 */

const API_URL = process.env.API_INTERNAL_URL ?? "http://client-api:8000";
const OPS_TOKEN = process.env.OPS_TOKEN ?? "";

/** Long enough for an operator query over a large table, short enough to fail. */
const TIMEOUT_MS = Number(process.env.OPS_API_TIMEOUT_MS ?? 8_000);

/**
 * Call the operator surface.
 *
 * Never throws on a transport failure. A console that 500s because one panel's
 * upstream is briefly unavailable is a console nobody can use during exactly
 * the incident they opened it for — so this returns the failure as data and the
 * page renders the rest, with that panel saying what went wrong.
 *
 * @param {string} path
 * @param {{method?: string, operator?: string, body?: unknown}} [options]
 * @returns {Promise<{ok: boolean, status: number, body: any, error: string|null}>}
 */
export async function callAdmin(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-ops-token": OPS_TOKEN,
        // Named on every audit row the call produces.
        "x-ops-operator": String(options.operator ?? "operator").slice(0, 80),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      body,
      error: response.ok
        ? null
        // A 404 from this surface means the token was wrong or the surface is
        // switched off — it deliberately does not distinguish the two to an
        // unauthorised caller, and saying so here saves an hour of confusion.
        : response.status === 404
          ? "The operator surface refused this call. Either OPS_TOKEN does not match the API's, or the API has it unset."
          : String(body.error ?? body.detail ?? `the API answered ${response.status}`),
    };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      body: {},
      error:
        error instanceof Error && error.name === "AbortError"
          ? `the client API did not answer within ${TIMEOUT_MS}ms`
          : `the client API is unreachable at ${API_URL}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The platform's own health view, which the console shows beside its own. */
export async function platformStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}/v1/status`, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return { reachable: true, core: body.core ?? {}, tradable: Boolean(body.tradable) };
  } catch {
    return { reachable: false, core: {}, tradable: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Money at the edge.
 *
 * The single rule this file exists to enforce: **money never becomes a
 * JavaScript number.** `Number` is IEEE-754, and the moment an amount passes
 * through one, the exactness the Rust core worked to guarantee is gone.
 *
 * So money crosses this boundary as a decimal string, is validated as a decimal
 * string, and is forwarded as a decimal string. The edge does no arithmetic on
 * it at all — that is the core's job (P8, INV-180).
 */

/**
 * Matches an exact, canonical, non-negative decimal: digits with no leading
 * zero (except a lone `0`), an optional fractional part of up to eight places.
 *
 * No sign. Every amount that crosses this edge is a magnitude — a deposit, a
 * volume — and its direction is the request's kind or side, never a minus
 * sign that a later reader might miss. A negative "deposit" has no meaning
 * the ledger would accept, so it is refused here, at the door.
 */
const DECIMAL = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/;

/**
 * Validate a money string without converting it.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidAmount(value) {
  return typeof value === "string" && DECIMAL.test(value);
}

/**
 * Assert a money string, or throw a client error.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function requireAmount(value, field) {
  if (!isValidAmount(value)) {
    throw new HttpError(
      400,
      `${field} must be an exact decimal string, not a number. ` +
        `Sending money as a JSON number loses precision before it reaches the ledger.`,
    );
  }
  return /** @type {string} */ (value);
}

/** An error carrying an HTTP status. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {{credentialRejected?: boolean}} [options]
   *   `credentialRejected` marks the narrow case where somebody **presented** a
   *   credential and it was wrong: a bad password, a bad TOTP code, a spent
   *   reset link. Only those count against the sign-in failure budget.
   *
   *   The distinction matters because "you did not sign in" is also a 401, and
   *   counting it made the security gate's own authorization matrix — which
   *   works by calling protected endpoints without a session — exhaust the
   *   budget and then fail every check that followed. A real client behind a
   *   shared address with a broken integration would do exactly the same thing
   *   and lock out everyone else on that address.
   */
  constructor(status, message, options = {}) {
    super(message);
    this.status = status;
    this.name = "HttpError";
    this.credentialRejected = options.credentialRejected === true;
    /**
     * A machine-readable code from the core, when the error is a forwarded
     * refusal (e.g. `DEMO_CAP_EXCEEDED`). Undefined for errors raised here.
     * @type {string|undefined}
     */
    this.code = undefined;
  }
}

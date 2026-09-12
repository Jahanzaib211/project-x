/**
 * Shared fixtures.
 *
 * The important one is `demoAccount`: it opens a **fresh** trading account over
 * the real API before each test that asks for one. Tests that share an account
 * share its balance, and then the order they happen to run in decides whether
 * they pass — which is exactly the kind of test that gets deleted six months
 * later for being flaky.
 */

import { test as base, expect } from "@playwright/test";

const API = process.env.API_URL ?? "http://127.0.0.1:27001";

/** A distinct idempotency key per call site. */
let counter = 0;
export const key = (label) => `e2e-${label}-${Date.now()}-${(counter += 1)}`;

export const test = base.extend({
  /**
   * A funded demo account, opened through the client API exactly as the web app
   * would open it.
   * @type {import("@playwright/test").Fixture<{accountNumber: string}>}
   */
  demoAccount: async ({ request }, use, testInfo) => {
    const response = await request.post(`${API}/v1/trading-accounts`, {
      headers: { "idempotency-key": key("open") },
      data: { nickname: testInfo.title.slice(0, 40), leverage: 500 },
    });
    expect(response.ok(), `opening a demo account failed: ${await response.text()}`).toBeTruthy();
    const account = await response.json();
    await use(account);
  },
});

/**
 * The account's state, straight from the core.
 * @param {import("@playwright/test").APIRequestContext} request
 * @param {string} accountNumber
 */
export async function coreState(request, accountNumber) {
  const response = await request.get(`${API}/v1/trading-accounts/${accountNumber}/state`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).valuation;
}

/**
 * The ledger's own invariant monitors.
 * @param {import("@playwright/test").APIRequestContext} request
 */
export async function ledgerInvariants(request) {
  const response = await request.get(
    `${process.env.LEDGER_URL ?? "http://127.0.0.1:27002"}/v1/invariants`,
  );
  return await response.json();
}

/**
 * The instrument's own facts, from the API: digits, commission, limits. The
 * specs derive their expectations from these rather than hard-coding one
 * instrument's numbers, because the instrument traded depends on which market
 * is open when the suite runs.
 * @param {import("@playwright/test").APIRequestContext} request
 * @param {string} symbol
 */
export async function instrument(request, symbol) {
  const response = await request.get(`${API}/v1/instruments`);
  const body = await response.json();
  const found = (body.instruments ?? []).find((/** @type {{symbol: string}} */ i) => i.symbol === symbol);
  if (!found) throw new Error(`the API does not list ${symbol}`);
  return found;
}

/**
 * Commission for a volume in lots, as the ledger charges it: per lot, per
 * side, rounded up to the cent. Integer arithmetic in the test — the page is
 * what must not compute money, not the suite that checks it.
 * @param {{commissionPerLotMinor: number}} inst
 * @param {string} lots Decimal string with up to three places.
 */
export function commissionMinor(inst, lots) {
  const [whole = "0", frac = ""] = lots.split(".");
  const milli = Number(whole) * 1000 + Number((frac + "000").slice(0, 3));
  return Math.ceil((inst.commissionPerLotMinor * milli) / 1000);
}

/** A USD amount in minor units as the decimal string the ledger renders. */
export function usd(minor) {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** The instrument whose market is open for this run (chosen in global setup). */
export const SYMBOL = process.env.E2E_SYMBOL ?? "EURUSD";
/** An instrument whose market is closed right now, or "" if every market is open. */
export const CLOSED_SYMBOL = process.env.E2E_CLOSED_SYMBOL ?? "";

export { expect, API };

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

export { expect, API };

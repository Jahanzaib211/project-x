/**
 * G5 — trading sessions, live (INV-053, INV-084).
 *
 * Whether a market is closed right now depends on the clock; the suite does
 * not pretend otherwise. If some instrument is closed at run time it proves
 * the closed path — frozen quote, disabled ticket, refused order — and the
 * open path is proven by every trade in trading.spec.js. If every market is
 * open, the closed path is proven by the Rust suites at pinned ticks, and
 * this spec says so rather than reporting a pass it did not earn.
 */

import { test, expect, API, CLOSED_SYMBOL, key } from "../fixtures.js";

test.describe("sessions", () => {
  test("every instrument publishes its session, and a closed one is frozen and refuses orders", async ({ page, request, demoAccount }) => {
    const sessions = await (await request.get(`${API}/v1/sessions`)).json();
    expect(sessions.sessions.length).toBeGreaterThanOrEqual(5);
    for (const row of sessions.sessions) {
      expect(typeof row.session.open).toBe("boolean");
      expect(row.session.hours.length).toBeGreaterThan(0);
    }
    // Crypto never closes.
    expect(sessions.sessions.find((s) => s.symbol === "BTCUSD").session.open).toBe(true);

    test.skip(!CLOSED_SYMBOL, "every market is open right now — the closed path is proven at pinned ticks in the Rust suites");

    const account = demoAccount.accountNumber;
    await page.goto(`/terminal?account=${account}&symbol=${CLOSED_SYMBOL}`);
    await expect(page.locator("[data-terminal]")).toHaveAttribute("data-session-open", "false");
    await expect(page.locator("[data-session-banner]")).toBeVisible();
    await expect(page.locator("[data-session-banner]")).toContainText("Market closed");
    await expect(page.locator("[data-buy]")).toBeDisabled();
    await expect(page.locator("[data-sell]")).toBeDisabled();
    await expect(page.locator("[data-quote-age]")).toHaveText("frozen");

    // The API refuses too — the button being disabled is not the control.
    const refused = await request.post(`${API}/v1/orders`, {
      headers: { "idempotency-key": key("closed") },
      data: { account, symbol: CLOSED_SYMBOL, side: "BUY", volume: "0.10" },
    });
    expect(refused.status()).toBe(422);
    const body = await refused.json();
    expect(body.error).toBe("MARKET_CLOSED");
  });
});

/**
 * Trade execution, through the browser, against the real core.
 *
 * This is the suite the whole build exists to satisfy: a person opens a demo
 * account, places an order, sees the fill, watches the P&L move, and closes the
 * position — with the ledger balancing at every step.
 */

import { test, expect, coreState, ledgerInvariants } from "../fixtures.js";

/** The figure shown when the core has no value to report (INV-183). */
const ABSENT = "—";

test.describe("placing and closing a trade", () => {
  test("a demo account opens funded, flat, and with no margin level", async ({
    page,
    demoAccount,
  }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}`);

    await expect(page.locator("[data-balance]")).toHaveText("10000.00");
    await expect(page.locator("[data-equity]")).toHaveText("10000.00");
    await expect(page.locator("[data-used-margin]")).toHaveText("0.00");

    // Nothing is open, so there is no margin level. Blank, not zero: a zero
    // would read as "about to be liquidated" (INV-072, INV-183).
    await expect(page.locator("[data-margin-level]")).toHaveText(ABSENT);
    await expect(page.locator("[data-positions-empty]")).toBeVisible();
  });

  test("a market order fills, opens a position and moves the balance", async ({
    page,
    request,
    demoAccount,
  }) => {
    const account = demoAccount.accountNumber;
    await page.goto(`/terminal?account=${account}`);
    await expect(page.locator("[data-balance]")).toHaveText("10000.00");

    await page.locator("[data-volume]").fill("0.10");
    await page.locator("[data-buy]").click();

    // The ticket reports what the core said.
    await expect(page.locator("[data-ticket-note]")).toContainText(/BUY 0\.10 EURUSD/);
    await expect(page.locator("[data-ticket-note]")).toHaveAttribute("data-tone", "ok");

    // A position appears, on the right side, for the right size.
    const position = page.locator('[data-position="EURUSD"]');
    await expect(position).toBeVisible();
    await expect(position.locator(".badge")).toHaveText("BUY");
    await expect(position).toContainText("0.100");
    await expect(page.locator("[data-positions-count]")).toHaveText("1 open");

    // The order shows as filled in the blotter.
    await expect(page.locator("[data-orders] [data-order-state]").first()).toHaveText("FILLED");

    // Commission came out of the balance. The page did not compute that — the
    // ledger did, and the page is showing what the ledger said.
    await expect(page.locator("[data-balance]")).toHaveText("9999.65");

    // Margin is now in use, so a margin level exists where it did not before.
    await expect(page.locator("[data-used-margin]")).not.toHaveText("0.00");
    await expect(page.locator("[data-margin-level]")).not.toHaveText(ABSENT);

    // And the core agrees with the screen.
    const state = await coreState(request, account);
    expect(state.balance).toBe("9999.65");
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0].symbol).toBe("EURUSD");
    expect(state.positions[0].side).toBe("BUY");
    expect(state.positions[0].volume).toBe("0.100");
  });

  test("unrealised P&L moves with the market", async ({ page, demoAccount }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}`);
    await page.locator("[data-volume]").fill("0.50");
    await page.locator("[data-buy]").click();

    const pnl = page.locator('[data-position="EURUSD"] [data-position-pnl]');
    await expect(pnl).toBeVisible();
    const first = await pnl.textContent();

    // The account is refreshed every two seconds and the mark moves every 250ms.
    await expect
      .poll(async () => await pnl.textContent(), {
        message: "the P&L never moved — the position is not being marked",
        timeout: 25_000,
      })
      .not.toBe(first);

    // Equity tracks it: equity is balance plus unrealised (INV-070).
    await expect(page.locator("[data-equity]")).not.toHaveText("10000.00");
    await expect(page.locator("[data-unrealised]")).not.toHaveText(ABSENT);
  });

  test("closing the position flattens the account and settles the result", async ({
    page,
    request,
    demoAccount,
  }) => {
    const account = demoAccount.accountNumber;
    await page.goto(`/terminal?account=${account}`);
    await page.locator("[data-volume]").fill("0.10");
    await page.locator("[data-buy]").click();
    await expect(page.locator('[data-position="EURUSD"]')).toBeVisible();

    await page.locator('[data-close-position="EURUSD"]').click();

    // Flat again: no position, no margin, and no margin level (INV-043).
    await expect(page.locator("[data-positions-empty]")).toBeVisible();
    await expect(page.locator("[data-positions-count]")).toHaveText("0 open");
    await expect(page.locator("[data-used-margin]")).toHaveText("0.00");
    await expect(page.locator("[data-margin-level]")).toHaveText(ABSENT);
    await expect(page.locator("[data-unrealised]")).toHaveText("0.00");

    // Two orders now: the open and the close.
    await expect(page.locator("[data-orders] tr")).toHaveCount(2);

    // Balance is the round trip: opening commission, the realised result, and
    // the closing commission. Equity equals it, because nothing is open.
    const state = await coreState(request, account);
    expect(state.positions).toHaveLength(0);
    expect(state.equity).toBe(state.balance);
    expect(state.marginLevel).toBeNull();
    await expect(page.locator("[data-balance]")).toHaveText(state.balance);
  });

  test("the ledger balances after every trade", async ({ page, request, demoAccount }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}`);

    for (const volume of ["0.10", "0.25", "1.00"]) {
      await page.locator("[data-volume]").fill(volume);
      await page.locator("[data-buy]").click();
      await expect(page.locator("[data-ticket-note]")).toHaveAttribute("data-tone", "ok");
    }
    await expect(page.locator('[data-position="EURUSD"]')).toBeVisible();
    await page.locator('[data-close-position="EURUSD"]').click();
    await expect(page.locator("[data-positions-empty]")).toBeVisible();

    // INV-020 and INV-023, asked of the ledger itself rather than inferred.
    const invariants = await ledgerInvariants(request);
    expect(invariants["INV-020_imbalanced_transactions"]).toBe(0);
    expect(invariants["INV-023_projection_drift"]).toBe(0);
    expect(invariants.healthy).toBe(true);
  });

  test("selling opens a short, and it profits the other way round", async ({
    page,
    request,
    demoAccount,
  }) => {
    const account = demoAccount.accountNumber;
    await page.goto(`/terminal?account=${account}`);
    await page.locator("[data-volume]").fill("0.20");
    await page.locator("[data-sell]").click();

    const position = page.locator('[data-position="EURUSD"]');
    await expect(position.locator(".badge")).toHaveText("SELL");

    const state = await coreState(request, account);
    expect(state.positions[0].side).toBe("SELL");
    // A short is marked against the mid like any other position, so its opening
    // P&L is the half-spread against it — negative, not zero.
    expect(state.positions[0].unrealised.startsWith("-")).toBeTruthy();
  });
});

/**
 * INV-190 / INV-191 — the interface owns no financial truth.
 *
 * The terminal must render figures the core produced and must not compute any
 * of its own. That is hard to prove in general, so these tests prove the
 * observable consequences: every figure on screen is byte-identical to one the
 * API returned, and the page keeps saying "no figure" where the core has none
 * rather than substituting a zero.
 */

import { test, expect, coreState, API, SYMBOL, instrument } from "../fixtures.js";

const ABSENT = "—";

test.describe("the page owns no financial truth", () => {
  test("every figure on screen is exactly what the core returned", async ({
    page,
    request,
    demoAccount,
  }) => {
    const account = demoAccount.accountNumber;
    await page.goto(`/terminal?account=${account}&symbol=${SYMBOL}`);
    await page.locator("[data-volume]").fill("0.30");
    await page.locator("[data-buy]").click();
    await expect(page.locator(`[data-position="${SYMBOL}"]`)).toBeVisible();

    // Close, so the account is static and the comparison is not a race against
    // the next tick.
    await page.locator(`[data-close-position="${SYMBOL}"]`).click();
    await expect(page.locator("[data-positions-empty]")).toBeVisible();

    const state = await coreState(request, account);
    // Balance and equity are settled now, so they can be compared exactly.
    await expect(page.locator("[data-balance]")).toHaveText(state.balance);
    await expect(page.locator("[data-equity]")).toHaveText(state.equity);
    await expect(page.locator("[data-used-margin]")).toHaveText(state.usedMargin);
    await expect(page.locator("[data-free-margin]")).toHaveText(state.freeMargin);
    await expect(page.locator("[data-unrealised]")).toHaveText(state.unrealised);
  });

  test("an absent figure stays absent — it never becomes a zero", async ({
    page,
    request,
    demoAccount,
  }) => {
    const account = demoAccount.accountNumber;
    await page.goto(`/terminal?account=${account}&symbol=${SYMBOL}`);

    // With nothing open, the core reports no margin level at all.
    const state = await coreState(request, account);
    expect(state.marginLevel, "the core should report no margin level").toBeNull();
    await expect(page.locator("[data-margin-level]")).toHaveText(ABSENT);
    await expect(page.locator("[data-margin-level]")).not.toHaveText("0.00");
    await expect(page.locator("[data-margin-level]")).not.toHaveText("0");
  });

  test("prices are rendered at the instrument's own precision, unrounded", async ({
    page,
    request,
    demoAccount,
  }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}&symbol=${SYMBOL}`);
    await page.locator("[data-volume]").fill("0.10");
    await page.locator("[data-buy]").click();

    const row = page.locator(`[data-position="${SYMBOL}"]`);
    await expect(row).toBeVisible();

    // Exactly the instrument's own digits — five for a major pair, two for
    // gold or bitcoin — not four, not the six a naive float format would
    // produce. The open and mark cells are the prices; volume has three
    // places and is excluded by matching on the digits.
    const inst = await instrument(request, SYMBOL);
    const open = await row.locator("td.mono").nth(2).textContent();
    const mark = await row.locator("[data-position-mark]").textContent();
    const exact = new RegExp(`^\\d+\\.\\d{${inst.digits}}$`);
    for (const price of [open, mark]) {
      expect(price, `${price} is not quoted to ${inst.digits} places`).toMatch(exact);
    }
  });

  test("money crosses the wire as strings, never as JSON numbers", async ({
    request,
    demoAccount,
  }) => {
    const account = demoAccount.accountNumber;
    const response = await request.get(`${API}/v1/trading-accounts/${account}/state`);
    const raw = await response.text();

    // A JSON number for an amount would look like `"balance":10000` here. Every
    // amount must be quoted, or its exactness is already gone (P1, INV-001).
    for (const field of [
      "balance",
      "equity",
      "unrealised",
      "usedMargin",
      "freeMargin",
    ]) {
      expect(raw, `${field} was sent as a JSON number`).toMatch(
        new RegExp(`"${field}":"[-0-9.]+"`),
      );
    }
  });

  test("the terminal renders without JavaScript, and simply stops updating", async ({
    browser,
    demoAccount,
  }) => {
    // The page is server-rendered; the script is an upgrade, not a requirement.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`/terminal?account=${demoAccount.accountNumber}&symbol=${SYMBOL}`);

    await expect(page.locator("[data-terminal]")).toBeVisible();
    await expect(page.locator("[data-balance]")).toHaveText("10000.00");
    await expect(page.locator("[data-positions-empty]")).toBeVisible();
    await expect(page.locator("[data-symbol-select]")).toBeVisible();

    await context.close();
  });
});

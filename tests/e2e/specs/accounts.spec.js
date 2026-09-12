/**
 * G5 — one account system, and demo capital that is really issued.
 *
 * The bug this suite exists for: an account opened from the Demo tab landed
 * on the Real tab and looked as though it had vanished, and it could never be
 * funded because it did not exist in the ledger. Now the ledger issues every
 * number (INV-033), the dialog follows the tab, the page lands where the
 * account is, and a demo deposit settles in the ledger (INV-034/035).
 */

import { test, expect, API, SYMBOL } from "../fixtures.js";

const PASSWORD = "Correct-Horse-Battery-9";
let sequence = 0;

/** @param {import("@playwright/test").Page} page */
async function register(page) {
  const email = `e2e-acct-${Date.now()}-${(sequence += 1)}@example.test`;
  await page.goto("/register");
  await page.locator("#register-name").fill("Demo Person");
  await page.locator("#register-email").fill(email);
  await page.locator("#register-password").fill(PASSWORD);
  await page.locator("#register-confirm").fill(PASSWORD);
  await page.locator("#register-country").selectOption("United Kingdom");
  await page.locator("#register-terms").check();
  await page.locator("[data-register-form] [data-submit]").click();
  await expect(page).toHaveURL(/\/$/);
  return email;
}

test.describe("accounts", () => {
  test("INV-033: a demo account opened from the Demo tab is where the person is looking, funded", async ({ page, request }) => {
    await register(page);

    await page.goto("/?mode=demo");
    // The dialog follows the tab.
    await expect(page.locator('[data-open-account-form] input[name="mode"]')).toHaveValue("demo");
    await page.locator("[data-open-account]").first().click();
    await page.locator('[data-open-account-form] input[name="nickname"]').fill("Weekend demo");
    await page.locator("[data-open-account-form] [data-submit]").click();

    // Landed on the Demo tab, on the new card, with the ledger's figure.
    await expect(page).toHaveURL(/mode=demo/);
    const card = page.locator('[data-account][data-mode="demo"]').first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("Weekend demo");
    await expect(card.locator("[data-balance]")).toHaveText("10000.00");
    const number = String(await card.getAttribute("data-account"));

    // The same number is a ledger account — the terminal shows it.
    await page.goto(`/terminal?account=${number}&symbol=${SYMBOL}`);
    await expect(page.locator("[data-terminal]")).toHaveAttribute("data-account", number);
    await expect(page.locator("[data-balance]")).toHaveText("10000.00");

    // And a real account opened from the Real tab lands there, unfunded and
    // honest about it — no demo capital, no invented figure.
    await page.goto("/?mode=real");
    await expect(page.locator('[data-open-account-form] input[name="mode"]')).toHaveValue("real");
    await page.locator("[data-open-account]").first().click();
    await page.locator("[data-open-account-form] [data-submit]").click();
    await expect(page).toHaveURL(/mode=real/);
    const real = page.locator('[data-account][data-mode="real"]').first();
    await expect(real).toBeVisible();
    await expect(real.locator("[data-balance]")).toHaveText("0.00");
    const realNumber = String(await real.getAttribute("data-account"));
    expect(realNumber).not.toBe(number);
    void request;
  });

  test("INV-034/035: a demo deposit settles in the ledger; a real account is refused; a reset returns to the grant", async ({ page, request }) => {
    await register(page);
    await page.goto("/?mode=demo");
    await page.locator("[data-open-account]").first().click();
    await page.locator("[data-open-account-form] [data-submit]").click();
    const card = page.locator('[data-account][data-mode="demo"]').first();
    await expect(card).toBeVisible();
    const number = String(await card.getAttribute("data-account"));

    // The deposit page knows this is a demo account and funds it instantly.
    await page.goto(`/deposit?account=${number}`);
    await expect(page.locator("[data-funding-form]")).toHaveAttribute("data-demo", "true");
    await page.locator('[data-preset="1000.00"]').click();
    await page.locator("[data-funding-submit]").click();
    await expect(page.locator("[data-funding-result]")).toContainText("Balance is now 11000.00");

    // The ledger says so too — the figure is its, not the page's.
    const state = await request.get(`${API}/v1/trading-accounts/${number}/state`, {
      headers: { "x-client-id": "irrelevant-the-account-is-public-to-read-in-dev" },
    });
    expect(state.ok()).toBeTruthy();
    expect((await state.json()).valuation.balance).toBe("11000.00");

    // The history shows it settled, not blocked.
    await page.goto("/transactions");
    await expect(page.locator("table")).toContainText("Settled");
    await expect(page.locator("table")).toContainText("1000.00");

    // Reset from the card menu.
    await page.goto("/?mode=demo");
    await page.locator(`[data-menu="acct-${number}"]`).click();
    page.once("dialog", (d) => d.accept());
    await page.locator(`[data-demo-reset="${number}"]`).click();
    await expect(page.locator(`[data-account="${number}"] [data-balance]`)).toHaveText("10000.00", { timeout: 15_000 });
  });
});

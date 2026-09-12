/**
 * G5 — the chart suite and the live stream.
 *
 * The vendored library mounts, draws the history the API served, follows the
 * symbol and interval, takes an indicator, and keeps its newest candle moving
 * from the event stream — while every figure the page *shows* is still the
 * API's string (INV-191).
 */

import { test, expect, SYMBOL } from "../fixtures.js";

test.describe("chart suite", () => {
  test("mounts over the fallback, draws the API's candles, and goes live", async ({ page, demoAccount }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}&symbol=${SYMBOL}&interval=1m`);
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-chart-suite-state", "active");
    await expect(page.locator("[data-chart-host]")).toHaveClass(/suite-active/);
    await expect.poll(async () => Number(await page.locator("[data-chart-host]").getAttribute("data-candles"))).toBeGreaterThan(50);
    expect(await page.locator("[data-chart-suite] canvas").count()).toBeGreaterThan(0);
    await expect(html).toHaveAttribute("data-stream", "live", { timeout: 15_000 });
    await expect(page.locator("[data-chart-source]")).toContainText("source:");

    // An interval change reloads the history at that interval.
    await page.locator('[data-interval-btn="5m"]').click();
    await expect(page.locator("[data-terminal]")).toHaveAttribute("data-interval", "5m");
    await expect.poll(async () => Number(await page.locator("[data-chart-host]").getAttribute("data-candles"))).toBeGreaterThan(10);

    // An indicator is added to the chart without a page reload.
    await page.evaluate(() => {
      const box = /** @type {HTMLInputElement} */ (document.querySelector('[data-indicator="RSI"]'));
      box.checked = true;
      box.dispatchEvent(new Event("change"));
    });
    await expect.poll(async () => page.locator("[data-chart-suite] canvas").count()).toBeGreaterThan(4);

    // The newest candle's close follows the quote: the stream is moving it.
    const before = await page.locator("[data-chart-host]").getAttribute("data-last");
    await expect.poll(async () => page.locator("[data-chart-host]").getAttribute("data-last"), { timeout: 20_000 }).not.toBe(before);

    // INV-191: what is shown is the API's own string, not a rendering of a
    // number — the bid is a decimal with the instrument's own digits.
    await expect(page.locator("[data-bid]")).toHaveText(/^\d+\.\d+$/);
  });
});

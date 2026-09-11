/**
 * The live chart.
 *
 * A candlestick chart is drawn into a canvas, which a browser test cannot read
 * pixel by pixel in any meaningful way. So the chart publishes what it drew —
 * `data-candles` and `data-last` on its host — and these tests assert on those.
 * That is not a testing convenience bolted on: a chart that renders an empty
 * canvas looks identical to a working one in a screenshot, and without this the
 * suite could not tell the difference either.
 */

import { test, expect } from "../fixtures.js";

test.describe("the price chart", () => {
  test("draws real candles for the default instrument", async ({ page, demoAccount }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}`);

    const host = page.locator("[data-chart-host]");
    await expect(host).toBeVisible();

    // Candles arrive from the market-data service, not from a fixture.
    await expect
      .poll(async () => Number(await host.getAttribute("data-candles")), {
        message: "the chart never plotted a candle",
      })
      .toBeGreaterThan(50);

    // The canvas is really sized and really drawn on.
    const canvas = page.locator("[data-chart]");
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(400);
    expect(box?.height ?? 0).toBeGreaterThan(200);

    const painted = await canvas.evaluate((element) => {
      const c = /** @type {HTMLCanvasElement} */ (element);
      const context = c.getContext("2d");
      if (!context) return 0;
      const { data } = context.getImageData(0, 0, c.width, c.height);
      // Count opaque pixels. A cleared canvas has none.
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque += 1;
      return opaque;
    });
    expect(painted, "the canvas was sized but nothing was drawn on it").toBeGreaterThan(2000);

    // The loading state is gone once there is something to show.
    await expect(page.locator("[data-chart-empty]")).toBeHidden();
  });

  test("keeps ticking — the price moves without a reload", async ({ page, demoAccount }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}`);

    const bid = page.locator("[data-bid]");
    await expect(bid).not.toHaveText("—");
    const first = await bid.textContent();

    // The feed ticks every 250ms and the page polls at 800ms. If this never
    // changes, the chart is a screenshot.
    await expect
      .poll(async () => await bid.textContent(), {
        message: "the quote never changed — the feed is not live",
        timeout: 20_000,
      })
      .not.toBe(first);

    // The ask moves with it, and the two never cross (INV-061).
    const quoted = await page.evaluate(() => ({
      bid: document.querySelector("[data-bid]")?.textContent ?? "",
      ask: document.querySelector("[data-ask]")?.textContent ?? "",
    }));
    expect(quoted.bid).not.toBe("—");
    expect(quoted.ask).not.toBe("—");
    expect(
      Number(quoted.bid.replace(".", "")) <= Number(quoted.ask.replace(".", "")),
      `bid ${quoted.bid} exceeded ask ${quoted.ask}`,
    ).toBeTruthy();
  });

  test("the last candle grows rather than being rewritten", async ({ page, demoAccount }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}`);
    const host = page.locator("[data-chart-host]");
    await expect.poll(async () => Number(await host.getAttribute("data-candles"))).toBeGreaterThan(0);

    const before = await host.getAttribute("data-last");
    await expect
      .poll(async () => await host.getAttribute("data-last"), {
        message: "the live candle never moved",
        timeout: 20_000,
      })
      .not.toBe(before);
  });

  test("switching instrument redraws with that instrument's precision", async ({
    page,
    demoAccount,
  }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}`);
    const host = page.locator("[data-chart-host]");
    await expect.poll(async () => Number(await host.getAttribute("data-candles"))).toBeGreaterThan(0);

    // EURUSD quotes to five places; gold quotes to two. If the page were
    // formatting prices itself, this is where it would get it wrong.
    await expect(page.locator("[data-bid]")).toHaveText(/^\d+\.\d{5}$/);

    await page.locator("[data-symbol-select]").selectOption("XAUUSD");
    await expect(page.locator("[data-bid]")).toHaveText(/^\d+\.\d{2}$/, { timeout: 20_000 });
    await expect.poll(async () => Number(await host.getAttribute("data-candles"))).toBeGreaterThan(0);
  });

  test("switching interval reloads the window", async ({ page, demoAccount }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}`);
    const host = page.locator("[data-chart-host]");
    await expect.poll(async () => Number(await host.getAttribute("data-candles"))).toBeGreaterThan(0);

    await page.locator('[data-interval-btn="5s"]').click();
    await expect(page.locator('[data-interval-btn="5s"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-interval-btn="1m"]')).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => Number(await host.getAttribute("data-candles"))).toBeGreaterThan(0);
  });
});

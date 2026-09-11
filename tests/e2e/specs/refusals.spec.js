/**
 * What the terminal does when the answer is no.
 *
 * A trading interface is judged on its refusals as much as its fills. Every
 * case here asserts two things: the client is told *which rule* refused them,
 * and nothing was booked.
 */

import { test, expect, coreState } from "../fixtures.js";

test.describe("orders that are refused", () => {
  test("an order beyond the account's margin is refused with the reason", async ({
    page,
    request,
    demoAccount,
  }) => {
    const account = demoAccount.accountNumber;
    await page.goto(`/terminal?account=${account}`);
    await expect(page.locator("[data-balance]")).toHaveText("10000.00");

    // 49 lots is inside the venue's size limit but needs about 10 633 of
    // margin, which a 10 000 account does not have.
    await page.locator("[data-volume]").fill("49.00");
    await page.locator("[data-buy]").click();

    const note = page.locator("[data-ticket-note]");
    await expect(note).toHaveAttribute("data-tone", "error");
    await expect(note).toContainText(/free margin/i);

    // Nothing was booked, and the balance is untouched.
    await expect(page.locator("[data-positions-empty]")).toBeVisible();
    await expect(page.locator("[data-balance]")).toHaveText("10000.00");
    const state = await coreState(request, account);
    expect(state.positions).toHaveLength(0);
    expect(state.balance).toBe("10000.00");
  });

  test("an order above the venue's size limit is refused before it is priced", async ({
    page,
    demoAccount,
  }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}`);
    await page.locator("[data-volume]").fill("500.00");
    await page.locator("[data-buy]").click();

    const note = page.locator("[data-ticket-note]");
    await expect(note).toHaveAttribute("data-tone", "error");
    await expect(note).toContainText(/maximum/i);
    await expect(page.locator("[data-positions-empty]")).toBeVisible();
  });

  test("an order below the minimum size is refused", async ({ page, demoAccount }) => {
    await page.goto(`/terminal?account=${demoAccount.accountNumber}`);
    await page.locator("[data-volume]").fill("0.005");
    await page.locator("[data-buy]").click();

    const note = page.locator("[data-ticket-note]");
    await expect(note).toHaveAttribute("data-tone", "error");
    await expect(note).toContainText(/minimum/i);
    await expect(page.locator("[data-positions-empty]")).toBeVisible();
  });

  test("a malformed volume never leaves the browser", async ({ page, request, demoAccount }) => {
    const account = demoAccount.accountNumber;
    await page.goto(`/terminal?account=${account}`);

    /** @type {string[]} */
    const posted = [];
    page.on("request", (request_) => {
      if (request_.method() === "POST" && request_.url().includes("/api/v1/orders")) {
        posted.push(request_.url());
      }
    });

    for (const bad of ["", "abc", "0.0001", "-1"]) {
      await page.locator("[data-volume]").fill(bad);
      await page.locator("[data-buy]").click();
      await expect(page.locator("[data-ticket-note]")).toHaveAttribute("data-tone", "error");
    }

    expect(posted, "a malformed volume was sent to the API").toHaveLength(0);
    const state = await coreState(request, account);
    expect(state.balance).toBe("10000.00");
  });

  test("closing a position that is not there says so and books nothing", async ({
    page,
    request,
    demoAccount,
  }) => {
    const account = demoAccount.accountNumber;
    const response = await request.post("http://127.0.0.1:27001/v1/positions/close", {
      headers: { "idempotency-key": `e2e-nothing-${Date.now()}` },
      data: { account, symbol: "EURUSD" },
    });
    expect(response.status()).toBe(422);
    expect(await response.text()).toContain("NOTHING_TO_CLOSE");

    await page.goto(`/terminal?account=${account}`);
    await expect(page.locator("[data-balance]")).toHaveText("10000.00");
  });
});

test.describe("retries", () => {
  test("submitting the same order id twice produces one order", async ({ request, demoAccount }) => {
    const account = demoAccount.accountNumber;
    const idempotencyKey = `e2e-retry-${Date.now()}`;
    const order = {
      account,
      symbol: "EURUSD",
      side: "BUY",
      volume: "0.10",
    };

    const first = await request.post("http://127.0.0.1:27001/v1/orders", {
      headers: { "idempotency-key": idempotencyKey },
      data: order,
    });
    expect(first.ok()).toBeTruthy();

    // The same key again — a client retrying after a timeout it never saw.
    const second = await request.post("http://127.0.0.1:27001/v1/orders", {
      headers: { "idempotency-key": idempotencyKey },
      data: order,
    });
    expect(second.ok()).toBeTruthy();

    // One position, one order, one commission (INV-091, INV-102).
    const state = await coreState(request, account);
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0].volume).toBe("0.100");
    expect(state.balance).toBe("9999.65");

    const orders = await request.get(`http://127.0.0.1:27001/v1/orders?account=${account}`);
    expect((await orders.json()).orders).toHaveLength(1);
  });
});

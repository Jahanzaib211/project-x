/**
 * G5 — the end-to-end gate for `19-client-api` and `20-web`.
 *
 * These tests drive a real browser against the whole stack: the web app, the
 * client API, the OMS, the ledger, pricing and market data, all built from this
 * working tree. Nothing is stubbed. A pass here means a person can open a demo
 * account, watch a live chart, place an order, see the fill, watch the P&L move
 * and close the position — which is the claim the suite exists to check.
 *
 * The stack is started by `global-setup.js` with an **empty journal**, so every
 * run begins from genesis and account numbers are predictable.
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.PORT_WEB ?? "27000";

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./global-setup.js",
  globalTeardown: "./global-teardown.js",

  // One worker, in order. These tests share one financial core; running them in
  // parallel would have them competing over the same journal, and a flaky
  // financial test is worse than no financial test.
  fullyParallel: false,
  workers: 1,

  // No retries. A trading flow that only passes on the second attempt has told
  // you something, and retrying would throw it away.
  retries: 0,
  forbidOnly: !!process.env.CI,

  // Prices move on a 250ms tick, so a few seconds is generous for anything
  // waiting on the market, and long enough that a slow machine is not a failure.
  timeout: 60_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // The reserved block is bound to loopback only; nothing here talks to the
    // outside world, and a test that tried to would fail rather than reach it.
    bypassCSP: false,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

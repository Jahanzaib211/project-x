/**
 * Start the whole stack from this working tree, from an empty journal.
 *
 * Starting from genesis matters: the ledger's account numbers come off a
 * sequence, and a suite that asserted on "some account that already existed"
 * would pass or fail depending on what a developer did yesterday.
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../..");
export const JOURNAL = resolve(REPO_ROOT, ".run/e2e-journal.log");
export const FEED_LOG = resolve(REPO_ROOT, ".run/e2e-feed.log");

export default async function globalSetup() {
  // A fresh journal and a fresh feed record. Both services replay whatever is
  // here at startup, so removing them is what "start from genesis" means.
  rmSync(JOURNAL, { force: true });
  rmSync(FEED_LOG, { force: true });

  execFileSync(resolve(REPO_ROOT, "scripts/dev_stack.sh"), ["start"], {
    cwd: REPO_ROOT,
    env: { ...process.env, LEDGER_JOURNAL_PATH: JOURNAL, FEED_LOG_PATH: FEED_LOG, FRESH_DB: "true" },
    stdio: "inherit",
    timeout: 300_000,
  });

  // The instrument the trading specs use is one whose market is open *now*.
  // FX and metals close for the weekend (INV-053); a suite that traded EURUSD
  // on a Saturday would be proving the session rule rather than the fill. The
  // choice is published to every worker through the environment.
  const api = process.env.API_URL ?? "http://127.0.0.1:27001";
  let open = "EURUSD";
  let closed = "";
  try {
    const response = await fetch(`${api}/v1/sessions`);
    const body = await response.json();
    const sessions = body.sessions ?? [];
    const first = sessions.find((s) => s.session?.open && ["EURUSD", "XAUUSD", "BTCUSD"].includes(s.symbol));
    if (first) open = first.symbol;
    closed = sessions.find((s) => s.session && !s.session.open)?.symbol ?? "";
  } catch {
    /* the stack answers or the suite fails loudly on its first request */
  }
  process.env.E2E_SYMBOL = open;
  process.env.E2E_CLOSED_SYMBOL = closed;
  process.stdout.write(`  trading on ${open}${closed ? ` (closed now: ${closed})` : " (every market open)"}\n`);
}

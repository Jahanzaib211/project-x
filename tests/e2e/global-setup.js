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

export default function globalSetup() {
  // A fresh journal. The ledger replays whatever is here at startup, so
  // removing it is what "start from genesis" means.
  rmSync(JOURNAL, { force: true });

  execFileSync(resolve(REPO_ROOT, "scripts/dev_stack.sh"), ["start"], {
    cwd: REPO_ROOT,
    env: { ...process.env, LEDGER_JOURNAL_PATH: JOURNAL },
    stdio: "inherit",
    timeout: 300_000,
  });
}

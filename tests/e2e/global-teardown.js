/**
 * Stop what `global-setup.js` started.
 *
 * The journal is deliberately left behind: when a test fails, what the ledger
 * actually recorded is the first thing worth reading.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { REPO_ROOT, JOURNAL } from "./global-setup.js";

export default function globalTeardown() {
  execFileSync(resolve(REPO_ROOT, "scripts/dev_stack.sh"), ["stop"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: 60_000,
  });
  console.log(`\njournal kept for inspection: ${JOURNAL}`);
}

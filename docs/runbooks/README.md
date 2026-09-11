# Runbooks

Procedures for when something needs doing under pressure. Written to be followed
by someone who did not write the system, at 3am.

| Runbook | When |
|---|---|
| [release.md](release.md) | Shipping a change to production |
| [financial-discrepancy.md](financial-discrepancy.md) | An invariant monitor fired, or reconciliation found an unexplained break |
| [emergency-change.md](emergency-change.md) | A change must ship faster than the normal path allows |

Every alert links to the runbook that resolves it. An alert without a runbook is
a defect in the alert.

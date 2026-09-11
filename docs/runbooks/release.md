# Runbook — Release

## Before you start

```bash
make check                       # DAG, gate rule, docs fresh, no regressions, coverage
python3 scripts/check_gates.py --strict
```

If any module in the release is `BLOCKED`, stop. Releasing a module whose
dependencies are unproven is the failure the gate model exists to prevent.

## 1. Identify the artifact

Releases refer to an **artifact digest**, never a branch or a tag. What was
tested is what deploys; nothing is rebuilt per environment.

```
digest: sha256:…
modules: <registry ids>
tier: <highest tier touched>
```

## 2. Gate status

Every gate the modules declare must be green **on this digest**:

| Tier | Required |
|---|---|
| T0 | G0–G9, replay clean, chaos clean, reconciliation clean |
| T1 | G0–G9, performance vs. baseline |
| T2 | G0–G8, reconciliation clean |
| T3 | G0–G5, G8 |
| T4 | G0–G5, G8 |

## 3. Staging (G10)

- Deploy the digest.
- Drive synthetic order flow through the full path.
- Run a full historical replay against staging.
- Reconcile across the staging window: **zero unexplained discrepancies**.
- Soak without burning error budget.

## 4. Approval

| Tier | Approver |
|---|---|
| T0 | Two financial-core owners |
| T1 | Market-infra owner |
| T2 | Financial-ops owner, reconciliation confirmed clean |
| T3 | Compliance owner |
| T4 | Automated |

Approval is recorded against the digest. Changes to the ledger, risk, margin,
P&L, execution, pricing or liquidation **always** require a human, even with
every gate green — those modules can be wrong in ways no test encodes.

## 5. Canary (G11)

- Deploy to a limited slice.
- **Shadow-diff** the new version against the incumbent on identical input. For
  pricing and risk — pure functions — any difference is either an intended change
  or a bug. There is no third possibility, and "probably fine" is not a finding.
- Watch: invariant monitors, error rate, latency, reconciliation breaks.
- **Automatic rollback on any invariant violation.**

## 6. Production (G12)

- Progressive rollout, one module at a time for T0. Never batch T0 modules.
- Post-deploy invariant and reconciliation watch.
- Rollback rehearsed and one command away.

## Rollback

```bash
# Roll back to the previous digest. Never patch a running container.
```

Automatic triggers: any invariant monitor violation, reconciliation breaks above
threshold, error-budget burn beyond budget.

**Migrations are the constraint on rollback.** Every migration is
backward-compatible for at least one release — expand, deploy, migrate, contract
later. G5 tests migrations up and down; a migration that cannot be rolled back is
a design error, not a deployment risk to be accepted.

## Record it

`CHANGELOG.md` entry with modules, gates passed, artifact digest, approver, and
invariant impact. This is part of the audit trail, not bookkeeping.

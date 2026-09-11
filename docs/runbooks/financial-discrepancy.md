# Runbook — Financial discrepancy

**Severity: P0.** An invariant violation means money is wrong *right now*. This
is not a warning to triage in the morning.

## Trigger

Any of: `LedgerImbalance`, `BalanceProjectionDrift`,
`PositionQuantityNotConserved`, `DuplicateFinancialEffect`, `ReplayDivergence`,
`UnexplainedReconciliationBreak`.

## The order of operations

**Stop the bleeding first. Investigate second. Do not reverse the order.**
A discrepancy that is still being produced while you investigate gets larger and
harder to reconstruct.

### 1. Contain (first 5 minutes)

```bash
# What fired, and how big is it?
curl -s http://<ledger>/v1/invariants
```

| Monitor | Immediate action |
|---|---|
| `LedgerImbalance` (INV-020) | Halt the affected posting path. Do not halt the whole ledger unless the imbalance spans account kinds. |
| `BalanceProjectionDrift` (INV-023) | Serve balances from the journal, not the projection. Stop the projector. |
| `PositionQuantityNotConserved` (INV-040) | Freeze the affected account(s). Block new orders on them. |
| `DuplicateFinancialEffect` (INV-100–102) | Block settlement for the affected deals. Do **not** reverse anything yet. |
| `ReplayDivergence` (INV-014) | Block the next release. Trading may continue; the log is intact. |
| `UnexplainedReconciliationBreak` (INV-141) | Block release. Hold affected withdrawals. |

Declare an incident. Page the financial-core owner and the risk owner.

### 2. Preserve evidence (next 10 minutes)

**Do not fix data yet.** The event log is immutable, so the history is safe — but
projections, caches and in-flight state are not.

```bash
# The journal is the truth. Snapshot the divergence.
psql -c "SELECT * FROM ledger.imbalances;"
psql -c "SELECT count(*), max(global_position) FROM events.event_log;"
```

Record: the global position at detection, the affected accounts, transactions and
correlation ids, and the deployed artifact digest.

### 3. Diagnose

Work from the log, because the log is the truth.

```bash
# Rebuild the projection from the journal and compare.
#   agrees  -> the projection is wrong  (recoverable, low severity)
#   differs -> the journal is wrong     (serious: a write path is broken)
```

The distinction above determines everything that follows. In practice the cause
is usually one of:

1. a partially-applied transaction that survived a crash (INV-024 — check the outbox)
2. a duplicate external event that bypassed the dedupe index (INV-010)
3. a projection applying an event twice (rebuildable, not a data loss)
4. a rounding policy applied at an undocumented boundary (INV-005)
5. a concurrent write outside the aggregate's serialization

### 4. Correct

**Never** `UPDATE` a journal entry. Never delete an event. The correction is a
**new balanced transaction** referencing the original (INV-022, INV-163):

- projection wrong → drop it and replay. No financial correction needed.
- journal wrong → a reversal plus a corrected posting, both balanced, both
  approved by the financial-core owner, both recorded in `CHANGELOG.md`.

### 5. Verify

```bash
psql -c "SELECT count(*) FROM ledger.imbalances;"   # must be 0
make test-replay                                     # replay equivalence restored
./scripts/verify_ledger_constraints.sh               # database still enforces the laws
```

Reconciliation must return to **zero unexplained discrepancies** before the
incident closes.

### 6. Afterwards

- The counterexample becomes a permanent regression test in `tests/invariants/`.
- If an existing invariant would have caught it earlier, tighten it. If none
  would have, **write a new one** — declare it in the registry, implement it, and
  update the baseline. That is the actual deliverable of this incident.
- If the database constraint did not catch what the application missed, that is a
  second finding.

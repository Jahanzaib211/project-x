# 14 — Roadmap

Phases, and what "done" means for each. A phase is not complete because the code
exists; it is complete when the gates say so.

---

## Phase 0 — Foundation ✅ *current*

Make it impossible to ship financial behaviour carelessly, before any financial
behaviour exists.

**Delivered**

- The dependency DAG: 22 modules, tiers, declared gates, declared invariants,
  test obligations and known failure modes, in `registry/modules.yaml`.
- Gate machinery: `gates/gates.yaml` (G0–G12), `gates/status.yaml`,
  `scripts/check_gates.py` enforcing that nothing builds on unproven ground.
- Structural validation: `check_dag.py` proves the graph is acyclic, that no
  module omits a non-waivable gate, that a module declaring invariants requires
  G4, and that one declaring an SLO requires G9.
- The regression ratchet: `check_regressions.py` fails if an invariant, a gate,
  a dependency edge or a test disappears.
- Invariant coverage: `check_invariant_coverage.py` fails if a module being
  built declares a law nothing executes.
- Documentation generated from the registry, with staleness a **blocking CI
  failure on every push, PR and merge**.
- Docker Compose stack on a verified-free, localhost-only port block.
- `01-domain-kernel` and `02-event-kernel` implemented, zero dependencies, with
  their invariants executed as property tests.

**Done when** — `make check` is green, CI enforces docs and the ratchet, and the
domain and event kernels reach G4.

---

## Phase 1 — The nucleus

The loop that makes this a broker rather than a repository.

```
Market State → Pricing → Order → Risk → Execution → Position → P&L → Ledger → Replay
```

**Modules** — `03-ledger`, `04-account`, `05-position`, `06-market-data`,
`07-pricing`, `08-pnl-margin`, `09-risk`, `10-oms`, `11-execution`.

**Done when**

- Every module in the loop has passed the gates it declares, up to G9.
- A recorded trading day replays from genesis to byte-identical state (G6).
- The ledger survives `kill -9` at randomized commit boundaries with the
  post-recovery ledger identical to the pre-crash ledger (G7, INV-024).
- Exactly-once financial effect holds under duplicate execution reports,
  partitions and retries (INV-100–104).
- Reconciliation across the whole window shows **zero unexplained
  discrepancies**.

This is the first thing worth calling a release: `v0.1.0 — Broker Core`.

---

## Phase 2 — Liquidity

Connect to the outside market.

**Modules** — `12-risk-book`, `13-lp-connectivity`, `14-hedging`.

**Done when** — the LP contract suite passes identically against every adapter
and the simulator; hedge failure is never recorded as hedge success (INV-130);
exposure reconciles to positions and the ledger continuously.

---

## Phase 3 — Money in and out

**Modules** — `15-reconciliation` (deepened), `16-kyc-aml`, `17-payments`.

**Done when** — every payment state transition is idempotent under duplicate and
out-of-order provider webhooks; client money is segregated in the chart of
accounts; settlement reconciles against bank and PSP statements with zero
unexplained breaks.

---

## Phase 4 — Regulatory surface

**Modules** — `18-compliance`.

**Done when** — every report is reproducible from the event log as of a stated
point in time; compliance has no write path into the financial core; retention
and legal hold cannot be bypassed.

---

## Phase 5 — Client surface

**Modules** — `19-client-api`, `20-web`, `21-external`.

**Done when** — the public schema is versioned and compatibility-checked; every
mutating endpoint is idempotent; the UI computes no financial figure; MT5 (or
equivalent) is reconciled continuously against the core and divergence raises a
break.

---

## What is deliberately not on this roadmap

- **Building the UI first.** It demos well and proves nothing. The gate rule
  makes it impossible anyway.
- **Guessed performance targets.** SLOs are set by measurement on target
  hardware and recorded per module (P11).
- **Treating MT5 as the platform.** It is an integration behind an adapter.
- **A "temporary" shortcut through the ledger.** There is no such thing; the one
  that ships is the one that is still there in three years.

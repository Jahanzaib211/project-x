# ADR-0002 — Build order is a DAG, enforced by gates

**Status:** Accepted

## Context

The common failure in ambitious financial systems is not writing bad code. It is
building the exciting, visible thing on top of the unproven thing, and
discovering the foundation was wrong once everything depends on it.

Feature backlogs actively encourage this: the trading screen demos well, so it
gets built first, and the ledger it sits on gets "hardened later". Later never
has the schedule for it.

## Decision

The build order is a **directed acyclic graph**, declared in
`registry/modules.yaml`. Each module declares its dependencies and the gates it
must pass.

**A module may not be built, merged or deployed while any module it depends on,
transitively, is short of that dependency's declared gates.**

This is enforced mechanically by `scripts/check_gates.py`, which runs first in
CI — before compilation, because a module building on unproven ground should not
consume a build runner at all.

`G0`, `G1`, `G2` and `G4` are non-waivable on every module. There is no
`--skip-gates` flag, and none will be added.

## Consequences

- You cannot start the UI early. This is the point, and it will be unpopular at
  some stage of the project.
- Foundation work gets the attention it needs, because nothing else can proceed.
- The graph is a design artifact reviewed before code exists to bias the
  discussion.
- Emergencies need a documented path that narrows scope and adds people rather
  than removing proof (`docs/runbooks/emergency-change.md`).

## Alternatives considered

**A checklist with a recommended order.** Recommendations lose to deadlines.

**Gates as a review convention.** Conventions are remembered inconsistently,
especially at 3am. If it matters, a machine checks it.

**Per-team autonomy over gates.** Reasonable in a product organisation. Here, one
team's shortcut becomes another team's incorrect balance.

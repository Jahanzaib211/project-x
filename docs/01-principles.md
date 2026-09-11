# 01 — Principles

Rules that are never broken. Each one exists because of a specific, expensive
failure mode. Each one is enforced by something mechanical — a type, a lint, a
test, or a gate — because a rule that is only written down is a rule that will be
broken at 3am under deadline.

---

## P1 — No floating point in financial code

IEEE-754 cannot represent `0.1`. Accumulate a few million operations and the
error is real money that reconciliation cannot explain.

**Instead:** fixed-point decimal with an explicit scale per currency, checked
arithmetic, and named rounding policies applied at documented boundaries.

**Enforced by:** the type system in `crates/domain-kernel`; a banned-pattern lint
at `G1`; property tests at `G3`.

---

## P2 — Money moves through the ledger, or it does not move

There is no code path anywhere that does `account.balance += x`. A balance is a
**projection over the journal**, not a field that anyone writes to.

**Why:** a balance you can write to is a balance you can corrupt, and a balance
you cannot derive is a balance you cannot defend in a dispute.

**Enforced by:** ledger service ownership of all posting; a static check at `G1`;
INV-023 and INV-031 at `G4`.

---

## P3 — The event log is append-only, and replay reproduces the present

No update, no delete, no reordering. Corrections are new, balanced events.
Folding the log from genesis must produce byte-identical state.

**Why:** this is what makes the system auditable, debuggable and recoverable. It
also turns "can we prove this?" into a command you can run.

**Enforced by:** `G6`, on every Tier 0 module.

---

## P4 — Ordering is sequence, never wall-clock time

Clocks skew, jump, and go backwards. Timestamps are metadata that describe when
something was observed; the per-aggregate sequence number decides order.

**Enforced by:** the event kernel envelope; INV-011; a clock-skew fault at `G7`.

---

## P5 — Exactly-once financial effect

The network will duplicate, retry and reorder. That is fine. The financial effect
of an operation must happen exactly once regardless.

Retrying a request is safe. Charging a commission twice is not.

**Enforced by:** idempotency keys, dedupe indexes, and the transactional outbox
pattern; INV-100 through INV-104 at `G4`; duplicate-delivery tests at `G5` and `G7`.

---

## P6 — Determinism where decisions are made

Pricing and risk are **pure functions** of an explicit input snapshot and a
versioned policy. No clock reads, no ambient state, no map-iteration order
leaking into output, no hidden I/O.

**Why:** a decision you cannot reproduce is a decision you cannot defend, debug,
or shadow-test against a new version.

**Enforced by:** INV-060 and INV-080 at `G4`; replay at `G6`; shadow-diff at `G11`.

---

## P7 — Fail closed

When a component that protects money is unavailable, the safe answer is **no**.
A risk engine that cannot reach its dependencies rejects orders. A screening
provider that times out blocks onboarding. Availability is never bought with
correctness.

**Enforced by:** INV-083, INV-152; dependency-failure tests at `G7`.

---

## P8 — Truth flows one way

The core owns financial truth. Everything outward — API, web, mobile, MT5,
reporting — is a **reader**. Compliance and reporting have no write path into the
financial core, and the UI never computes a balance except as a labelled
optimistic preview.

**Enforced by:** deployment topology; INV-170, INV-180, INV-190, INV-200.

---

## P9 — Make illegal states unrepresentable

Prefer a compile error to a runtime check, a runtime check to a test, and a test
to a code review comment. `Money<USD> + Money<EUR>` should not fail at runtime —
it should fail to compile.

---

## P10 — Every module declares its own laws, and runs them

An invariant that is written in a document and not executed in CI is folklore.
Every invariant in `registry/modules.yaml` is implemented in `tests/invariants/`,
and `scripts/check_dag.py` fails the build if a module declares invariants without
requiring `G4`.

---

## P11 — Measure, never guess

No latency target, throughput number or capacity figure appears in this
repository unless it was measured on target hardware and recorded. A guessed SLO
is worse than no SLO: it produces false confidence and misleading alerts.

---

## P12 — Reconcile from the beginning

Reconciliation is not a back-office feature to be added before launch. It starts
with the ledger, long before payments exist, because it is how you find out
whether the core is actually correct. **Zero unexplained financial discrepancies**
is a release gate.

---

## P13 — A human is accountable for money-moving changes

Every gate can be green and the change can still be wrong in a way no test
encodes. Tier 0, 1, 2 and 3 changes require a named human approval on the exact
artifact digest being deployed. Automation decides whether a change *may* ship;
a person decides whether it *does*.

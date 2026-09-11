# ADR-0004 — Event sourcing plus a double-entry ledger

**Status:** Accepted

## Context

"What is the balance?" is a weaker question than "how did it come to be that
balance?" Disputes, audits, reconciliation and debugging all ask the second one.
A system storing only current state can answer the first and merely guess at the
second.

Double-entry bookkeeping is roughly six hundred years old and encodes one
property software keeps rediscovering: value is never created or destroyed by a
posting, only moved, and the sum of movements is zero.

## Decision

**Event sourcing.** Every fact is an immutable event on an append-only log with a
gapless per-aggregate sequence. State is a fold over that log. Replaying from
genesis must reproduce byte-identical state (INV-014), and that is gate G6.

**Double-entry ledger.** Every value movement is a balanced transaction:
`sum(debits) == sum(credits)`, per transaction *and* per currency. Balances are
projections over the journal — there is deliberately **no balance column** in the
schema (INV-023).

**Enforced in two independent places.** The application enforces the rules, and
the database enforces them again with constraints and triggers. Stating a law
twice is how you find out when one statement is wrong — provided you test the
second one, which `scripts/verify_ledger_constraints.sh` does at G5.

**Ordering is sequence, never wall-clock time.** Timestamps say when a fact was
observed. Clocks skew, jump and run backwards; sequence numbers do not.

## Consequences

- The log only grows. Storage is cheap; unanswerable audit questions are not.
- Corrections are new balanced entries, never mutations. "Just fix the row" is
  not available, which is the intended constraint.
- Replay determinism becomes a hard requirement, which in turn requires the
  determinism boundary: no clock reads, no randomness, no map-iteration order,
  no I/O inside the financial fold.
- Projections can be dropped and rebuilt, which makes a corrupted read model an
  inconvenience rather than an incident.

## Alternatives considered

**CRUD with an audit table.** The audit table drifts from the truth, and the
drift is discovered during the audit.

**Event sourcing without double entry.** Gives history but not conservation.
Balanced postings are what make "money was created" a detectable event.

**Double entry without event sourcing.** Gives conservation but not the causal
chain from a client action to a posting.

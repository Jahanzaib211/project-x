# ADR-0005 — Rust for the core, TypeScript at the edge

**Status:** Accepted

## Context

Different parts of this system fail differently. A bug in the ledger is lost
money and a regulatory problem. A bug in the account settings page is an
annoyance. Using one language everywhere optimises for neither.

## Decision

**Rust for Tier 0 and Tier 1** — domain kernel, event kernel, ledger, account,
position, P&L, margin, risk, OMS, execution, market data, pricing.

- Fixed-point arithmetic without a garbage collector, so latency is predictable
  and there is no pause in the middle of a liquidation sweep.
- A type system strong enough to make `Money<Usd> + Money<Eur>` a compile error.
- Exhaustive matching, so adding an order state is a compile error until every
  transition has been considered.
- Overflow checks left **on in release** — a wrong number is worse than a slow one.

**TypeScript / Node for Tier 4** — client API, and tooling.

- Velocity where the blast radius is inconvenience rather than money.
- Strict mode, no `any`, no non-null assertions, and **money never becomes a
  `number`** — amounts stay decimal strings end to end, checked by a banned-pattern
  scan at G1.

**Python for repository tooling** — the DAG, gate, docs and ratchet scripts.
Read-only against everything that matters, and universally available.

## Consequences

- Engineers on the core need Rust. That narrows hiring and is accepted: the
  people writing ledger code should be comfortable with a language that refuses
  ambiguity.
- Two toolchains in CI. Cost is real and small.
- The boundary between them is a serialization boundary, which forces the money
  representation to be explicit — a benefit, not just a cost.

## Alternatives considered

**Everything in TypeScript.** Faster to start; no way to make cross-currency
addition a compile error, and GC pauses on the liquidation path are a real risk.

**Everything in Rust.** Slows down the surface that changes weekly for no
correctness gain at Tier 4.

**Go for the core.** Good concurrency and operational story; a weaker type system
for this specific problem — no generics-based currency tagging that reads well,
and `error` handling that makes it easy to ignore an arithmetic failure.

**Java/Kotlin with BigDecimal.** Entirely viable, and the JVM's GC behaviour is
manageable. Rejected on the strength of the type-level guarantees available in
Rust for the money model.

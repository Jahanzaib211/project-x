# 13 — Glossary

Terms used precisely. Where an industry word is ambiguous, this document says
which meaning applies here.

## Financial

**A-book** — Client orders hedged with an external liquidity provider. The broker
earns the spread and carries no directional risk.

**B-book** — Client orders internalised. The broker is the counterparty and
carries the risk. Neither model is inherently right; the routing policy decides,
and the decision is recorded (`14-hedging`).

**Balance** — The sum of settled ledger entries for an account. A *projection*,
never a stored, writable field.

**Break** — A discrepancy found in reconciliation. Classified as MATCHED,
MISMATCH, MISSING, DUPLICATE or TIMING_DIFFERENCE. A break is either explained or
open; there is no third state.

**Deal** — The financial record of an execution: price, quantity, commission,
swap, fees. Exactly one deal per execution (INV-100).

**Equity** — `balance + unrealized P&L` (INV-070).

**Free margin** — `equity - used margin`.

**Journal / journal entry** — The append-only record of ledger postings. The
journal is the truth; balances are derived from it.

**Margin level** — `equity / used margin`. Behaviour at zero used margin is
defined explicitly, never left to a division fault (INV-072).

**Minor unit** — The smallest exactly-representable amount of a currency: cent,
satoshi, yen. Money is an integer count of these.

**Netting vs hedging (positions)** — Netting keeps one position per symbol;
hedging permits simultaneous long and short. Configured per account.

**Realized / unrealized P&L** — Realized is booked to the ledger on close.
Unrealized is computed from current prices and never touches the ledger.

**Scale** — The number of decimal places in a currency's minor unit. A property
of the currency, not a formatting preference.

**Slippage** — The difference between the quoted price and the executed price.

**Stop-out / liquidation** — Forced position closure when margin level breaches
policy.

**Swap** — Overnight financing charge or credit on a held position.

**Used margin** — Capital reserved against open positions under the active margin
policy (INV-071).

## Architectural

**Aggregate** — A consistency boundary with its own event stream and its own
gapless sequence: one account, one position, one order.

**Canonical serialization** — A byte-stable encoding: identical logical content
produces identical bytes on any machine, in any build (INV-013). What makes
replay comparison possible.

**Causation id / correlation id** — Causation is the event that directly caused
this one. Correlation ties together everything stemming from one originating
request.

**Determinism boundary** — The region containing no clock read, no randomness, no
I/O and no map-iteration-order dependence. Pricing, risk, ledger posting,
position maths and P&L live inside it.

**Event sourcing** — State is derived by folding an append-only log, rather than
stored and mutated.

**Fail closed** — When a component that protects money is unavailable, the answer
is "no". Availability is never bought with correctness (P7).

**Idempotency key** — A client-supplied identifier making a retried request safe:
the same key returns the first outcome rather than performing a second financial
effect.

**Projection** — Read-optimised state derived from the event log. Always
rebuildable, never a source of truth.

**Replay** — Folding the event log from genesis. If the result is not identical
to live state, one of them is wrong (INV-014, INV-104).

**Shadow diff** — Running a new version alongside the incumbent on identical
input and comparing financial outputs. For pure functions, any difference is
either intended or a bug.

**Transactional outbox** — Writing an event and its publication intent in one
database transaction, so "it happened" and "it was published" cannot disagree.

## Process

**Blast radius** — What breaks when a tier is wrong. Determines gate strictness
and approval requirements.

**Gate (G0–G12)** — A named, mechanically-checkable proof obligation. See
[04 — Gates](04-gates.md).

**Invariant (INV-nnn)** — A statement that must be true at every observable
moment. Declared in the registry, executed at G4, monitored in production.

**Module** — A unit in the dependency DAG, declared in `registry/modules.yaml`.

**Non-waivable gate** — G0, G1, G2, G4. No module may omit one, for any reason.

**Ratchet** — The regression check. Invariants, gates, dependencies and test
counts may only move forward; moving one backward requires updating the baseline
in the same PR, where a reviewer sees it.

**Tier (T0–T4)** — Deployment and control tier, from Financial Core to
Experience.

## External

**FIX** — Financial Information eXchange, the session protocol most LPs speak.

**KYC / AML / PEP** — Know Your Customer, Anti-Money Laundering, Politically
Exposed Person.

**LP** — Liquidity Provider. Always behind an adapter; the core never learns a
vendor dialect (INV-120).

**MT5** — MetaTrader 5. Here, an *integration behind an adapter* — a client of
the broker, never the source of financial truth (INV-200).

**PSP** — Payment Service Provider.

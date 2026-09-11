# 05 — Invariants

An **invariant** is a statement about the system that must be true at every
observable moment. Not usually true. Not true at the end of a transaction. True
whenever anyone can look.

Invariants are the specification of this system's financial behaviour. They are
declared in [`registry/modules.yaml`](../registry/modules.yaml), executed as tests
at gate [`G4`](04-gates.md#g4--domain-invariants), and monitored continuously in
production.

## Rules

1. **Declared and implemented together.** A module that declares an invariant must
   require `G4`; `scripts/check_dag.py` fails the build otherwise. An invariant in
   a document but not in a test is folklore.
2. **Asserted continuously, not terminally.** Randomized scenario runs check
   invariants throughout, because a ledger that balances only at the end had a
   window during which a reader saw impossible money.
3. **Changed only by ADR.** Weakening or deleting an invariant requires a written
   decision record and a financial-core owner's approval. See
   [CONTRIBUTING.md](../CONTRIBUTING.md#changing-an-invariant).
4. **Monitored in production.** The same assertion that gates the build watches
   the running system. A violation pages someone — it does not log a warning —
   because it means money is wrong right now.

## The seven that matter most

If you remember nothing else:

| | Invariant |
|---|---|
| **INV-020** | For every transaction, `sum(debits) == sum(credits)`, exactly |
| **INV-023** | `balance(account) == fold(journal entries)`, always |
| **INV-040** | Quantity is conserved: `sum(fills) == position delta`, exactly |
| **INV-080** | Identical inputs and policy version produce an identical risk decision |
| **INV-100** | Every execution produces exactly one financial deal |
| **INV-104** | A crash at any point leaves a state that replay reproduces exactly |
| **INV-141** | Zero unexplained financial discrepancies before any production release |

## Catalogue

Generated from the registry. Each is implemented in `tests/invariants/` and gated
at `G4` on the owning module.

<!-- BEGIN:INVARIANTS -->
### `00-foundation` — Engineering Foundation

_Gated at G4. Tier T0._

- **INV-900** — every dependency is pinned and its lockfile committed; a build is reproducible from the commit alone.
- **INV-901** — no secret is present in a tracked file, and the secret scanner detects a planted canary.
- **INV-902** — the runtime image runs as a non-root user and carries no shell or package manager.

### `01-domain-kernel` — Domain Kernel (types + math)

_Gated at G4. Tier T0._

- **INV-001** — Money arithmetic never uses IEEE-754 floating point.
- **INV-002** — a + b == b + a for Money of the same currency.
- **INV-003** — (a + b) - b == a exactly, under the declared rounding policy.
- **INV-004** — Money of different currencies cannot be added; it is a compile-time error.
- **INV-005** — every rounding operation names its policy and its scale.

### `02-event-kernel` — Event Kernel (identity, clock, envelope)

_Gated at G4. Tier T0._

- **INV-010** — event_id is globally unique; a duplicate append is a no-op, not a second effect.
- **INV-011** — per-aggregate sequence is gapless and strictly increasing.
- **INV-012** — the event log is append-only; no update, no delete, no reordering.
- **INV-013** — canonical serialization is byte-identical for identical logical content.
- **INV-014** — replaying the log from genesis reproduces byte-identical state.

### `03-ledger` — Double-Entry Ledger

_Gated at G4. Tier T0._

- **INV-020** — for every transaction, sum(debits) == sum(credits), exactly.
- **INV-021** — for every currency within a transaction, debits == credits.
- **INV-022** — a journal entry is never updated or deleted; corrections are new balanced entries.
- **INV-023** — balance(account) == fold(journal entries for that account), always.
- **INV-024** — the ledger after crash recovery is identical to the ledger before the crash.

### `04-account` — Account Engine

_Gated at G4. Tier T0._

- **INV-030** — available balance == balance - reservations - used margin; never negative without an explicit deficit event.
- **INV-031** — no balance mutation exists without a corresponding ledger transaction.
- **INV-032** — a frozen or closed account cannot originate new financial effects.

### `05-position` — Position Engine

_Gated at G4. Tier T0._

- **INV-040** — quantity is conserved — sum(fills) == position delta, exactly.
- **INV-041** — every position mutation has exactly one originating event.
- **INV-042** — realized P&L on close equals the ledger postings for that close.
- **INV-043** — closing a position to zero leaves no residual quantity or residual average price.

### `06-market-data` — Market Data

_Gated at G4. Tier T1._

- **INV-050** — a quote that fails validation never reaches the canonical book.
- **INV-051** — market state carries an explicit freshness age; consumers must be able to reject stale state.
- **INV-052** — the canonical book is reproducible from the recorded feed.

### `07-pricing` — Pricing Engine

_Gated at G4. Tier T1._

- **INV-060** — identical (MarketState, config) input yields byte-identical ClientQuote output.
- **INV-061** — bid <= ask on every emitted quote, unless the model explicitly permits and labels a crossed state.
- **INV-062** — a quote derived from stale market state is never emitted as live.
- **INV-063** — every quote is attributable to the exact config version and market state that produced it.

### `08-pnl-margin` — P&L and Margin

_Gated at G4. Tier T0._

- **INV-070** — equity == balance + sum(unrealized P&L of open positions).
- **INV-071** — used margin == sum(per-position margin) under the active policy.
- **INV-072** — margin level at zero used margin is defined and documented, never a division fault.
- **INV-073** — every P&L figure is reproducible from (positions, quotes, policy version).

### `09-risk` — Risk Engine

_Gated at G4. Tier T0._

- **INV-080** — identical inputs and policy version produce an identical decision. Always.
- **INV-081** — every decision records the exact input snapshot and policy version that produced it.
- **INV-082** — no order reaches execution without a recorded risk decision.
- **INV-083** — risk failure is closed, not open — an unavailable risk engine rejects, never allows.

### `10-oms` — Order Management System

_Gated at G4. Tier T0._

- **INV-090** — an order occupies exactly one state at a time; every transition is legal and recorded.
- **INV-091** — a client order id maps to at most one order, forever.
- **INV-092** — a cancel that races a fill resolves to exactly one outcome, never both.
- **INV-093** — an order in an unknown execution state is never assumed to be either filled or unfilled.

### `11-execution` — Execution Core

_Gated at G4. Tier T0._

- **INV-100** — every execution produces exactly one financial deal.
- **INV-101** — every deal produces exactly one balanced set of ledger postings.
- **INV-102** — network retries are safe; financial effects are not repeatable.
- **INV-103** — no deal exists without an originating order and a recorded risk decision.
- **INV-104** — a crash at any point leaves the system in a state that replay reproduces exactly.

### `12-risk-book` — Internal Risk Book

_Gated at G4. Tier T1._

- **INV-110** — risk book exposure == aggregate of client positions minus hedges, at all times.
- **INV-111** — every exposure figure is reconcilable to the position engine and the ledger.

### `13-lp-connectivity` — LP / FIX Connectivity

_Gated at G4. Tier T1._

- **INV-120** — the core depends only on the LP interface, never on a vendor dialect.
- **INV-121** — FIX sequence gaps are detected and resolved, never skipped.
- **INV-122** — an LP execution report is applied exactly once.

### `14-hedging` — Routing and Hedging

_Gated at G4. Tier T1._

- **INV-130** — a failed hedge is never recorded as a successful hedge.
- **INV-131** — hedge state is always one of pending, filled, partially-filled, failed — never unknown-and-ignored.
- **INV-132** — routing decisions are deterministic given inputs and policy version.

### `15-reconciliation` — Reconciliation

_Gated at G4. Tier T2._

- **INV-140** — every break is either explained or open; there is no third category.
- **INV-141** — zero unexplained financial discrepancies is a hard release gate.
- **INV-142** — reconciliation is read-only against the financial core.

### `16-kyc-aml` — KYC / AML / Fraud

_Gated at G4. Tier T3._

- **INV-150** — no withdrawal is released for an account failing required verification.
- **INV-151** — every automated decision is explainable and permanently auditable.
- **INV-152** — screening provider outage fails closed for onboarding, never open.

### `17-payments` — Payments and Treasury

_Gated at G4. Tier T2._

- **INV-160** — no code path performs `account.balance += x`; all money moves through the ledger.
- **INV-161** — every payment state transition is idempotent under provider retries and duplicate webhooks.
- **INV-162** — client money is segregated from house money at the account level in the chart of accounts.
- **INV-163** — a reversal is a new balanced transaction, never a deletion.

### `18-compliance` — Compliance and Reporting

_Gated at G4. Tier T3._

- **INV-170** — compliance never writes to the financial core.
- **INV-171** — any report is reproducible from the event log at a stated point in time.
- **INV-172** — retention and legal hold cannot be bypassed by a normal deletion path.

### `19-client-api` — Client API

_Gated at G4. Tier T4._

- **INV-180** — the API never computes a financial figure; it forwards what the core computed.
- **INV-181** — every mutating endpoint is idempotent under a client-supplied key.
- **INV-182** — a published API schema version never changes meaning.
- **INV-183** — an unavailable financial figure is returned as null with the module responsible for it, never as a substituted zero.
- **INV-184** — the client-area store holds no balance, equity or margin column; financial state is read from the core, never kept at the edge.
- **INV-185** — no credential is stored in a recoverable form; a password is a scrypt digest and a session token is held only as its SHA-256.
- **INV-186** — a refused sign-in is identical whether the address is registered or not, in wording and in work done.
- **INV-187** — a session reaches only the rows its own user owns; every session statement is scoped by that user or by a digest the caller proved they hold.
- **INV-188** — client isolation is enforced by the database, not the application: the serving roles cannot bypass row-level security, an unscoped query returns no rows, and writing a row owned by another client is refused.
- **INV-189** — a password reset is a single-use, expiring token, stored only as a digest, and completing one revokes every session of that account.

### `20-web` — Web and Mobile

_Gated at G4. Tier T4._

- **INV-190** — the UI never owns financial truth and never computes a balance or P&L locally except as a labelled optimistic preview.
- **INV-191** — the rendered page contains no financial figure that did not come from the API, and performs no arithmetic on money.
- **INV-192** — the session token is never reachable by script; it lives in an HttpOnly, SameSite cookie and appears in no response body, URL or browser store.

### `21-external` — External Platform Integrations (MT5 et al.)

_Gated at G4. Tier T4._

- **INV-200** — the external platform is never the financial source of truth.
- **INV-201** — platform state is reconciled against the core continuously, and divergence raises a break.

<!-- END:INVARIANTS -->

## Writing a good invariant

**Be exact about arithmetic.** "Balances should roughly match" is not an
invariant. `sum(debits) == sum(credits)` is.

**State the observable moment.** "After a trade completes" hides the window during
which it was false. Prefer statements true at every commit boundary.

**Make it falsifiable by a machine.** If checking it needs human judgement, it is a
policy, not an invariant, and it belongs in a runbook.

**Name the failure it prevents.** Every invariant in this catalogue exists because
a system like this one lost money in that specific way.

## Production monitoring

Continuous invariant monitors run against production state:

| Monitor | Cadence | On violation |
|---|---|---|
| Ledger balance (INV-020, INV-023) | Every transaction batch | Page; halt affected posting path |
| Position conservation (INV-040) | Every position mutation | Page; freeze affected account |
| Equity identity (INV-070) | Continuous sampling | Page |
| Exactly-once effects (INV-100–102) | Continuous | Page; block duplicate settlement |
| Replay equivalence (INV-014, INV-104) | Nightly full replay | Page; block next release |
| Reconciliation (INV-140, INV-141) | Continuous + daily close | Page; block release |

See [11 — Observability](11-observability.md).

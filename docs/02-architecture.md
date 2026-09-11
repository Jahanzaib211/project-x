# 02 — Architecture

## The one-sentence version

An event-sourced financial core written in Rust, surrounded by an outward-flowing
ring of readers, where the ledger is the source of truth and everything else is
either an input to it or a projection of it.

## The nucleus

```
        ┌──────────────┐
        │ MARKET STATE │  canonical, validated, timestamped
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │   PRICING    │  pure function: (MarketState, config) -> ClientQuote
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │    ORDER     │  OMS state machine, one lifecycle, all transitions recorded
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │     RISK     │  pure decision: ALLOW | REJECT | REDUCE | LIQUIDATE
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │  EXECUTION   │  exactly-once financial effect
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │   POSITION   │  quantity conserved, realized P&L exact
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │  P&L/MARGIN  │  equity, used margin, free margin, margin level
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │    LEDGER    │  double-entry, append-only, the source of truth
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │    REPLAY    │  fold(log) == live state, byte-identical
        └──────────────┘
```

Everything else in the system is liquidity, treasury, compliance or presentation
wrapped around this loop.

## Layering

```
┌──────────────────────────────────────────────────────────────┐
│ T4  EXPERIENCE      web · mobile · back office · MT5 bridge   │  readers
├──────────────────────────────────────────────────────────────┤
│ T4  CLIENT API      REST · WebSocket · webhooks               │  readers
├──────────────────────────────────────────────────────────────┤
│ T3  COMPLIANCE      KYC · AML · fraud · reporting             │  read-only on core
├──────────────────────────────────────────────────────────────┤
│ T2  FINANCIAL OPS   payments · treasury · reconciliation      │  writes via ledger
├──────────────────────────────────────────────────────────────┤
│ T1  MARKET INFRA    market data · pricing · LP/FIX · hedging  │  inputs + outputs
├══════════════════════════════════════════════════════════════┤
│ T0  FINANCIAL CORE  domain · events · ledger · account ·      │  the truth
│                     position · P&L · margin · risk · OMS ·    │
│                     execution                                 │
└──────────────────────────────────────────────────────────────┘
```

**Truth flows up. Requests flow down. Nothing above T0 owns a number that T0
computes.**

Failure of T4 must never stop T0. A dead web app means clients cannot see their
positions; it must not mean positions stop being maintained, margin stops being
calculated, or liquidations stop firing.

## Write path and read path

Two paths, deliberately separated.

**Write path** — synchronous, transactional, minimal:

```
command → validate → risk decision → domain event(s) → event store (Postgres)
        → transactional outbox → event bus (Redpanda)
```

The write path touches Postgres and nothing else. It does not call an external
service, wait on a cache, or publish to a bus inline; publication happens through
the outbox so that "the event was recorded" and "the event was published" cannot
disagree.

**Read path** — asynchronous, rebuildable, disposable:

```
event bus → projectors → Redis (hot state) · Postgres (queryable state)
                       · ClickHouse (analytics and reporting)
```

Every projection is **rebuildable from the event log**. If a projection is wrong,
you drop it and replay. This is why no projection is ever a source of truth, and
why losing Redis entirely is an availability incident and never a data-loss
incident.

## Services

| Service | Module | Language | Port | Owns |
|---|---|---|---|---|
| `ledger` | `03-ledger` | Rust | 8081 | Journals, entries, balances — the source of truth |
| `market-data` | `06-market-data` | Rust | 8082 | Feed normalization, canonical book, market state |
| `pricing` | `07-pricing` | Rust | 8083 | MarketState + config → ClientQuote |
| `oms` | `10-oms` | Rust | 8084 | Order state machine, risk invocation, execution dispatch |
| `client-api` | `19-client-api` | TypeScript | 8080 | REST, WebSocket, auth, rate limits, idempotency |
| `web` | `20-web` | Next.js | 3000 | Presentation only |

`crates/domain-kernel` and `crates/event-kernel` are **libraries**, not services.
They are compiled into every Rust service so that there is exactly one definition
of `Money` and exactly one event envelope in the entire system.

Modules not yet listed as services (`04-account`, `05-position`, `08-pnl-margin`,
`09-risk`, `11-execution`, …) begin life as libraries inside the services above
and are extracted into their own deployables only when there is a measured reason
to. Splitting a financial transaction across a network boundary is a cost, not an
achievement.

## Communication

| Between | Mechanism | Why |
|---|---|---|
| Core services, facts | Redpanda topics, ordered per aggregate partition | Durable, replayable, ordered |
| Core services, queries | gRPC/HTTP, synchronous | A decision needs an answer now |
| Edge → core | HTTP with idempotency keys | Retry-safe by construction |
| Core → clients | WebSocket fan-out from projections | Never from the write path |
| Anything → external | Adapter behind an interface | The core never learns a vendor dialect |

## Consistency model

- **Strong** within one aggregate. An account's journal is serialized; a position's
  mutations are ordered.
- **Eventual** across projections. The client may see a position update tens of
  milliseconds after the ledger has it. That is acceptable and stated explicitly
  in the API contract.
- **Never eventual for a risk decision.** Risk reads a consistent snapshot, not a
  projection that may lag. A stale margin figure is how an account trades past its
  limit.

## Determinism boundary

Inside the boundary — domain kernel, event kernel, ledger posting rules, position
maths, P&L, margin, pricing, risk — there is **no clock read, no random number, no
map-iteration-order dependence, no I/O**. Time and randomness enter only at the
edge, and enter as *data on an event*.

That is what makes `G6` (deterministic replay) achievable. Break the boundary and
replay stops proving anything.

## Data stores

| Store | Role | Rebuildable? |
|---|---|---|
| PostgreSQL | Event store, ledger, transactional state | **No — this is the truth** |
| Redpanda | Event bus, ordered distribution | Yes, from the event store |
| Redis | Hot projections, sessions, rate limits | Yes, always |
| ClickHouse | Analytics, reporting, surveillance | Yes, always |
| MinIO / S3 | Documents, statements, artifacts, replay fixtures | Backed up, not derived |

Detail in [12 — Data stores](12-data-stores.md).

## Observability

Structured logs, OpenTelemetry traces spanning the whole order path, Prometheus
metrics, and — distinctively — **invariant monitors**: the same assertions that
run as tests at `G4`, evaluated continuously against production. An invariant
violation is a paging alert, not a log line, because it means money is wrong right
now. See [11 — Observability](11-observability.md).

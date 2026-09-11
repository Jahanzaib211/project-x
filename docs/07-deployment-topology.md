# 07 — Deployment topology

## The principle

**Failure of an outer tier must never stop an inner tier.** A dead web app means
clients cannot see their positions. It must not mean positions stop being
maintained, margin stops being calculated, or liquidations stop firing.

## Tiers

### Tier 0 — Financial Core
`domain-kernel` · `event-kernel` · `ledger` · `account` · `position` · `pnl-margin` · `risk` · `oms` · `execution`

The money. Highest controls in the system.

- Isolated network segment; no inbound path from the public internet
- Dedicated database cluster with synchronous replication
- Deploys one module at a time, never in a batch
- Two-person approval on the artifact digest
- Continuous invariant monitoring with automatic rollback
- Survives the loss of every other tier

### Tier 1 — Market Infrastructure
`market-data` · `pricing` · `lp-connectivity` · `hedging` · `risk-book`

Latency-sensitive and availability-sensitive. Co-located with LP connectivity
where latency justifies it. Runs hot/hot with deterministic failover. Degrades to
**quote-only, no new risk** rather than serving stale prices as live.

### Tier 2 — Financial Operations
`payments` · `treasury` · `reconciliation`

Correctness over latency. Reconciliation is read-only against the core. Payment
adapters are isolated per provider so one provider's outage or misbehaviour cannot
affect another.

### Tier 3 — Compliance
`kyc-aml` · `compliance-reporting` · surveillance

Read-only against the financial core, always. Separate analytical store so a heavy
report cannot touch the transactional path. Strict retention and legal hold.

### Tier 4 — Experience
`client-api` · `web` · `mobile` · back office · `external` (MT5)

Stateless, horizontally scaled, behind a CDN and WAF. Rate-limited at the edge.
**Owns no financial truth.** Failure here is an inconvenience, and the system is
designed so that it stays one.

## Failure isolation

```
T4 down  →  clients cannot see or trade. Positions, margin and liquidation continue.
T3 down  →  reporting delayed. Trading continues. New onboarding blocks (fail closed).
T2 down  →  deposits and withdrawals queue. Trading continues on existing balances.
T1 down  →  no new prices. Trading halts. Existing positions still marked to last
            valid state; risk continues; liquidation logic continues.
T0 down  →  full halt. This is the tier that is not allowed to fail, and the one
            every other design decision protects.
```

Each degradation is a **designed mode with a defined behaviour**, exercised at
`G7`, not an accident discovered in production.

## Deployment cadence by tier

| Tier | Cadence | Strategy | Approval |
|---|---|---|---|
| T0 | As needed, never batched | Canary → progressive, one module at a time | Two financial-core owners |
| T1 | Weekly window | Blue/green with shadow-diff | Owner |
| T2 | Weekly | Rolling | Owner + reconciliation clean |
| T3 | Weekly | Rolling | Compliance owner |
| T4 | Continuous | Automated canary → auto-promote | Automated |

## Data isolation

| Tier | Store | Isolation |
|---|---|---|
| T0 | PostgreSQL primary cluster | Dedicated; no cross-tier access; core services only |
| T1 | In-memory + Redis | Rebuildable; loss is availability, never data |
| T2 | PostgreSQL (own schema) | Reads the ledger through the ledger service, never directly |
| T3 | ClickHouse | Read-only replica of the event stream |
| T4 | Redis + read replicas | Projections only |

**No service outside Tier 0 connects to the Tier 0 database.** Access is through
the owning service, so that invariants and posting rules cannot be bypassed by a
convenient SQL statement.

## Local compose vs. production

Compose runs everything on one machine so a developer can drive the whole system
in one command. It is **not** a production topology: it collapses the network
segmentation, runs single instances, uses deliberately weak development
credentials, and omits the replication and failover that Tier 0 requires.

What Compose does reproduce faithfully, and must: the service boundaries, the
event flow, the schemas, and the direction that truth flows. If a change works in
Compose but violates tier isolation, `G5` should catch it — and if it does not,
that is a gap in `G5`.

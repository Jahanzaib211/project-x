# 12 — Data stores

## The rule that orders everything else

**Exactly one store holds truth. Every other store is a projection that can be
destroyed and rebuilt from it.**

| Store | Holds | Truth? | If lost |
|---|---|---|---|
| PostgreSQL | Event store, ledger journal, transactional state | **Yes** | Restore from backup + WAL. This is the disaster case. |
| Redpanda | Event distribution | No | Re-publish from the event store |
| Redis | Hot projections, sessions, rate limits | No | Rebuild by replay; availability incident only |
| ClickHouse | Analytics, reporting, surveillance | No | Rebuild by replay |
| MinIO / S3 | Documents, statements, artifacts, replay fixtures | Backed up, not derived | Restore from backup |

## PostgreSQL — the source of truth

Two things live here, and nothing else may claim to be authoritative:

**The event store.** Append-only. `(aggregate_id, sequence)` unique, which is what
gives optimistic concurrency and gapless ordering for free. A global monotonic
position for replay cursors. `event_id` unique, which is what makes duplicate
appends idempotent rather than doubly effective.

**The ledger.** Journals and journal entries, append-only. Balanced-transaction
constraints enforced in the database as well as in code — the database is the last
line of defence and the one an accidental SQL statement still meets.

Balances are **projections** over journal entries. There is no writable balance
column anywhere in the schema, because a balance you can write to is a balance you
can corrupt.

Operational posture: synchronous replication for Tier 0; point-in-time recovery;
restores rehearsed on a schedule, because an unrehearsed backup is a hypothesis.

## Redpanda — the event bus

Kafka API, no ZooKeeper, single binary — which matters for a Compose environment a
developer runs on a laptop.

Topics are partitioned by aggregate id, so ordering is guaranteed exactly where
ordering matters: within one account, one position, one order. Consumers are
idempotent, because at-least-once delivery is the honest model and exactly-once
delivery is not something to depend on.

Publication happens through a **transactional outbox**: the event is written to
Postgres in the same transaction as the state change, and a relay publishes it.
This is what makes "it happened" and "it was published" incapable of disagreeing.

## Redis — hot, disposable

Projections read on the hot path, sessions, rate-limit counters, quote caches.
Never a source of truth, never the only copy of anything. Losing Redis entirely
degrades latency and availability and loses no data, and that property is worth
protecting: the moment something is only in Redis, it has become a second truth.

## ClickHouse — analytics off the transactional path

Reporting, surveillance, historical analysis, client statements. Fed from the
event stream, rebuildable by replay. Keeping it strictly separate is what stops a
heavy regulatory report from touching the path that executes trades.

## MinIO / S3 — objects

Identity documents (encrypted, access-audited), generated statements, build
artifacts and SBOMs, and recorded market-data and event-log fixtures for `G6`
replay. Immutable where the regulator requires it; versioned; lifecycle policies
match the retention schedule.

## Migrations

- Expand → deploy → migrate → contract. Never a breaking change in one step.
- Backward-compatible for at least one release, so a rollback is always possible.
- Tested **up and down** at `G5`.
- **The event store is never migrated in place.** Events are immutable. Schema
  evolution happens through versioned event types and upcasting at read time, so
  that a five-year-old event still decodes and still replays.

## Retention

| Data | Retention | Why |
|---|---|---|
| Financial events, ledger | Permanent | Auditability, dispute resolution |
| Order and execution records | Regulatory schedule | Reporting obligations |
| Identity documents | Regulatory schedule, then deletion | Privacy obligation |
| Market data | Rolling window + fixtures kept for replay | Cost |
| Logs and traces | Short, hot; longer, cold | Cost |

Deletion respects legal hold, and legal hold cannot be bypassed by an ordinary
deletion path — that is INV-172, and it is tested.

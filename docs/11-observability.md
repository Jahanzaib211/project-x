# 11 — Observability

Three ordinary pillars, and one that is specific to this domain.

## Invariant monitors

The distinguishing practice. The same assertions that gate the build at `G4` run
continuously against production state.

| Monitor | Cadence | On violation |
|---|---|---|
| `sum(debits) == sum(credits)` (INV-020) | Every transaction batch | **Page**; halt affected posting path |
| `balance == fold(journal)` (INV-023) | Continuous sampling + full nightly | **Page** |
| Position conservation (INV-040) | Every position mutation | **Page**; freeze affected account |
| `equity == balance + UPNL` (INV-070) | Continuous sampling | **Page** |
| Exactly-once effects (INV-100–102) | Continuous | **Page**; block duplicate settlement |
| Replay equivalence (INV-014, INV-104) | Nightly full replay | **Page**; block next release |
| Reconciliation breaks (INV-140–141) | Continuous + daily close | **Page**; block release |

An invariant violation is not a warning to triage in the morning. It means money
is wrong **right now**, and the response is to stop the affected path first and
investigate second.

## Metrics

**Financial** (the ones that matter most): ledger imbalance count — which must be
zero, always; open reconciliation breaks by age and class; total client equity
versus total ledger balance; deals per second; liquidations per minute.

**Operational**: request rate, error rate, duration at p50/p95/p99/p99.9 per
endpoint; queue depth and consumer lag; database connection pool saturation and
query latency; event store append latency and replay lag.

**Business**: active accounts, deposit and withdrawal volume, hedge ratio, exposure
by symbol and currency, spread capture.

## Tracing

OpenTelemetry, with one trace spanning the entire order path:

```
client request → api → oms → risk → execution → ledger → position → projection → client notification
```

Every span carries `correlation_id`, `causation_id`, `account_id` and `order_id`,
so a single client complaint resolves to the exact decision path — including the
policy version that produced the risk decision.

Sampling: 100% of financial mutations and of every error. Everything else sampled.
A trace is not a luxury on the path where money moves.

## Logging

Structured JSON, one event per line. Every line carries `correlation_id`,
`service`, `module_id`, `severity`. **Never** carries a secret, a credential, a
full PAN, or a complete identity document.

Log levels mean something specific here:

| Level | Meaning |
|---|---|
| `ERROR` | A financial operation failed. Someone looks today. |
| `WARN` | A degraded mode was entered (stale feed, LP down, fail-closed rejection). |
| `INFO` | A state transition worth reconstructing later. |
| `DEBUG` | Off in production. |

Note what is absent: there is no level for "an invariant was violated". That is not
a log line. It is a page.

## Alerting

| Class | Example | Response |
|---|---|---|
| **P0 page** | Invariant violated · funds at risk · T0 down | Immediate; halt authority |
| **P1 page** | Reconciliation break above threshold · risk engine degraded · LP all-down | Within minutes |
| **P2 ticket** | Elevated errors · latency SLO burn · projection lag | Same day |
| **P3 backlog** | Capacity trend · noisy dependency | Scheduled |

Alerts are on symptoms clients feel and on invariants that mean money is wrong —
not on CPU. Every alert links to the runbook that resolves it; an alert without a
runbook is a defect in the alert.

## Dashboards

- **Financial health** — ledger balance, invariant status, reconciliation breaks.
  The one on the wall.
- **Trading** — order flow, fill rates, rejection reasons, latency by stage.
- **Risk** — exposure, margin levels, liquidation queue, limit utilisation.
- **Platform** — service health, consumer lag, database, queue depth.
- **Release** — gate status per module, canary shadow-diff, error budget.

## Local stack

`make up-obs` brings up the OpenTelemetry Collector (4317/4318), Prometheus
(9090), Grafana (3001) and Jaeger (16686). Services emit the same telemetry
locally as in production, so an instrumentation gap is discovered on a laptop
rather than during an incident.

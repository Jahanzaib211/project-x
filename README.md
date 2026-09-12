# Project X — Broker Core

A brokerage platform built from first principles, in dependency order, where
**every module must prove its financial invariants before anything downstream of
it is allowed to exist.**

The organising idea is simple and unusual: this is not a feature backlog, it is a
**directed acyclic graph**. You cannot build the order book before the ledger.
You cannot ship the risk engine while the domain kernel is unproven. CI does not
merely run tests — it refuses to promote a module whose upstream dependencies
have not passed their own gates.

> The first deployable product is not the trading UI.
> It is a loop — market state → pricing → order → risk → execution → position →
> P&L → ledger → replay — that is mathematically correct, deterministic,
> crash-safe, replayable and fully reconciled. Everything else wraps that nucleus.

---

## Start here

| If you want to… | Read |
|---|---|
| Understand what this is and why it is shaped this way | [docs/00-overview.md](docs/00-overview.md) |
| Know the rules that are never broken | [docs/01-principles.md](docs/01-principles.md) |
| See the system layout | [docs/02-architecture.md](docs/02-architecture.md) |
| See what depends on what | [docs/03-dependency-dag.md](docs/03-dependency-dag.md) |
| **Understand the gates** | **[docs/04-gates.md](docs/04-gates.md)** |
| See the financial laws we enforce | [docs/05-invariants.md](docs/05-invariants.md) |
| Understand the pipeline | [docs/06-ci-cd.md](docs/06-ci-cd.md) |
| Know how it deploys | [docs/07-deployment-topology.md](docs/07-deployment-topology.md) |
| Run it locally | [docs/08-environments.md](docs/08-environments.md) |
| Know how we test | [docs/09-testing-strategy.md](docs/09-testing-strategy.md) |
| Contribute code | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Browse a module spec | [docs/modules/](docs/modules/README.md) |
| See what changed | [CHANGELOG.md](CHANGELOG.md) |

---

## Quick start

Requirements: Docker Engine with Compose v2+, GNU Make. Everything else runs in
containers.

```bash
cp .env.example .env
make up            # infra + core + edge + web
make health        # verify every service reports healthy
make logs          # follow
make down          # stop
make nuke          # stop and destroy all volumes (irreversible)
```

Then:

| Surface | URL |
|---|---|
| Web console | http://127.0.0.1:27000 |
| Client API | http://127.0.0.1:27001/health |
| Ledger service | http://127.0.0.1:27002/health |
| Market data | http://127.0.0.1:27003/health |
| Pricing | http://127.0.0.1:27004/health |
| OMS | http://127.0.0.1:27005/health |
| Redpanda console | http://127.0.0.1:27006 |
| Feed gateway | http://127.0.0.1:27021/v1/adapters |
| MT5 simulator | http://127.0.0.1:27022/v1/state |
| MT5 bridge (`--profile external`) | http://127.0.0.1:27023/v1/state |
| Project X Ops | http://127.0.0.1:27030 |
| Grafana | http://127.0.0.1:27014 |
| Prometheus | http://127.0.0.1:27013 |
| Jaeger | http://127.0.0.1:27015 |
| MinIO console | http://127.0.0.1:27012 |

**Prices.** A fresh install prices every instrument synthetically — a pure
function of the clock tick, exact to replay. The feed gateway runs whichever
real providers the operator console lists per instrument class (Binance is
keyless; Twelve Data and Finnhub take a key in `.env`; the MT5 bridge takes a
login) and the moment one speaks, that instrument is priced from the recorded
feed instead. Markets close: FX and metals keep their sessions, and an order on
a closed market is refused rather than filled at a frozen price.

**MT5.** `docker compose --profile external up -d mt5-bridge` runs a real
MetaTrader 5 terminal under Wine. Without `MT5_LOGIN`, `MT5_PASSWORD` and
`MT5_SERVER` it reports `unconfigured`; with any broker's demo login it streams
that login's quotes, mirrors the core's fills and is reconciled against the
ledger continuously — the platform is never the source of truth.

**Images.** Every push to `main` publishes the deployed images to
`ghcr.io/jahanzaib211/project-x/<service>:{sha,latest}` (ledger, market-data,
pricing, oms, feed-gateway, mt5-sim, client-api, web, ops); `make images`
rebuilds them from scratch locally and `make images-push` publishes by hand.

**On ports.** This project takes a reserved block, `27000–27030`, bound to
`127.0.0.1` only. `make up` runs `make ports` first and **refuses to start if any
of them is in use**, so it can never take a port from something already running
on your machine. Every port is an env var in `.env`; change one and nothing else
needs to change.

```bash
make ports        # verify the block is free, and see who holds anything that isn't
make urls         # print every local URL
```

Compose profiles let you run less than the whole thing:

```bash
make up-infra     # datastores + bus only
make up-core      # infra + the financial core services
make up-obs       # observability stack
docker compose --profile infra --profile core up -d
```

---

## The gate model in one table

Every module declares which gates it must pass. Nothing downstream may be merged
or deployed while an upstream module is short of its declared gates — and that
rule is machine-checked, not remembered.

| | CI gates | | CD stages |
|---|---|---|---|
| `G0` | Compile and format | `G10` | Staging |
| `G1` | Static correctness | `G11` | Canary |
| `G2` | Unit tests | `G12` | Production |
| `G3` | Property-based tests | | |
| `G4` | **Domain invariants** | | |
| `G5` | Integration tests | | |
| `G6` | **Deterministic replay** | | |
| `G7` | Fault and chaos | | |
| `G8` | Security | | |
| `G9` | Performance | | |

`G0`, `G1`, `G2` and `G4` are **non-waivable on every module, without exception.**

Check the graph and the gate state yourself:

```bash
make check          # DAG validity + gate rule + doc freshness
python3 scripts/check_dag.py
python3 scripts/check_gates.py 11-execution   # what is blocking execution?
```

Full detail: [docs/04-gates.md](docs/04-gates.md).

---

## Module status

Dependency order. A module cannot start until everything it depends on is green.

<!-- BEGIN:STATUS -->
| # | Module | Tier | Name | Status | Required gates |
|---|---|---|---|---|---|
| 1 | [`00-foundation`](docs/modules/00-foundation.md) | T0 | Engineering Foundation | `in-progress` | G0 G1 G2 G4 |
| 2 | [`01-domain-kernel`](docs/modules/01-domain-kernel.md) | T0 | Domain Kernel (types + math) | `in-progress` | G0 G1 G2 G3 G4 |
| 3 | [`02-event-kernel`](docs/modules/02-event-kernel.md) | T0 | Event Kernel (identity, clock, envelope) | `in-progress` | G0 G1 G2 G3 G4 G5 G6 |
| 4 | [`03-ledger`](docs/modules/03-ledger.md) | T0 | Double-Entry Ledger | `in-progress` | G0 G1 G2 G3 G4 G5 G6 G7 G8 |
| 5 | [`04-account`](docs/modules/04-account.md) | T0 | Account Engine | `in-progress` | G0 G1 G2 G3 G4 G5 G6 |
| 6 | [`05-position`](docs/modules/05-position.md) | T0 | Position Engine | `in-progress` | G0 G1 G2 G3 G4 G5 G6 G7 |
| 7 | [`06-market-data`](docs/modules/06-market-data.md) | T1 | Market Data | `in-progress` | G0 G1 G2 G3 G4 G5 G6 G7 G9 |
| 8 | [`07-pricing`](docs/modules/07-pricing.md) | T1 | Pricing Engine | `in-progress` | G0 G1 G2 G3 G4 G5 G6 G7 G8 G9 |
| 9 | [`08-pnl-margin`](docs/modules/08-pnl-margin.md) | T0 | P&L and Margin | `in-progress` | G0 G1 G2 G3 G4 G5 G6 G7 G8 G9 |
| 10 | [`09-risk`](docs/modules/09-risk.md) | T0 | Risk Engine | `in-progress` | G0 G1 G2 G3 G4 G5 G6 G7 G8 G9 |
| 11 | [`10-oms`](docs/modules/10-oms.md) | T0 | Order Management System | `in-progress` | G0 G1 G2 G3 G4 G5 G6 G7 G8 G9 |
| 12 | [`11-execution`](docs/modules/11-execution.md) | T0 | Execution Core | `in-progress` | G0 G1 G2 G3 G4 G5 G6 G7 G8 G9 |
| 13 | [`12-risk-book`](docs/modules/12-risk-book.md) | T1 | Internal Risk Book | `planned` | G0 G1 G2 G3 G4 G5 G6 G7 G9 |
| 14 | [`13-lp-connectivity`](docs/modules/13-lp-connectivity.md) | T1 | LP / FIX Connectivity | `in-progress` | G0 G1 G2 G3 G4 G5 G6 G7 G8 G9 |
| 15 | [`14-hedging`](docs/modules/14-hedging.md) | T1 | Routing and Hedging | `planned` | G0 G1 G2 G3 G4 G5 G6 G7 G9 |
| 16 | [`15-reconciliation`](docs/modules/15-reconciliation.md) | T2 | Reconciliation | `planned` | G0 G1 G2 G3 G4 G5 G6 G7 G8 |
| 17 | [`16-kyc-aml`](docs/modules/16-kyc-aml.md) | T3 | KYC / AML / Fraud | `planned` | G0 G1 G2 G3 G4 G5 G8 |
| 18 | [`17-payments`](docs/modules/17-payments.md) | T2 | Payments and Treasury | `planned` | G0 G1 G2 G3 G4 G5 G6 G7 G8 |
| 19 | [`18-compliance`](docs/modules/18-compliance.md) | T3 | Compliance and Reporting | `planned` | G0 G1 G2 G3 G4 G5 G8 |
| 20 | [`19-client-api`](docs/modules/19-client-api.md) | T4 | Client API | `in-progress` | G0 G1 G2 G3 G4 G5 G8 G9 |
| 21 | [`20-web`](docs/modules/20-web.md) | T4 | Web and Mobile | `in-progress` | G0 G1 G2 G4 G5 G8 |
| 22 | [`21-external`](docs/modules/21-external.md) | T4 | External Platform Integrations (MT5 et al.) | `in-progress` | G0 G1 G2 G4 G5 G6 G8 |
<!-- END:STATUS -->

Source of truth: [`registry/modules.yaml`](registry/modules.yaml). Module pages
are generated from it (`make docs`), so the documentation cannot drift from the
graph that CI enforces.

---

## Repository layout

```
.
├── README.md                  you are here
├── CHANGELOG.md               what changed, and which gates it passed
├── CONTRIBUTING.md            how to work in this repo
├── SECURITY.md                vulnerability handling, secret policy
├── docker-compose.yml         the whole stack, in profiles
├── Makefile                   every command you need
│
├── registry/modules.yaml      THE DAG — modules, deps, required gates
├── gates/gates.yaml           THE GATES — definitions and checks
├── gates/status.yaml          gate results, written by CI
│
├── scripts/                   check_dag.py, check_gates.py, gen_docs.py
│
├── docs/                      hand-written architecture and process docs
│   ├── modules/               generated module specs (one per module)
│   ├── adr/                   architecture decision records
│   └── runbooks/             operational procedures
│
├── crates/                    Rust — the financial core libraries
│   ├── domain-kernel/         Money, Price, Quantity — fixed-point, no floats
│   └── event-kernel/          event envelope, identity, replay
│
├── services/                  deployable services
│   ├── ledger/                Rust — double-entry ledger        (T0)
│   ├── market-data/           Rust — canonical market state     (T1)
│   ├── pricing/               Rust — MarketState -> ClientQuote  (T1)
│   ├── oms/                   Rust — order state machine        (T0)
│   └── client-api/            TypeScript — REST/WS edge          (T4)
│
├── apps/web/                  Next.js — trading terminal        (T4)
├── tests/                     cross-module suites
│   ├── invariants/            G4 — the financial laws
│   ├── replay/                G6 — determinism
│   └── integration/           G5 — services wired together
└── infra/                     container configuration
```

---

## Why the stack is what it is

| Layer | Choice | Reason |
|---|---|---|
| Financial core | **Rust** | Fixed-point arithmetic without a garbage collector, exhaustive matching, and a type system that can make cross-currency addition a compile error. Determinism is a property we need to prove, not hope for. |
| Edge services | **TypeScript / Node** | Velocity where the blast radius is inconvenience, not money. |
| Web | **Next.js** | Presentation only; owns no financial truth. |
| Event store + ledger | **PostgreSQL** | Real transactions, real constraints, boring and well understood. |
| Event bus | **Redpanda** | Kafka API, single binary, ordered partitions, no ZooKeeper. |
| Projections / cache | **Redis** | Rebuildable state only. Never a source of truth. |
| Reporting | **ClickHouse** | Analytical reads kept strictly off the transactional path. |
| Object storage | **MinIO** | Documents, statements, artifacts. |
| Observability | **OpenTelemetry + Prometheus + Grafana + Jaeger** | Invariant violations are alerts, not log lines. |

Reasoning in full: [docs/adr/](docs/adr/).

---

## Non-negotiables

1. **No floating point in financial code.** Ever. Enforced by a lint at `G1`.
2. **No direct balance mutation.** Money moves through the ledger or it does not move.
3. **The event log is append-only**, and replaying it reproduces the present state exactly.
4. **Exactly-once financial effect.** Retries are safe; charges are not repeatable.
5. **Risk fails closed.** An unavailable risk engine rejects; it never allows.
6. **The UI never owns financial truth.**
7. **Zero unexplained financial discrepancies** before any production release.

Each of these is a test, not an aspiration. See [docs/05-invariants.md](docs/05-invariants.md).

---

## Project status

**Phase 0 — foundation.** The DAG, the gate machinery, the documentation and the
Compose environment exist and are enforced. Module `01-domain-kernel` is the next
thing to build, and nothing financial can be built before it.

See [docs/14-roadmap.md](docs/14-roadmap.md) and [CHANGELOG.md](CHANGELOG.md).

## Licence

Proprietary. See [LICENSE](LICENSE).

# 08 — Environments

## Local (Docker Compose)

```bash
cp .env.example .env
make up          # infra + core + edge + web
make health
make logs
make down
make nuke        # destroys volumes — irreversible
```

### Profiles

| Profile | Contains | Command |
|---|---|---|
| `infra` | Postgres, Redpanda, Redis, ClickHouse, MinIO | `make up-infra` |
| `core` | ledger, market-data, pricing, oms (+ infra) | `make up-core` |
| `edge` | client-api | `make up-edge` |
| `web` | Next.js terminal | `make up-web` |
| `obs` | OTel Collector, Prometheus, Grafana, Jaeger | `make up-obs` |

Run only what you need. Working on the ledger does not require the web app.

### Ports

Development machines are crowded. Rather than claiming the conventional ports —
3000, 5432, 6379, 8080, 9090 — and colliding with whatever else you run, this
project takes a **reserved block, `27000–27019`, bound to `127.0.0.1` only**.

| Service | Port | | Service | Port |
|---|---|---|---|---|
| web | 27000 | | ClickHouse HTTP | 27009 |
| client-api | 27001 | | ClickHouse native | 27010 |
| ledger | 27002 | | MinIO API | 27011 |
| market-data | 27003 | | MinIO console | 27012 |
| pricing | 27004 | | Prometheus | 27013 |
| oms | 27005 | | Grafana | 27014 |
| Redpanda console | 27006 | | Jaeger UI | 27015 |
| PostgreSQL | 27007 | | OTLP gRPC | 27016 |
| Redis | 27008 | | OTLP HTTP | 27017 |
| | | | Redpanda Kafka | 27018 |

Three properties, all deliberate:

- **Nothing binds to `0.0.0.0`.** The stack is not reachable from your network.
- **`make up` runs `make ports` first and refuses to start if any port is taken.**
  It will never displace a running process, and it names what holds the port.
- **Every port is an env var** in `.env`. Change one; nothing else changes.

```bash
make ports    # verify the block, and identify anything holding a port
make urls     # print every local URL
```

Container-internal ports are conventional (`8000` for services, `5432` for
Postgres); only the host mapping uses the reserved block, so nothing inside the
compose network needs to know about any of this.

### Local data

All synthetic. Recorded market-data fixtures and event logs used by `G6` live in
`tests/replay/fixtures/` and are treated as test assets, versioned with the code
that consumes them.

**No production data ever reaches a developer machine.** Not anonymised, not
sampled, not "just this once for debugging".

## Integration

Fed by every merge to `main`. Runs the slow gates — `G5`, `G6`, `G7`, `G8`, `G9` —
that are too expensive for a PR. Ephemeral: destroyed and recreated per run, so a
passing suite cannot depend on accumulated state.

## Staging

Production-shaped: same topology, same tier isolation, same deployment mechanism,
scaled down. Data is anonymised and production-*shaped* — same distributions, same
edge cases, no real identities.

Gate `G10` runs here: synthetic order flow, full historical replay, and financial
reconciliation across the window with zero unexplained breaks.

## Canary

Real production, real money, a limited slice of traffic. Gate `G11`. The new
version runs alongside the incumbent, and their financial outputs are diffed on
identical input. Automatic rollback on any invariant violation.

## Production

Gate `G12`. Progressive rollout, continuous invariant monitoring, post-deploy
reconciliation watch, rehearsed rollback to the previous digest.

## Configuration

Configuration is environment variables, loaded once at startup, validated at
startup, and **never re-read** — a config value that can change under a running
computation is a determinism bug.

Rules:

- Names and descriptions live in `.env.example`; values never do.
- Local development credentials are deliberately weak and deliberately obvious,
  and must never appear outside a developer machine.
- Every non-local secret comes from the secret manager at runtime, is rotatable
  without a code change, and has a named owner.
- **Risk, pricing and margin policy are not configuration.** They are versioned
  data with their own review path, recorded on every decision they influence, so
  that a decision can be reproduced years later against the exact policy that
  produced it.

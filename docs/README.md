# Documentation

Hand-written documents are numbered. Module specifications in [`modules/`](modules/README.md)
are **generated** from [`registry/modules.yaml`](../registry/modules.yaml) — edit the
registry, then run `make docs`.

## Read in this order

| Doc | What it answers |
|---|---|
| [00 — Overview](00-overview.md) | What is this, what is in scope, what is deliberately not |
| [01 — Principles](01-principles.md) | The rules that are never broken, and why each exists |
| [02 — Architecture](02-architecture.md) | How the system is put together |
| [03 — Dependency DAG](03-dependency-dag.md) | What depends on what, and in what order it gets built |
| [04 — Gates](04-gates.md) | G0–G12, what each proves, how the rule is enforced |
| [05 — Invariants](05-invariants.md) | The financial laws, as an enforced catalogue |
| [06 — CI/CD](06-ci-cd.md) | The pipeline, PR to production |
| [07 — Deployment topology](07-deployment-topology.md) | Tiers, blast radius, failure isolation |
| [08 — Environments](08-environments.md) | Local, dev, staging, canary, production |
| [09 — Testing strategy](09-testing-strategy.md) | What each kind of test is for |
| [10 — Security](10-security.md) | Threat model and controls |
| [11 — Observability](11-observability.md) | Metrics, traces, logs, invariant monitors |
| [12 — Data stores](12-data-stores.md) | Which store holds what, and which are rebuildable |
| [13 — Glossary](13-glossary.md) | Terms, used precisely |
| [14 — Roadmap](14-roadmap.md) | Phases and the definition of done for each |

## Reference

- [`modules/`](modules/README.md) — one page per module, generated
- [`adr/`](adr/) — architecture decision records
- [`runbooks/`](runbooks/) — operational procedures

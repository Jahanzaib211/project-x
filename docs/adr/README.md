# Architecture Decision Records

A decision that would be expensive to reverse gets a record. The point is not
ceremony — it is that in two years someone will ask "why is it like this?", and
the answer should be a document rather than an archaeology exercise.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-dependency-dag-and-gates.md) | Build order is a DAG, enforced by gates | Accepted |
| [0003](0003-fixed-point-money.md) | Money is fixed-point and currency-typed | Accepted |
| [0004](0004-event-sourcing-and-double-entry.md) | Event sourcing plus a double-entry ledger | Accepted |
| [0005](0005-language-choices.md) | Rust for the core, TypeScript at the edge | Accepted |
| [0006](0006-zero-dependency-core.md) | The financial core has no external dependencies | Accepted |
| [0007](0007-docs-generated-from-registry.md) | Documentation is generated and gated | Accepted |

Template: Context → Decision → Consequences → Alternatives considered.

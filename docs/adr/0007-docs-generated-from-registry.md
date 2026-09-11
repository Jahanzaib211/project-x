# ADR-0007 — Documentation is generated from the registry, and gated

**Status:** Accepted

## Context

Documentation that disagrees with the system is worse than no documentation: it
is confidently wrong, and people act on it. In a regulated domain, a module
specification claiming an invariant the code does not enforce is a real liability.

The usual failure is mundane. Someone adds a module, or changes what a module
must prove, and the docs describing it are updated later — which means never.

## Decision

`registry/modules.yaml` is the **single source of truth** for the dependency
graph, tiers, required gates, declared invariants, test obligations and known
failure modes.

Generated from it by `scripts/gen_docs.py`:

- `docs/modules/*.md` — one specification per module
- `docs/modules/README.md` — index and required-gate matrix
- the graph in `docs/03-dependency-dag.md`
- the invariant catalogue in `docs/05-invariants.md`
- the status matrix in `README.md`

**Staleness is a blocking CI failure on every push, every pull request and every
merge.** CI runs `gen_docs.py --check`, then regenerates and asserts `git diff`
is empty — which additionally catches a hand edit to a generated file that
`--check` alone would miss. The pre-commit hook regenerates and stages the docs
automatically when the registry changes, so this failure should rarely reach CI.

CI also verifies that every required hand-written document still exists, and that
a PR touching code or the registry updates `CHANGELOG.md`.

## Consequences

- The docs cannot drift from the graph CI enforces. That is the entire point.
- Changing a module's specification means editing the registry, which is also
  what changes CI's behaviour — the description and the enforcement move together.
- Generated files must not be hand-edited. They carry a banner saying so, and CI
  catches it if someone does.
- Prose that is genuinely prose — principles, architecture, threat model — stays
  hand-written. Generation is for what is derived, not for everything.

## Alternatives considered

**Hand-written module docs.** Drift immediately, and there are 22 of them.

**Docs in code comments, extracted.** Works for API reference. Does not work for
cross-cutting facts like "which gates must this module pass", which belong to the
module, not to a function.

**A documentation site tool.** Solves publishing, not truth. The problem here was
never rendering.

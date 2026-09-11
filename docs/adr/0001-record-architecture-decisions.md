# ADR-0001 — Record architecture decisions

**Status:** Accepted

## Context

This system will outlive the memory of the people building it, and it operates in
a domain where "why is it like this?" is sometimes asked by a regulator rather
than a colleague. Decisions that are expensive to reverse — the money
representation, the consistency model, the deployment tiers — need a written
rationale, not folklore.

## Decision

Significant architectural decisions are recorded as numbered ADRs in
`docs/adr/`. An ADR records the context, the decision, the consequences the team
accepted, and the alternatives that were rejected and why.

An ADR is required to weaken or remove a declared invariant. That is the single
hard requirement; everything else is judgement.

## Consequences

- Decisions are reviewable as decisions, separately from the code implementing them.
- Reversing a decision means superseding an ADR, which makes the cost visible.
- Some decisions get recorded that turn out not to matter. Acceptable.

## Alternatives considered

**Documenting decisions in the wiki.** Wikis drift from the code and are not
reviewed. ADRs live in the repository and go through the same review as code.

**Not recording decisions.** Works while the original team is present, and fails
exactly when it is most costly — during an audit, or after turnover.

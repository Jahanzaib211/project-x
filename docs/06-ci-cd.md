# 06 — CI/CD

## Pull request pipeline

Fail-fast, cheapest first. A formatting error should not consume a chaos runner.

```
   PR opened
      │
      ▼
  ┌────────────────────┐
  │ GRAPH CHECK        │  check_dag.py · check_gates.py · docs freshness
  └────────┬───────────┘  ← fails immediately if you are building on unproven ground
      ▼
  G0 format / compile
      ▼
  G1 static analysis ── SAST · deps · secrets · licences · banned patterns
      ▼
  G2 unit
      ▼
  G3 property
      ▼
  G4 domain invariants          ← the financial laws
      ▼
  G5 integration (compose)
      ▼
  G8 security
      ▼
  BUILD ARTIFACT → SBOM → SIGN
      ▼
  MERGE
```

The graph check runs **first**, before compilation. If your module is blocked by
an upstream module's missing gates, you learn it in fifteen seconds rather than
after a forty-minute suite.

`G6` (replay), `G7` (chaos) and `G9` (performance) are too slow for every PR. They
run on merge to `main`, on a schedule, and always before a release. A PR that
touches a module requiring them can opt in with a label.

## Main branch pipeline

```
main
 ├─ build + sign artifact (digest is the identity from here on)
 ├─ deploy to integration environment
 ├─ G6  deterministic replay suite
 ├─ G7  fault and chaos suite
 ├─ G9  performance suite (vs. last release baseline)
 ├─ G8  full security suite
 └─ promote to STAGING
```

Every subsequent stage refers to the **artifact digest**, never to a branch name
or a tag. What was tested is what deploys.

## Release pipeline

```
STAGING (G10)
 │  synthetic order flow through the full path
 │  full historical replay
 │  financial reconciliation across the window   ← zero unexplained breaks
 ▼
APPROVAL
 │  tier policy: T0 two financial-core owners · T1/T2 owner · T3 compliance owner
 │  approval is recorded against the artifact digest
 ▼
CANARY (G11)
 │  limited slice
 │  shadow-diff against incumbent on identical input
 │  invariant monitors · error rate · latency · reconciliation breaks
 │  automatic rollback on any invariant violation
 ▼
PRODUCTION (G12)
 │  progressive rollout
 │  post-deploy invariant and reconciliation watch
 ▼
DONE
```

## Modules that always require a human

Automated gates decide whether a change *may* ship. A person decides whether it
*does*. Changes to any of these require recorded manual approval even with every
gate green:

```
ledger · risk · margin · P&L · execution · pricing · liquidation
```

The reason is not distrust of the tests. It is that these modules can be wrong in
ways no test encodes, and the cost of being wrong is measured in client money and
regulatory standing.

## Artifact rules

1. **One build.** The artifact built at merge is the artifact that reaches
   production. Nothing is rebuilt per environment.
2. **Signed and attested.** Every image is signed; provenance and SBOM are attached
   and verified at deploy.
3. **Digest-addressed.** Deployments reference `sha256:…`, never a mutable tag.
4. **Reproducible.** The same commit produces the same digest; drift is a `G0`
   failure.
5. **Immutable.** No hotfix is ever applied to a running container. Fix forward or
   roll back to a previous digest.

## Rollback

Every deployment records the previous digest and a rehearsed rollback command.
Rollback is automatic on:

- any invariant monitor violation during canary
- reconciliation breaks above threshold
- error rate or latency SLO burn beyond budget

**Database migrations are the constraint on rollback.** Every migration is
backward-compatible for at least one release: expand, deploy, migrate data,
contract in a later release. A migration that cannot be rolled back is a design
error, and it is caught at `G5`, which tests migrations up and down.

## Environments

| Environment | Fed by | Data | Purpose |
|---|---|---|---|
| **Local** | Compose | Synthetic | Development |
| **Integration** | Every merge to `main` | Synthetic + recorded fixtures | G5–G9 |
| **Staging** | Promoted artifact | Anonymised production-shaped | G10 |
| **Canary** | Approved artifact | Real, limited slice | G11 |
| **Production** | Approved artifact | Real | G12 |

Detail in [08 — Environments](08-environments.md).

## What CI does that is unusual

- **Refuses to build on unproven ground** — the graph check, first, every time.
- **Executes the financial laws** — `G4` is not a metaphor; the invariants in the
  registry are tests.
- **Proves the past reproduces the present** — `G6`, on every Tier 0 module.
- **Breaks things on purpose and re-checks the laws afterwards** — `G7` asserts
  invariants and replay equivalence *after each injected fault*.
- **Compares financial output between versions** — shadow-diff at `G11`, where any
  difference in a pure function is either intended or a bug.
- **Fails when the docs drift** — `make docs-check`, because documentation that
  disagrees with the enforced graph is worse than none.

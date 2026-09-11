## What and why

<!-- One paragraph. What changes, and what problem it solves. -->

## Module(s)

<!-- Registry ids, e.g. 03-ledger. Run: python3 scripts/check_gates.py <module-id> -->

- Module:
- Tier:
- Blocked by upstream gates? `no` / `yes — explain`

## Invariant impact

<!-- Required for any change to a Tier 0/1/2 module. -->

- [ ] **Unchanged** — no declared invariant is added, modified or removed
- [ ] **Added** — new invariant(s) declared in `registry/modules.yaml` *and* implemented in `tests/invariants/`
- [ ] **Modified or removed** — ADR linked below, approved by a financial-core owner

ADR (if applicable):

## Gates

<!-- CI fills these in; confirm what you ran locally. -->

- [ ] `make check` — DAG, gate rule, docs fresh, no regressions, invariant coverage
- [ ] `G0` format and compile
- [ ] `G1` static analysis and banned patterns
- [ ] `G2` unit tests
- [ ] `G3` property tests
- [ ] `G4` domain invariants
- [ ] `G5` integration
- [ ] Slow gates (`G6` replay, `G7` chaos, `G9` performance) — needed? add the `full-gates` label

## Checklist

- [ ] `CHANGELOG.md` updated (modules, gates, approver, invariant impact)
- [ ] Docs regenerated if the registry changed (`make docs`)
- [ ] `gates/baseline.json` updated if the ratchet moved deliberately (`make baseline`)
- [ ] No floating point on a financial path
- [ ] No direct balance mutation — money moves through the ledger
- [ ] No wall-clock read inside the determinism boundary
- [ ] No `unwrap`/`expect`/`any`/non-null assertion on a money path
- [ ] No test skipped or ignored without a linked issue
- [ ] Tier 0/1/2: second reviewer with financial-core ownership

## Rollback

<!-- How is this reverted? Any migration that makes rollback harder? -->

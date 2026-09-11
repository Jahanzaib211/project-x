# Contributing to Project X

Read [docs/01-principles.md](docs/01-principles.md) before your first change.
This document covers process; that one covers the rules the process defends.

---

## The one rule that governs everything

**A module may not be built, merged or deployed while any module it depends on is
short of that dependency's declared gates.**

This is not a convention. `scripts/check_gates.py` runs in CI and fails the build.
Before you start work:

```bash
python3 scripts/check_gates.py <your-module-id>
```

If it says `BLOCKED`, you are working on the wrong thing. Go fix the upstream
module, or pick work that is unblocked — [`docs/modules/README.md`](docs/modules/README.md)
lists everything in dependency order.

---

## Before you write code

1. **Find your module** in [`registry/modules.yaml`](registry/modules.yaml).
2. **Read its declared invariants.** They are the specification. If your change
   makes one false, you are not making a change — you are making a proposal, and
   it needs an ADR.
3. **Check the gates your module requires.** You will need to satisfy all of them.
4. **Check the known failure modes.** They are there because systems like this one
   fail in those ways. Do not rediscover them in production.

If your work needs a module that does not exist in the registry, add it to the
registry first, in its own PR, with its dependencies, gates and invariants
declared. The graph is designed before it is built.

---

## Development workflow

```bash
make up                  # bring up the stack
make check               # DAG + gates + doc freshness  (run this before pushing)
make fmt                 # format everything
make lint                # G1 static analysis
make test                # G2 unit tests
make test-property       # G3
make test-invariants     # G4  — the financial laws
make test-integration    # G5
make test-replay         # G6  — determinism
make gates MODULE=03-ledger   # run every gate your module declares
```

`make check` is the minimum before you push. `make gates MODULE=…` is what CI
will run against you.

---

## Branches and commits

Branch names: `<module-id>/<short-description>`, for example
`03-ledger/posting-rules`.

Commit messages are [Conventional Commits](https://www.conventionalcommits.org/)
with the module id as scope:

```
feat(03-ledger): add multi-currency posting rules

Posting rules become declarative data rather than code, so that G4 can
assert debits == credits per currency across generated transactions.

Invariants: INV-021 now enforced per-currency, not only per-transaction.
Refs: ADR-0004
```

A commit that touches financial behaviour states what happened to the invariants,
even when the answer is "unchanged".

---

## Pull requests

Every PR runs, in order and fail-fast:

```
format → static analysis → unit → property → invariants
       → integration → security scan → build → sign → merge
```

A PR is mergeable when:

- [ ] every gate its module declares is green
- [ ] `make check` passes (graph is acyclic, gate rule holds, docs are fresh)
- [ ] new invariants are declared in the registry **and** implemented in `tests/invariants/`
- [ ] `CHANGELOG.md` has an entry, with gates and approver where required
- [ ] no new dependency on a module that has not passed its own gates
- [ ] Tier 0/1/2 changes have a second reviewer with financial-core ownership

### Things that will get a PR rejected on sight

- Floating point anywhere near money.
- A balance mutated without a ledger transaction.
- An `unwrap`, `expect`, `!` non-null assertion or unchecked cast on a financial path.
- A test disabled, skipped or `#[ignore]`d without a linked issue.
- An invariant deleted or weakened without an ADR.
- Wall-clock time used for ordering instead of the event sequence.
- Non-deterministic iteration order in anything that gets serialized or replayed.
- A `TODO` in a Tier 0 module without an issue link.

---

## Changing an invariant

Invariants are the specification of the system's financial behaviour. To change one:

1. Write an ADR in [`docs/adr/`](docs/adr/) explaining what the old invariant
   asserted, why it is wrong or insufficient, and what replaces it.
2. Update the invariant in `registry/modules.yaml` and in the catalogue at
   [`docs/05-invariants.md`](docs/05-invariants.md).
3. Update the test in `tests/invariants/`. The test changes in the same PR as the
   declaration — never a PR apart.
4. Get approval from a financial-core owner.
5. Record it in `CHANGELOG.md` under its own entry.

Deleting an invariant without a replacement requires an explicit, recorded
decision from the risk owner. It is not a refactor.

---

## Adding a module

1. Add the entry to `registry/modules.yaml`: id, name, tier, `depends_on`,
   `required_gates`, purpose, inputs, outputs, builds, invariants, tests,
   failure modes.
2. Run `python3 scripts/check_dag.py` — it will tell you if you created a cycle
   or omitted a non-waivable gate.
3. Run `make docs` to generate the module page.
4. Open the PR with the registry change alone, so the graph can be reviewed
   before any code exists to bias the discussion.

---

## Code style

- **Rust** (financial core): `rustfmt` default, `clippy` at deny-warnings, no
  `unsafe` without a written justification, no `unwrap`/`expect` outside tests
  and startup, exhaustive matches with no catch-all arm in state machines.
- **TypeScript** (edge): `strict` with no exceptions, no `any`, no non-null
  assertion, `eslint` at error, all money handled as the API's decimal string —
  never parsed into a `number`.
- **Everything**: no dead code, no commented-out code, no speculative
  abstraction. Comment *why*, never *what*.

---

## Getting help

- What is blocking me? → `python3 scripts/check_gates.py <module-id>`
- What does this module do? → `docs/modules/<module-id>.md`
- Why is it built this way? → `docs/adr/`
- Something is on fire → `docs/runbooks/`

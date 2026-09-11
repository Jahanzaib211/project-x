# 04 — Gates

A **gate** is a named, mechanically-checkable proof obligation. Modules declare
which gates they must pass. CI refuses to promote an artifact past a gate the
module declares but has not passed, and refuses to merge a module whose upstream
dependencies are short of theirs.

Definitions live in [`gates/gates.yaml`](../gates/gates.yaml).
Results live in [`gates/status.yaml`](../gates/status.yaml), written by CI.
Enforcement lives in [`scripts/check_gates.py`](../scripts/check_gates.py).

---

## Why ordinary CI is not enough

The industry-standard pipeline is:

```
lint → test → build → deploy
```

That pipeline answers one question: *did the code the author thought about behave
as the author expected?* For a system that moves client money, at least six more
questions matter, and none of them are answered above:

| Question | Gate |
|---|---|
| Does it hold for inputs nobody wrote down? | `G3` property tests |
| Are the financial laws of this system still true? | `G4` invariants |
| Does replaying history reproduce the present, exactly? | `G6` deterministic replay |
| What happens when the machine, network or database betrays you? | `G7` fault and chaos |
| Can someone take money that is not theirs? | `G8` security |
| Did this change quietly make the hot path slower? | `G9` performance |

`G4` and `G6` are the two that most distinguish this pipeline from a normal one.
`G4` executes the system's financial laws as tests. `G6` proves that the entire
state of the business is a pure function of its recorded history.

---

## The gates

### CI gates — run on code

#### `G0` — Compile and format
*Does it build, and does it look like the rest of the tree?*

Compiles all targets; the formatter is a no-op; lockfiles are committed and
unchanged; no generated file has drifted (`make docs-check`).

Runtime: < 2 min.

#### `G1` — Static correctness
*Can a machine prove anything is wrong without running it?*

Linters at deny-warnings. Type checking with no escape hatches in financial code.
SAST. Dependency vulnerability scan. Secret scan, verified against a planted
canary. License policy. And the **banned-pattern scan**, which is where this
project's rules become mechanical:

- floating-point types in financial code paths
- `unwrap` / `expect` / `!` / unchecked casts on money paths
- direct balance mutation (`balance +=`, `balance =`)
- wall-clock reads inside the determinism boundary
- non-deterministic iteration in serialized or replayed code

Runtime: < 5 min.

#### `G2` — Unit tests
*Does each piece do what its author claimed?*

Suite green; per-module coverage floor; no skipped or ignored test without a
linked issue.

Runtime: < 5 min.

#### `G3` — Property-based tests
*Does it hold for inputs nobody thought to write down?*

Properties over generated inputs, with shrinking enabled and failures reproducible
from a recorded seed. **Every counterexample the generator finds is committed as a
regression test**, so the same shape of bug can never return silently.

Runtime: < 15 min.

#### `G4` — Domain invariants
*Are the financial laws of this system still true?*

Every `INV-*` a module declares in the registry is executed as a test. Invariant
coverage is checked: a module may not declare a law it does not run —
`scripts/check_dag.py` fails the build if a module declares invariants without
requiring `G4`.

Invariants are asserted **continuously during randomized scenario runs**, not only
at the end of a test. A ledger that balances at the end but was unbalanced in the
middle has a window in which a reader saw impossible money.

Runtime: < 20 min. **Non-waivable on every module.**

#### `G5` — Integration tests
*Do the pieces still agree once they are wired together?*

Service-to-service suites against real dependencies in Compose — the real
Postgres, the real bus, not mocks. Contract tests run identically against every
adapter and its simulator. Migrations tested up *and* down.

Runtime: < 30 min.

#### `G6` — Deterministic replay
*Does replaying history reproduce the present, exactly?*

Replay a recorded event log from genesis and assert byte-identical resulting
state. Across process restarts. Across machines. And `snapshot + tail replay` must
equal `full replay`, because otherwise snapshots are a second, divergent truth.

Runtime: < 30 min.

#### `G7` — Fault and chaos
*What happens when the machine, network or database betrays you?*

Process kill at randomized commit boundaries. Database failover and connection
loss. Network partition, packet loss, latency injection. Clock skew and clock
jump. After **every** injected fault: invariants still hold, and replay
equivalence still holds.

Runtime: < 60 min.

#### `G8` — Security
*Can someone take money, data or availability that is not theirs?*

Authn/authz test matrix. Input fuzzing on every external boundary. Dependency and
container image scanning. Secret handling and key rotation. Audit log completeness
and tamper evidence.

Runtime: < 30 min.

#### `G9` — Performance
*Is it fast enough, and did this change make it worse?*

Benchmarks against the module's recorded SLO on reference hardware; regression
comparison against the last release baseline; allocation and memory budget;
sustained-load soak without degradation.

**SLO numbers are established by measurement on target hardware and recorded per
module. This repository does not contain a guessed latency target**, because a
guessed SLO produces false confidence and misleading alerts.

Runtime: < 45 min.

### CD stages — run on an environment

#### `G10` — Staging
Deploy; drive synthetic order flow through the full path; run a full historical
replay against staging; require financial reconciliation to be clean across the
window; no error-budget burn during the soak.

#### `G11` — Canary
Deploy to a limited slice. **Shadow-diff**: run the new version against the
incumbent on identical input and compare financial outputs — for pricing and risk,
which are pure functions, any difference is either an intended change or a bug,
and there is no third option. Watch invariant monitors, error rate, latency and
reconciliation breaks. **Automatic rollback on any invariant violation.**

#### `G12` — Production
All prior gates green **on this exact artifact digest**. Release approval recorded
per the module's tier policy. Rollback plan verified and rehearsed. Post-deploy
invariant and reconciliation watch.

---

## The gate rule

> **A module may not be promoted past a gate if any module it depends on,
> transitively, has not itself passed every gate that dependency declares.**

```bash
$ python3 scripts/check_gates.py 03-ledger
BLOCKED  03-ledger
         upstream: 00-foundation has not passed G2, G4
         upstream: 01-domain-kernel has not passed G0, G1, G2, G3, G4
         upstream: 02-event-kernel has not passed G0, G1, G2, G3, G4, G5, G6
```

This is what stops the most common failure in ambitious systems: building the
exciting thing on top of the unproven thing, and discovering the foundation was
wrong after everything depends on it.

## Non-waivable gates

`G0`, `G1`, `G2` and `G4` **cannot be waived on any module, for any reason.**
`scripts/check_dag.py` fails the build if a module's registry entry omits one.

There is no `--skip-gates` flag and none will be added. The emergency path is
documented — [`runbooks/emergency-change.md`](runbooks/emergency-change.md) — and
it narrows scope and adds humans; it does not remove proof.

## Gate requirements by tier

| Tier | Typical required gates | Release approval |
|---|---|---|
| **T0** Financial Core | G0–G9 | Manual, two reviewers |
| **T1** Market Infrastructure | G0–G9 (G9 mandatory) | Manual |
| **T2** Financial Operations | G0–G8 | Manual, reconciliation clean |
| **T3** Compliance | G0–G5, G8 | Compliance owner |
| **T4** Experience | G0–G5, G8, G9 where hot | Automated canary |

Per-module requirements are in the registry and rendered in the
[module gate matrix](modules/README.md#required-gate-matrix).

## Running gates locally

```bash
make check                     # DAG validity + gate rule + doc freshness
make gates MODULE=03-ledger    # run every gate that module declares
make test-invariants           # G4 alone
make test-replay               # G6 alone
python3 scripts/check_gates.py --strict   # fail if anything is blocked
```

## How results are recorded

CI writes to `gates/status.yaml` as each module's gates pass, keyed by module id.
A module absent from that file has passed nothing. Hand-editing it outside of the
documented emergency procedure is a process violation, and because the file is in
git, it is a visible one.

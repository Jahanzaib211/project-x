# 09 — Testing strategy

Each kind of test answers a question the others cannot. Adding more of one does
not compensate for the absence of another.

| Kind | Question | Gate |
|---|---|---|
| Unit | Does this piece do what its author claimed? | `G2` |
| Property | Does it hold for inputs nobody wrote down? | `G3` |
| Invariant | Are the financial laws still true? | `G4` |
| Contract | Do two sides still agree on the interface? | `G5` |
| Integration | Do the pieces work wired together, on real dependencies? | `G5` |
| Replay | Does history reproduce the present, exactly? | `G6` |
| Chaos | Do the laws survive the machine betraying us? | `G7` |
| Security | Can someone take what is not theirs? | `G8` |
| Performance | Is it fast enough, and did this change make it worse? | `G9` |

## Unit tests

Fast, isolated, deterministic. No sleeps, no clock reads, no network, no shared
state. Every branch of a state machine has a test. Every error path has a test —
error paths are where money goes missing, because they are where people stop
paying attention.

## Property tests

For anything with algebraic structure: money arithmetic, position accounting,
ledger posting, serialization.

```
∀ a, b : Money<C>          a + b == b + a
∀ a, b : Money<C>          (a + b) - b == a        under declared rounding
∀ fills : Fill[]           sum(qty) == position delta
∀ txn : Transaction        sum(debits) == sum(credits)
∀ e : Event                decode(encode(e)) == e   byte-identical
```

Shrinking is mandatory, failures are reproducible from a recorded seed, and
**every counterexample the generator finds is committed as a regression test**.
That is how a fuzzer's discovery becomes permanent knowledge rather than a fixed
ticket.

## Invariant tests

The financial laws, from [`registry/modules.yaml`](../registry/modules.yaml),
implemented in `tests/invariants/`.

Two things make these different from ordinary tests:

1. **They run against generated scenarios**, not fixed cases. Ten thousand random
   sequences of deposits, trades, price moves, partial closes and withdrawals — and
   the laws hold throughout every one.
2. **They are asserted continuously**, at every commit boundary, not at the end.
   A ledger that balances at the end had a window during which a reader saw
   impossible money.

The same assertions run as production monitors. See [11 — Observability](11-observability.md).

## Contract tests

One suite per interface, run identically against every implementation **and its
simulator**. The LP contract suite runs against LP-A, LP-B and the CI simulator,
and all three must pass the same tests.

This is what keeps vendor quirks in adapters instead of leaking into the core, and
it is what lets the whole system be developed against a simulated LP long before a
real LP contract exists.

## Integration tests

Real Postgres. Real bus. Real migrations, up and down. No mocks at the boundary
being tested — a mock proves your understanding of a dependency, not the
dependency.

## Replay tests

```
recorded event log ──▶ fold from genesis ──▶ state A
live system        ──────────────────────▶ state B
assert byte_identical(A, B)
```

Also asserted: replay across process restarts, replay across machines, and
`snapshot + tail == full replay` — because if a snapshot can diverge from a full
replay, the snapshot is a second, competing truth.

Replay failures are usually caused by one of five things, and they are worth
knowing by heart:

1. a clock read inside the determinism boundary
2. non-deterministic iteration order (hash map, set) reaching serialization
3. floating-point arithmetic
4. an unordered concurrent write
5. an external call whose result was not recorded on the event

## Chaos tests

Faults injected at randomized points:

| Fault | Asserts |
|---|---|
| `kill -9` mid-transaction | Ledger after recovery == ledger before crash |
| Database failover | No partial transaction survives |
| Network partition | No duplicate financial effect on reconnect |
| Latency injection | Timeouts fail closed, never open |
| Clock jump (forward and back) | Ordering unaffected; sequence still governs |
| Disk full | Fail closed; no silent truncation of the journal |
| Duplicate message delivery | Exactly-once effect holds |

After **every** fault: invariants hold, and replay equivalence holds. That second
clause is what makes chaos testing meaningful here rather than merely reassuring.

## Performance tests

Benchmarks on reference hardware against the module's recorded SLO, compared to
the last release baseline, with an allocation and memory budget and a sustained
soak.

**How SLOs are set:** benchmark on the target hardware, record the distribution,
set the objective from the measurement with headroom, and write it into the
module's registry entry. This repository contains no invented latency numbers,
because a guessed SLO produces false confidence and alerts that mean nothing.

## What we deliberately do not do

- **Chase a coverage percentage.** Coverage floors exist per module, but 100% line
  coverage of code that never asserts an invariant proves nothing about money.
- **Mock the database in integration tests.** See above.
- **Use production data in tests.** Ever, in any form.
- **Skip a test to unblock a release.** The emergency path narrows scope and adds
  humans; it does not remove proof. See
  [`runbooks/emergency-change.md`](runbooks/emergency-change.md).

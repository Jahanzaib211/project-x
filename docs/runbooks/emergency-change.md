# Runbook — Emergency change

## The principle

**The emergency path narrows scope and adds people. It never removes proof.**

There is no `--skip-gates` flag, and none will be added. `G0`, `G1`, `G2` and
`G4` cannot be waived on any module, for any reason, including this one. If a
change cannot pass the invariants, it is not a fix — it is an untested guess
about a system that is currently mishandling money.

## When this applies

- Funds can be moved without authorisation (S0)
- Client data is exposed, or authentication is bypassed (S1)
- An invariant is violated in production and the fix is understood
- A regulatory deadline that cannot be moved

Not: a feature is late. Not: a demo is tomorrow.

## What changes

| Normal | Emergency |
|---|---|
| Full gate suite | `G0`, `G1`, `G2`, `G4` **always**; slower gates scoped to the affected path |
| Staging soak | Shortened, never skipped |
| Canary | Shortened, never skipped |
| One approver (non-T0) | **Two** approvers, always, whatever the tier |
| Normal review | Incident commander plus financial-core owner |

Note the direction: the number of humans goes **up**, not down. Speed comes from
narrowing the change, never from lowering the bar.

## Procedure

1. **Declare the incident.** Name an incident commander. They are not the person
   writing the fix.
2. **Contain first.** Halt the affected path. A halted path loses revenue; an
   unhalted broken path loses money and trust. See
   [financial-discrepancy.md](financial-discrepancy.md).
3. **Write the smallest possible change.** One cause, one fix. No refactoring, no
   cleanup, no "while I'm here". Every extra line is unreviewed risk under time
   pressure.
4. **Run the non-waivable gates.** `make check && make test && make test-invariants`.
   If G4 fails, the fix is wrong. Stop.
5. **Two approvals**, one of which is a financial-core owner.
6. **Deploy through canary**, shortened but present. Watch the invariant monitors.
7. **Verify**: invariants clean, reconciliation clean, replay equivalence intact.

## Within 24 hours

- Full gate suite on the emergency digest. If a gate you skipped now fails, you
  have a second incident, and you find out on your terms rather than a client's.
- A regression test that reproduces the original failure.
- `CHANGELOG.md` entry marked as an emergency change, with the approvers named.
- A post-incident review that answers one question specifically: **which invariant
  would have caught this, and why did it not exist?** The output of that question
  is a new invariant, declared and implemented.

## What is never acceptable

- Editing `gates/status.yaml` by hand to mark a gate passed.
- Deleting or skipping a test to make the build green.
- Deploying a digest that has not passed `G0`, `G1`, `G2` and `G4`.
- `UPDATE`ing a journal entry or deleting an event to "clean up" the data.
- A single approver on a Tier 0 change.

Each of these turns a recoverable incident into an unreconstructable one.

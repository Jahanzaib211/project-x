# ADR-0006 — The financial core has no external dependencies

**Status:** Accepted

## Context

`crates/domain-kernel` defines what money *is* for this entire system. Every
balance, fee, P&L figure and ledger posting is built from it.

A dependency in that crate is code we did not write, cannot fully audit, and
cannot easily remove later, running inside the component that decides how much
money a client has. The supply chain is also permanent in a way the code is not:
removing a dependency after a hundred modules import its types is a project, not
a change.

## Decision

`domain-kernel`, `event-kernel` and `service-kit` have **zero external
dependencies**. What is normally imported is instead written and tested here:

- fixed-point decimal arithmetic and rounding policies
- the event envelope and canonical serialization
- the property-test harness — deterministic seeded generation with reproducible
  failures, about forty lines
- the HTTP surface for health, readiness and metrics

Services may take dependencies where the problem genuinely warrants them (a FIX
engine, a database driver). The rule applies to the crates that define financial
truth.

## Consequences

- **G2, G3 and G4 run offline in under a second.** No registry fetch, no
  lockfile resolution, no network flake. The financial laws can be checked on a
  laptop on a plane.
- Container builds for core services need no dependency resolution at all.
- The vulnerability surface of Tier 0 is the code in this repository.
- We maintain arithmetic that a library would have maintained. This is the real
  cost, and it is bounded: the code is small, it is exhaustively property-tested,
  and it does not change often — money has worked the same way for centuries.
- A property-testing framework would give better shrinking than the harness here.
  When that becomes the limiting factor, it can be added to the *test* crate,
  which is not the crate that defines money.

## Alternatives considered

**`rust_decimal` or `bigdecimal`.** Good libraries. Neither provides
currency-typed money, so the type-level guarantee had to be built regardless, and
adding them would have brought a supply chain for the part we would have written
anyway.

**`proptest` / `quickcheck`.** Better shrinking. Rejected for the core test path
in favour of a harness that is trivially auditable and has no version drift; the
door is open if shrinking becomes the bottleneck.

**A web framework for the services.** Justifiable once services do real work. At
Phase 0 the surface is four endpoints, and a framework in Tier 0 is a large,
permanent dependency for a small, temporary convenience.

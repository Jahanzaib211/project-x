# ADR-0003 — Money is fixed-point and currency-typed

**Status:** Accepted

## Context

IEEE-754 binary floating point cannot represent `0.1`. The error is tiny per
operation and unbounded in aggregate: across millions of trades, fees and swaps,
it becomes real money that reconciliation cannot explain and that nobody can
attribute.

Separately, adding US dollars to euros is always a bug, and it is a bug that
runtime currency checks catch only on the paths where someone remembered to write
the check.

## Decision

Money is an **exact integer count of minor units** with an explicit per-currency
scale, and the **currency is a type parameter**:

```rust
pub struct Money<C: Currency> { minor: i128, _currency: PhantomData<C> }
```

Consequences of that shape:

- `Money<Usd> + Money<Eur>` does not compile. There is a `compile_fail` doctest
  asserting it stays that way.
- All arithmetic is checked. Overflow is an error, never a wrap.
- Every operation that can lose precision **requires** a named rounding policy.
  There is no default, because "whatever rounding happened to occur" is not an
  auditable answer.
- Money crosses every boundary as an exact decimal string, never a JSON number.
- `split(n)` distributes the remainder so shares sum exactly to the original —
  the single most common way naive implementations lose money.

Enforced by: the type system; a banned-pattern lint at G1 that fails on `f32`/`f64`
in financial code; property tests at G3; INV-001 through INV-005 at G4.

## Consequences

- More verbose at call sites. Every rounding decision is visible, which is the
  intent.
- A currency the system does not know is a compile error rather than a runtime
  surprise — adding one is a deliberate act.
- `AnyMoney` exists for storage and wire boundaries where the type parameter
  cannot survive. Converting back is checked (INV-004).

## Alternatives considered

**A decimal library.** Would work, and most are good. Rejected here because the
crate that proves the money is correct should have the smallest possible supply
chain, and because currency tagging still had to be built on top. See ADR-0006.

**Floats with rounding at the boundary.** The error accumulates *before* the
boundary. This is the approach that produces unexplainable breaks.

**Integer cents without a currency type.** Solves precision, not the
cross-currency class of bug — which is the more expensive of the two.

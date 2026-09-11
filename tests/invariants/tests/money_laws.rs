//! G4 — invariants of `01-domain-kernel`.
//!
//! Each test names the invariant it proves. `scripts/check_invariant_coverage.py`
//! reads these tags and fails CI if a module declares a law that nothing here
//! executes.

// Test code performs ordinary arithmetic on ordinary integers — loop counters,
// case indices, expected values. The strict workspace lints exist to keep
// unchecked arithmetic out of PRODUCTION financial paths; applying them to the
// bodies of the tests that verify those paths adds noise, not safety.
#![allow(
    clippy::arithmetic_side_effects,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing
)]

use domain_kernel::{Money, MoneyError, Rounding, Usd};
use invariants::{for_all, Gen};

const CASES: u32 = 20_000;

/// INV-001 — Money arithmetic never uses IEEE-754 floating point.
///
/// Proven structurally rather than behaviourally: the crate has no float in its
/// public surface, and `scripts/banned_patterns.sh` fails the build on `f32`/`f64`
/// anywhere in financial code. This test pins the observable consequence — the
/// canonical float failure does not occur here.
#[test]
fn inv_001_no_floating_point_error_accumulates() {
    let tenth = Money::<Usd>::from_decimal_str("0.10").expect("valid literal");
    let mut total = Money::<Usd>::zero();
    for _ in 0..1_000_000 {
        total = total.add(tenth).expect("no overflow");
    }
    assert_eq!(total.to_decimal_string(), "100000.00");
}

/// INV-002 — `a + b == b + a`.
#[test]
fn inv_002_addition_is_commutative() {
    for_all("INV-002 commutativity", CASES, 0x1002, |g: &mut Gen| {
        let a = Money::<Usd>::from_minor(g.money_minor());
        let b = Money::<Usd>::from_minor(g.money_minor());
        match (a.add(b), b.add(a)) {
            (Ok(left), Ok(right)) if left == right => Ok(()),
            // Overflow must be symmetric too: if one direction overflows, so
            // must the other. An asymmetric failure would be a real bug.
            (Err(l), Err(r)) if l == r => Ok(()),
            (left, right) => Err(format!("a={a:?} b={b:?} a+b={left:?} b+a={right:?}")),
        }
    });
}

/// INV-003 — `(a + b) - b == a`, exactly, under the declared rounding policy.
#[test]
fn inv_003_addition_and_subtraction_are_inverse() {
    for_all("INV-003 inverse", CASES, 0x1003, |g: &mut Gen| {
        let a = Money::<Usd>::from_minor(g.money_minor());
        let b = Money::<Usd>::from_minor(g.money_minor());
        match a.add(b).and_then(|sum| sum.sub(b)) {
            Ok(back) if back == a => Ok(()),
            Ok(back) => Err(format!("a={a:?} b={b:?} round-tripped to {back:?}")),
            // Overflow is an acceptable outcome; a wrong answer is not.
            Err(MoneyError::Overflow) => Ok(()),
            Err(other) => Err(format!("unexpected error {other:?}")),
        }
    });
}

/// INV-002/003 — addition is associative where it does not overflow.
#[test]
fn inv_002_addition_is_associative() {
    for_all("INV-002 associativity", CASES, 0x1004, |g: &mut Gen| {
        let a = Money::<Usd>::from_minor(g.in_range(-1_000_000_000, 1_000_000_000));
        let b = Money::<Usd>::from_minor(g.in_range(-1_000_000_000, 1_000_000_000));
        let c = Money::<Usd>::from_minor(g.in_range(-1_000_000_000, 1_000_000_000));
        let left = a.add(b).and_then(|ab| ab.add(c));
        let right = b.add(c).and_then(|bc| a.add(bc));
        if left == right {
            Ok(())
        } else {
            Err(format!("(a+b)+c={left:?} but a+(b+c)={right:?}"))
        }
    });
}

/// INV-004 — money of different currencies cannot be added.
///
/// The real proof is the `compile_fail` doctest in `domain-kernel`: the code
/// does not compile. This test covers the runtime boundary, where currency
/// survives as data rather than as a type.
#[test]
fn inv_004_currency_mismatch_is_refused_at_the_boundary() {
    use domain_kernel::Eur;
    let euros = Money::<Eur>::from_minor(100).erase();
    assert_eq!(euros.typed::<Usd>(), Err(MoneyError::CurrencyMismatch));
    assert!(euros.typed::<Eur>().is_ok());
}

/// INV-005 — every rounding operation names its policy and its scale.
///
/// Where a value is not exactly representable, different policies must give
/// different answers. If they agreed everywhere, the policy argument would be
/// decoration rather than a decision.
#[test]
fn inv_005_rounding_policy_changes_the_result() {
    let amount = Money::<Usd>::from_decimal_str("1.00").expect("valid literal");
    let up = amount
        .mul_ratio(1, 3, Rounding::Ceil)
        .expect("representable");
    let down = amount
        .mul_ratio(1, 3, Rounding::Floor)
        .expect("representable");
    assert_ne!(up, down, "rounding policy must be observable");

    // And every policy must agree when the result IS exactly representable.
    let exact = Money::<Usd>::from_decimal_str("9.00").expect("valid literal");
    let results: Vec<_> = [
        Rounding::TowardZero,
        Rounding::Floor,
        Rounding::Ceil,
        Rounding::HalfUp,
        Rounding::HalfEven,
    ]
    .into_iter()
    .map(|policy| exact.mul_ratio(1, 3, policy).expect("representable"))
    .collect();
    assert!(
        results.windows(2).all(|w| w.first() == w.last()),
        "policies must agree on an exact result: {results:?}"
    );
}

/// INV-005 — a split conserves every minor unit.
///
/// The single most common way a naive implementation loses money: dividing a
/// balance N ways and discarding the remainder.
#[test]
fn inv_005_split_conserves_the_total_exactly() {
    for_all(
        "INV-005 split conservation",
        CASES,
        0x1005,
        |g: &mut Gen| {
            let total = Money::<Usd>::from_minor(g.in_range(-10_000_000, 10_000_000));
            let parts = g.small_count();
            let shares = total
                .split(parts)
                .map_err(|e| format!("split failed: {e:?}"))?;
            if shares.len() != parts as usize {
                return Err(format!("expected {parts} shares, got {}", shares.len()));
            }
            let mut sum = Money::<Usd>::zero();
            for share in &shares {
                sum = sum
                    .add(*share)
                    .map_err(|e| format!("sum overflow: {e:?}"))?;
            }
            if sum == total {
                Ok(())
            } else {
                Err(format!("{total:?} split {parts} ways summed to {sum:?}"))
            }
        },
    );
}

/// INV-001/005 — a decimal string round-trips exactly.
///
/// Money crosses every service and language boundary as this string. If the
/// round trip is lossy, every boundary in the system is lossy.
#[test]
fn inv_001_decimal_string_round_trip_is_exact() {
    for_all("INV-001 round trip", CASES, 0x1006, |g: &mut Gen| {
        let original = Money::<Usd>::from_minor(g.money_minor());
        let rendered = original.to_decimal_string();
        let parsed = Money::<Usd>::from_decimal_str(&rendered)
            .map_err(|e| format!("{rendered:?} failed to parse: {e:?}"))?;
        if parsed == original {
            Ok(())
        } else {
            Err(format!("{original:?} -> {rendered:?} -> {parsed:?}"))
        }
    });
}

/// INV-001 — arithmetic never wraps silently.
#[test]
fn inv_001_overflow_is_always_an_error_never_a_wrap() {
    for_all("INV-001 no silent wrap", CASES, 0x1007, |g: &mut Gen| {
        let a = Money::<Usd>::from_minor(g.money_minor());
        let b = Money::<Usd>::from_minor(g.money_minor());
        if let Ok(sum) = a.add(b) {
            // If it succeeded, the result must be arithmetically correct.
            let expected = a.minor().checked_add(b.minor());
            if expected != Some(sum.minor()) {
                return Err(format!("{a:?} + {b:?} = {sum:?}, expected {expected:?}"));
            }
        }
        Ok(())
    });
}

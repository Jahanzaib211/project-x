//! Rounding policies.
//!
//! **INV-005: every rounding operation names its policy and its scale.**
//!
//! There is no default. A caller that wants to round must say how, because
//! "whatever rounding the language happens to do" is how half a cent per trade
//! becomes a reconciliation break nobody can explain.

/// How to resolve a value that is not exactly representable at the target scale.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Rounding {
    /// Toward zero. Truncation. The remainder is discarded.
    TowardZero,
    /// Toward negative infinity.
    Floor,
    /// Toward positive infinity.
    Ceil,
    /// Nearest; ties away from zero. What most people mean by "round".
    HalfUp,
    /// Nearest; ties toward the even digit. Banker's rounding — the policy that
    /// does not accumulate a directional bias over many operations, which is why
    /// it is the right default for repeated financial arithmetic.
    HalfEven,
}

impl Rounding {
    /// Divide `numerator` by `denominator` under this policy.
    ///
    /// Returns `None` when `denominator` is zero, or when the result is not
    /// representable. It never panics and never silently truncates.
    #[must_use]
    pub fn divide(self, numerator: i128, denominator: i128) -> Option<i128> {
        if denominator == 0 {
            return None;
        }
        let quotient = numerator.checked_div(denominator)?;
        let remainder = numerator.checked_rem(denominator)?;
        if remainder == 0 {
            return Some(quotient);
        }

        // Sign of the exact quotient, needed because integer division in Rust
        // truncates toward zero.
        let negative = (numerator < 0) != (denominator < 0);

        let away_from_zero = || {
            if negative {
                quotient.checked_sub(1)
            } else {
                quotient.checked_add(1)
            }
        };

        match self {
            Rounding::TowardZero => Some(quotient),
            Rounding::Floor => {
                if negative {
                    away_from_zero()
                } else {
                    Some(quotient)
                }
            }
            Rounding::Ceil => {
                if negative {
                    Some(quotient)
                } else {
                    away_from_zero()
                }
            }
            Rounding::HalfUp | Rounding::HalfEven => {
                // Compare |remainder| * 2 against |denominator| without
                // overflowing and without touching floating point.
                let abs_rem = remainder.checked_abs()?;
                let abs_den = denominator.checked_abs()?;
                let doubled = abs_rem.checked_mul(2)?;

                match doubled.cmp(&abs_den) {
                    core::cmp::Ordering::Less => Some(quotient),
                    core::cmp::Ordering::Greater => away_from_zero(),
                    core::cmp::Ordering::Equal => match self {
                        Rounding::HalfUp => away_from_zero(),
                        // Ties to even: keep the quotient if it is already even.
                        _ => {
                            if quotient.checked_rem(2)? == 0 {
                                Some(quotient)
                            } else {
                                away_from_zero()
                            }
                        }
                    },
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Rounding::*;

    #[test]
    fn exact_division_never_rounds() {
        for policy in [TowardZero, Floor, Ceil, HalfUp, HalfEven] {
            assert_eq!(policy.divide(100, 4), Some(25), "{policy:?}");
            assert_eq!(policy.divide(-100, 4), Some(-25), "{policy:?}");
        }
    }

    #[test]
    fn half_up_goes_away_from_zero_on_a_tie() {
        assert_eq!(HalfUp.divide(5, 2), Some(3));
        assert_eq!(HalfUp.divide(-5, 2), Some(-3));
    }

    #[test]
    fn half_even_goes_to_the_even_neighbour_on_a_tie() {
        assert_eq!(HalfEven.divide(5, 2), Some(2)); // 2.5 -> 2
        assert_eq!(HalfEven.divide(7, 2), Some(4)); // 3.5 -> 4
        assert_eq!(HalfEven.divide(-5, 2), Some(-2));
        assert_eq!(HalfEven.divide(-7, 2), Some(-4));
    }

    #[test]
    fn floor_and_ceil_respect_sign() {
        assert_eq!(Floor.divide(7, 2), Some(3));
        assert_eq!(Floor.divide(-7, 2), Some(-4));
        assert_eq!(Ceil.divide(7, 2), Some(4));
        assert_eq!(Ceil.divide(-7, 2), Some(-3));
    }

    #[test]
    fn toward_zero_truncates_both_directions() {
        assert_eq!(TowardZero.divide(7, 2), Some(3));
        assert_eq!(TowardZero.divide(-7, 2), Some(-3));
    }

    #[test]
    fn division_by_zero_is_none_not_a_panic() {
        for policy in [TowardZero, Floor, Ceil, HalfUp, HalfEven] {
            assert_eq!(policy.divide(1, 0), None, "{policy:?}");
        }
    }

    /// Banker's rounding exists to avoid directional bias. Over many ties in
    /// both directions, HalfEven should not drift; HalfUp should.
    #[test]
    fn half_even_does_not_accumulate_bias() {
        let mut even_sum: i128 = 0;
        let mut up_sum: i128 = 0;
        let mut exact_doubled: i128 = 0;
        for k in 0..1000i128 {
            let numerator = 2 * k + 1; // always a .5 tie when divided by 2
            even_sum += HalfEven.divide(numerator, 2).unwrap_or(0);
            up_sum += HalfUp.divide(numerator, 2).unwrap_or(0);
            exact_doubled += numerator;
        }
        // The exact sum of all the halves, times two.
        let exact_sum_doubled = exact_doubled;
        assert_eq!(even_sum * 2, exact_sum_doubled, "half-even drifted");
        assert!(
            up_sum * 2 > exact_sum_doubled,
            "half-up should drift upward on positive ties"
        );
    }
}

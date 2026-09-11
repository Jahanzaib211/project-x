//! Quantity and Price, and the one operation that connects them to Money.

use core::fmt;
use core::marker::PhantomData;

use crate::money::{Money, MoneyError};
use crate::rounding::Rounding;
use crate::Currency;

/// Decimal places used for quantities and prices.
///
/// Eight places covers lot fractions and crypto-style precision without needing
/// a per-instrument scale in the type. Instruments coarser than this simply
/// never use the trailing digits.
pub const UNIT_SCALE: u32 = 8;
const UNIT_DIVISOR: i128 = 100_000_000; // 10^UNIT_SCALE

/// A traded quantity, in units scaled by [`UNIT_SCALE`].
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Quantity(i128);

impl Quantity {
    /// Construct from raw scaled units.
    #[must_use]
    pub const fn from_raw(raw: i128) -> Self {
        Self(raw)
    }

    /// Construct from whole units.
    ///
    /// # Errors
    /// [`MoneyError::Overflow`] if not representable.
    pub fn from_units(units: i128) -> Result<Self, MoneyError> {
        units
            .checked_mul(UNIT_DIVISOR)
            .map(Self)
            .ok_or(MoneyError::Overflow)
    }

    /// The raw scaled value.
    #[must_use]
    pub const fn raw(self) -> i128 {
        self.0
    }

    /// Zero.
    #[must_use]
    pub const fn zero() -> Self {
        Self(0)
    }

    /// Whether this quantity is zero.
    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    /// Add. Checked. Not `std::ops::Add`, for the reason given on
    /// [`crate::Money::add`].
    ///
    /// # Errors
    /// [`MoneyError::Overflow`] if not representable.
    #[allow(clippy::should_implement_trait)]
    pub fn add(self, other: Self) -> Result<Self, MoneyError> {
        self.0
            .checked_add(other.0)
            .map(Self)
            .ok_or(MoneyError::Overflow)
    }

    /// Subtract. Checked. Not `std::ops::Sub`.
    ///
    /// # Errors
    /// [`MoneyError::Overflow`] if not representable.
    #[allow(clippy::should_implement_trait)]
    pub fn sub(self, other: Self) -> Result<Self, MoneyError> {
        self.0
            .checked_sub(other.0)
            .map(Self)
            .ok_or(MoneyError::Overflow)
    }
}

impl fmt::Display for Quantity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let negative = self.0 < 0;
        let magnitude = self.0.unsigned_abs();
        let divisor = UNIT_DIVISOR.unsigned_abs();
        let whole = magnitude.checked_div(divisor).unwrap_or(0);
        let frac = magnitude.checked_rem(divisor).unwrap_or(0);
        let sign = if negative { "-" } else { "" };
        write!(f, "{sign}{whole}.{frac:08}")
    }
}

/// A price quoted in currency `C`, scaled by [`UNIT_SCALE`].
pub struct Price<C: Currency> {
    raw: i128,
    _currency: PhantomData<C>,
}

impl<C: Currency> Clone for Price<C> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<C: Currency> Copy for Price<C> {}
impl<C: Currency> PartialEq for Price<C> {
    fn eq(&self, other: &Self) -> bool {
        self.raw == other.raw
    }
}
impl<C: Currency> Eq for Price<C> {}
impl<C: Currency> PartialOrd for Price<C> {
    fn partial_cmp(&self, other: &Self) -> Option<core::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl<C: Currency> Ord for Price<C> {
    fn cmp(&self, other: &Self) -> core::cmp::Ordering {
        self.raw.cmp(&other.raw)
    }
}

impl<C: Currency> Price<C> {
    /// Construct from a raw scaled value.
    #[must_use]
    pub const fn from_raw(raw: i128) -> Self {
        Self {
            raw,
            _currency: PhantomData,
        }
    }

    /// The raw scaled value.
    #[must_use]
    pub const fn raw(self) -> i128 {
        self.raw
    }

    /// Notional value of `quantity` at this price.
    ///
    /// `price × quantity` carries `2 × UNIT_SCALE` decimal places, and the
    /// currency holds `C::SCALE`. The excess must be resolved, so the caller
    /// names the policy (INV-005) — there is no implicit truncation.
    ///
    /// # Errors
    /// [`MoneyError::Overflow`] if the intermediate product is not representable.
    pub fn notional(self, quantity: Quantity, rounding: Rounding) -> Result<Money<C>, MoneyError> {
        let product = self
            .raw
            .checked_mul(quantity.raw())
            .ok_or(MoneyError::Overflow)?;
        // Excess decimal places to remove: 2*UNIT_SCALE - C::SCALE.
        let excess = UNIT_SCALE
            .checked_mul(2)
            .and_then(|v| v.checked_sub(C::SCALE))
            .ok_or(MoneyError::Overflow)?;
        let divisor = 10i128.checked_pow(excess).ok_or(MoneyError::Overflow)?;
        rounding
            .divide(product, divisor)
            .map(Money::from_minor)
            .ok_or(MoneyError::Overflow)
    }
}

impl<C: Currency> fmt::Debug for Price<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Price<{}>({})", C::CODE, Quantity::from_raw(self.raw))
    }
}

/// Which side of the market an order or position is on.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Side {
    /// Buy / long.
    Buy,
    /// Sell / short.
    Sell,
}

impl Side {
    /// The opposite side.
    #[must_use]
    pub const fn opposite(self) -> Self {
        match self {
            Self::Buy => Self::Sell,
            Self::Sell => Self::Buy,
        }
    }

    /// `+1` for a buy, `-1` for a sell. Used to give a quantity a direction.
    #[must_use]
    pub const fn signum(self) -> i128 {
        match self {
            Self::Buy => 1,
            Self::Sell => -1,
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::arithmetic_side_effects, clippy::unwrap_used)]

    use super::*;
    use crate::{Jpy, Usd};

    #[test]
    fn notional_of_a_whole_lot_is_exact() {
        // 1.5 units at 100.25 USD = 150.375 -> not representable in cents.
        let price = Price::<Usd>::from_raw(10_025_000_000);
        let qty = Quantity::from_raw(150_000_000);
        let half_even = price.notional(qty, Rounding::HalfEven).unwrap();
        let floor = price.notional(qty, Rounding::Floor).unwrap();
        let ceil = price.notional(qty, Rounding::Ceil).unwrap();
        assert_eq!(floor.to_decimal_string(), "150.37");
        assert_eq!(ceil.to_decimal_string(), "150.38");
        // 150.375 is a tie; half-even goes to the even cent, 150.38 (38 is even).
        assert_eq!(half_even.to_decimal_string(), "150.38");
    }

    #[test]
    fn notional_respects_a_zero_scale_currency() {
        // 3 units at 155 JPY = 465 yen, no minor unit at all.
        let price = Price::<Jpy>::from_raw(15_500_000_000);
        let qty = Quantity::from_units(3).unwrap();
        let value = price.notional(qty, Rounding::HalfEven).unwrap();
        assert_eq!(value.to_decimal_string(), "465");
    }

    #[test]
    fn a_sell_is_the_opposite_of_a_buy() {
        assert_eq!(Side::Buy.opposite(), Side::Sell);
        assert_eq!(Side::Buy.signum() + Side::Sell.signum(), 0);
    }

    #[test]
    fn quantities_add_and_subtract_exactly() {
        let a = Quantity::from_raw(100_000_000);
        let b = Quantity::from_raw(33_333_333);
        let sum = a.add(b).unwrap();
        assert_eq!(sum.sub(b).unwrap(), a);
        assert_eq!(sum.to_string(), "1.33333333");
    }
}

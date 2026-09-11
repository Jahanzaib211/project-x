//! Money: exact, currency-tagged, fixed-point.
//!
//! A `Money<Usd>` is an integer count of cents. Not a decimal approximation of
//! dollars — an exact count. All arithmetic is checked, and every operation that
//! can lose precision requires the caller to name a rounding policy.

use core::fmt;
use core::marker::PhantomData;

use crate::rounding::Rounding;
use crate::Currency;

/// Something went wrong in an arithmetic operation. Nothing here is a panic:
/// on a money path, an error you can handle beats a process that dies holding
/// a half-applied transaction.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum MoneyError {
    /// The result is not representable. Money never wraps around.
    Overflow,
    /// Division by zero.
    DivideByZero,
    /// A parsed string was not a valid exact decimal.
    Malformed,
    /// A parsed value carried more decimal places than the currency has.
    /// Refused rather than rounded — silently dropping a caller's precision is
    /// how you lose a fraction of every trade.
    PrecisionLoss,
    /// A runtime-tagged value did not carry the currency the caller expected.
    CurrencyMismatch,
}

impl fmt::Display for MoneyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            Self::Overflow => "arithmetic overflow",
            Self::DivideByZero => "division by zero",
            Self::Malformed => "malformed decimal",
            Self::PrecisionLoss => "value has more precision than the currency allows",
            Self::CurrencyMismatch => "currency mismatch",
        };
        f.write_str(msg)
    }
}

/// An exact monetary amount in currency `C`.
///
/// The currency is a type parameter, so `Money<Usd> + Money<Eur>` fails to
/// compile (INV-004). Positive is a debit in ledger terms; negative is a credit.
pub struct Money<C: Currency> {
    minor: i128,
    _currency: PhantomData<C>,
}

// Derived impls would demand `C: Trait`, which is not what we want — the
// currency is a marker, not data. Hand-written impls keep `Money<C>` usable
// regardless of what `C` implements.
impl<C: Currency> Clone for Money<C> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<C: Currency> Copy for Money<C> {}
impl<C: Currency> PartialEq for Money<C> {
    fn eq(&self, other: &Self) -> bool {
        self.minor == other.minor
    }
}
impl<C: Currency> Eq for Money<C> {}
impl<C: Currency> PartialOrd for Money<C> {
    fn partial_cmp(&self, other: &Self) -> Option<core::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl<C: Currency> Ord for Money<C> {
    fn cmp(&self, other: &Self) -> core::cmp::Ordering {
        self.minor.cmp(&other.minor)
    }
}
impl<C: Currency> Default for Money<C> {
    fn default() -> Self {
        Self::zero()
    }
}

impl<C: Currency> Money<C> {
    /// Construct from a count of minor units (cents, satoshi, yen).
    #[must_use]
    pub const fn from_minor(minor: i128) -> Self {
        Self {
            minor,
            _currency: PhantomData,
        }
    }

    /// The count of minor units. This is the only representation; there is no
    /// lossy "as float" accessor, deliberately.
    #[must_use]
    pub const fn minor(self) -> i128 {
        self.minor
    }

    /// Zero, in this currency.
    #[must_use]
    pub const fn zero() -> Self {
        Self::from_minor(0)
    }

    /// Whether this amount is zero.
    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.minor == 0
    }

    /// Whether this amount is negative.
    #[must_use]
    pub const fn is_negative(self) -> bool {
        self.minor < 0
    }

    /// The ISO code of this currency.
    #[must_use]
    pub const fn code() -> &'static str {
        C::CODE
    }

    /// The number of decimal places in this currency's minor unit.
    #[must_use]
    pub const fn scale() -> u32 {
        C::SCALE
    }

    /// Add. Checked: overflow is an error, never a wrap.
    ///
    /// Deliberately not `std::ops::Add`. An operator cannot return a `Result`,
    /// so implementing `+` would mean panicking or wrapping on overflow — and
    /// an operator that can silently do either is one people use without
    /// checking. Naming it `add` forces the call site to handle failure.
    ///
    /// # Errors
    /// [`MoneyError::Overflow`] if the result is not representable.
    #[allow(clippy::should_implement_trait)]
    pub fn add(self, other: Self) -> Result<Self, MoneyError> {
        self.minor
            .checked_add(other.minor)
            .map(Self::from_minor)
            .ok_or(MoneyError::Overflow)
    }

    /// Subtract. Checked. Not `std::ops::Sub`, for the reason given on
    /// [`Money::add`].
    ///
    /// # Errors
    /// [`MoneyError::Overflow`] if the result is not representable.
    #[allow(clippy::should_implement_trait)]
    pub fn sub(self, other: Self) -> Result<Self, MoneyError> {
        self.minor
            .checked_sub(other.minor)
            .map(Self::from_minor)
            .ok_or(MoneyError::Overflow)
    }

    /// Negate. Checked.
    ///
    /// # Errors
    /// [`MoneyError::Overflow`] at the representable minimum.
    pub fn negate(self) -> Result<Self, MoneyError> {
        self.minor
            .checked_neg()
            .map(Self::from_minor)
            .ok_or(MoneyError::Overflow)
    }

    /// Absolute value. Checked.
    ///
    /// # Errors
    /// [`MoneyError::Overflow`] at the representable minimum.
    pub fn abs(self) -> Result<Self, MoneyError> {
        self.minor
            .checked_abs()
            .map(Self::from_minor)
            .ok_or(MoneyError::Overflow)
    }

    /// Multiply by a whole number — a quantity of identical charges, for example.
    /// Exact: no rounding is possible, so none is requested.
    ///
    /// # Errors
    /// [`MoneyError::Overflow`] if the result is not representable.
    pub fn mul_int(self, factor: i128) -> Result<Self, MoneyError> {
        self.minor
            .checked_mul(factor)
            .map(Self::from_minor)
            .ok_or(MoneyError::Overflow)
    }

    /// Apply a rational factor `numerator / denominator` — a commission rate, a
    /// haircut, an FX rate expressed exactly.
    ///
    /// The rounding policy is a required argument (INV-005). There is no default,
    /// because "whatever rounding happened to occur" is not an auditable answer.
    ///
    /// # Errors
    /// [`MoneyError::DivideByZero`] or [`MoneyError::Overflow`].
    pub fn mul_ratio(
        self,
        numerator: i128,
        denominator: i128,
        rounding: Rounding,
    ) -> Result<Self, MoneyError> {
        if denominator == 0 {
            return Err(MoneyError::DivideByZero);
        }
        let scaled = self
            .minor
            .checked_mul(numerator)
            .ok_or(MoneyError::Overflow)?;
        rounding
            .divide(scaled, denominator)
            .map(Self::from_minor)
            .ok_or(MoneyError::Overflow)
    }

    /// Split into `parts` shares that sum **exactly** back to the original.
    ///
    /// The remainder is distributed one minor unit at a time across the leading
    /// shares, so nothing is created and nothing is lost. Splitting 100 cents
    /// three ways gives `[34, 33, 33]`, not `[33, 33, 33]` and a missing cent.
    ///
    /// This is the operation that most often loses money in naive
    /// implementations, which is why it is provided here rather than left to
    /// each caller.
    ///
    /// # Errors
    /// [`MoneyError::DivideByZero`] if `parts` is zero, [`MoneyError::Overflow`]
    /// otherwise.
    pub fn split(self, parts: u32) -> Result<Vec<Self>, MoneyError> {
        if parts == 0 {
            return Err(MoneyError::DivideByZero);
        }
        let n = i128::from(parts);
        let base = Rounding::TowardZero
            .divide(self.minor, n)
            .ok_or(MoneyError::Overflow)?;
        let mut remainder = self
            .minor
            .checked_sub(base.checked_mul(n).ok_or(MoneyError::Overflow)?)
            .ok_or(MoneyError::Overflow)?;

        let step: i128 = if remainder < 0 { -1 } else { 1 };
        let mut out = Vec::with_capacity(parts as usize);
        for _ in 0..parts {
            let mut share = base;
            if remainder != 0 {
                share = share.checked_add(step).ok_or(MoneyError::Overflow)?;
                remainder = remainder.checked_sub(step).ok_or(MoneyError::Overflow)?;
            }
            out.push(Self::from_minor(share));
        }
        Ok(out)
    }

    /// Parse an exact decimal string, for example `"1234.56"`.
    ///
    /// Refuses input carrying more decimal places than the currency has, rather
    /// than silently rounding it. A caller who wants rounding must ask for it.
    ///
    /// # Errors
    /// [`MoneyError::Malformed`], [`MoneyError::PrecisionLoss`] or
    /// [`MoneyError::Overflow`].
    pub fn from_decimal_str(input: &str) -> Result<Self, MoneyError> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(MoneyError::Malformed);
        }
        let (negative, digits) = match trimmed.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
        };
        if digits.is_empty() {
            return Err(MoneyError::Malformed);
        }

        let mut parts = digits.splitn(2, '.');
        let whole = parts.next().unwrap_or("");
        let frac = parts.next().unwrap_or("");
        if whole.is_empty() && frac.is_empty() {
            return Err(MoneyError::Malformed);
        }
        if !whole.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return Err(MoneyError::Malformed);
        }
        let scale = C::SCALE as usize;
        if frac.len() > scale {
            // Trailing zeros beyond the scale are harmless; real digits are not.
            if frac.bytes().skip(scale).any(|b| b != b'0') {
                return Err(MoneyError::PrecisionLoss);
            }
        }

        // Every step is checked. The digits were validated as ASCII above, but
        // the arithmetic does not rely on that having happened.
        let digit_value =
            |byte: u8| -> Option<i128> { char::from(byte).to_digit(10).map(i128::from) };

        let mut minor: i128 = 0;
        for byte in whole.bytes() {
            let digit = digit_value(byte).ok_or(MoneyError::Malformed)?;
            minor = minor
                .checked_mul(10)
                .and_then(|v| v.checked_add(digit))
                .ok_or(MoneyError::Overflow)?;
        }
        for i in 0..scale {
            // Fewer fractional digits than the scale means trailing zeros.
            let digit = match frac.as_bytes().get(i) {
                Some(byte) => digit_value(*byte).ok_or(MoneyError::Malformed)?,
                None => 0,
            };
            minor = minor
                .checked_mul(10)
                .and_then(|v| v.checked_add(digit))
                .ok_or(MoneyError::Overflow)?;
        }
        if negative {
            minor = minor.checked_neg().ok_or(MoneyError::Overflow)?;
        }
        Ok(Self::from_minor(minor))
    }

    /// Render as an exact decimal string, always with the currency's full scale.
    ///
    /// This is the canonical wire representation. Money crosses a service or
    /// language boundary as this string — never as a JSON number, because a JSON
    /// number is a float on the other side.
    #[must_use]
    pub fn to_decimal_string(self) -> String {
        let scale = C::SCALE as usize;
        let negative = self.minor < 0;
        // i128::MIN has no positive counterpart; go through u128.
        let magnitude: u128 = self.minor.unsigned_abs();
        if scale == 0 {
            return if negative {
                format!("-{magnitude}")
            } else {
                format!("{magnitude}")
            };
        }
        // `checked_pow` and `checked_div` rather than the bare operators: this
        // crate does not perform unchecked arithmetic, even where the operands
        // are provably safe. The discipline is the point.
        let divisor = 10u128.checked_pow(C::SCALE).unwrap_or(1);
        let whole = magnitude.checked_div(divisor).unwrap_or(0);
        let frac = magnitude.checked_rem(divisor).unwrap_or(0);
        let sign = if negative { "-" } else { "" };
        format!("{sign}{whole}.{frac:0width$}", width = scale)
    }

    /// Erase the type parameter for a boundary that must carry the currency as
    /// data — a database column, a wire payload.
    #[must_use]
    pub fn erase(self) -> AnyMoney {
        AnyMoney {
            minor: self.minor,
            currency: C::CODE,
            scale: C::SCALE,
        }
    }
}

impl<C: Currency> fmt::Display for Money<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.to_decimal_string(), C::CODE)
    }
}

impl<C: Currency> fmt::Debug for Money<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Money<{}>({})", C::CODE, self.to_decimal_string())
    }
}

/// Money whose currency is carried as data rather than as a type.
///
/// Used only at boundaries — storage, the wire — where the type parameter cannot
/// survive. Convert back to `Money<C>` with [`AnyMoney::typed`] as early as
/// possible, so that the compile-time guarantee applies to as much of the code
/// as it can.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct AnyMoney {
    /// Count of minor units.
    pub minor: i128,
    /// Currency code.
    pub currency: &'static str,
    /// Decimal places in the minor unit.
    pub scale: u32,
}

impl AnyMoney {
    /// Recover the statically-typed form.
    ///
    /// # Errors
    /// [`MoneyError::CurrencyMismatch`] if the tag does not match `C`.
    pub fn typed<C: Currency>(self) -> Result<Money<C>, MoneyError> {
        if self.currency == C::CODE && self.scale == C::SCALE {
            Ok(Money::from_minor(self.minor))
        } else {
            Err(MoneyError::CurrencyMismatch)
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::arithmetic_side_effects, clippy::unwrap_used)]

    use super::*;
    use crate::{Btc, Eur, Jpy, Usd};

    #[test]
    fn addition_is_exact() {
        let a = Money::<Usd>::from_decimal_str("0.10").unwrap();
        let b = Money::<Usd>::from_decimal_str("0.20").unwrap();
        // The canonical float failure: 0.1 + 0.2 != 0.3. Here it is exact.
        assert_eq!(a.add(b).unwrap().to_decimal_string(), "0.30");
    }

    #[test]
    fn a_tenth_added_ten_million_times_is_exact() {
        let tenth = Money::<Usd>::from_decimal_str("0.10").unwrap();
        let mut total = Money::<Usd>::zero();
        for _ in 0..10_000_000 {
            total = total.add(tenth).unwrap();
        }
        assert_eq!(total.to_decimal_string(), "1000000.00");
    }

    #[test]
    fn scale_is_a_property_of_the_currency() {
        assert_eq!(Money::<Usd>::scale(), 2);
        assert_eq!(Money::<Jpy>::scale(), 0);
        assert_eq!(Money::<Btc>::scale(), 8);
        assert_eq!(Money::<Jpy>::from_minor(1500).to_decimal_string(), "1500");
        assert_eq!(
            Money::<Btc>::from_minor(1).to_decimal_string(),
            "0.00000001"
        );
    }

    #[test]
    fn parsing_refuses_precision_it_cannot_keep() {
        assert_eq!(
            Money::<Usd>::from_decimal_str("1.005"),
            Err(MoneyError::PrecisionLoss)
        );
        // Trailing zeros beyond scale carry no information, so they are fine.
        assert_eq!(
            Money::<Usd>::from_decimal_str("1.0000").unwrap().minor(),
            100
        );
    }

    #[test]
    fn parsing_rejects_junk() {
        for bad in ["", "  ", "abc", "1.2.3", "1,50", "-", "1e5", "0x10"] {
            assert!(
                Money::<Usd>::from_decimal_str(bad).is_err(),
                "accepted {bad:?}"
            );
        }
    }

    #[test]
    fn round_trip_through_string_is_exact() {
        for raw in [0i128, 1, -1, 99, 100, -12345, i64::MAX as i128] {
            let m = Money::<Usd>::from_minor(raw);
            let parsed = Money::<Usd>::from_decimal_str(&m.to_decimal_string()).unwrap();
            assert_eq!(m, parsed, "round trip failed for {raw}");
        }
    }

    #[test]
    fn negative_amounts_render_and_parse() {
        let m = Money::<Usd>::from_decimal_str("-0.05").unwrap();
        assert_eq!(m.minor(), -5);
        assert_eq!(m.to_decimal_string(), "-0.05");
    }

    #[test]
    fn overflow_is_an_error_not_a_wrap() {
        let big = Money::<Usd>::from_minor(i128::MAX);
        assert_eq!(big.add(Money::from_minor(1)), Err(MoneyError::Overflow));
        assert_eq!(big.mul_int(2), Err(MoneyError::Overflow));
    }

    #[test]
    fn split_conserves_every_minor_unit() {
        // The classic: one dollar, three ways.
        let dollar = Money::<Usd>::from_minor(100);
        let shares = dollar.split(3).unwrap();
        assert_eq!(
            shares.iter().map(|m| m.minor()).collect::<Vec<_>>(),
            vec![34, 33, 33]
        );
        let total = shares
            .iter()
            .try_fold(Money::<Usd>::zero(), |acc, m| acc.add(*m))
            .unwrap();
        assert_eq!(total, dollar);
    }

    #[test]
    fn split_conserves_for_negative_amounts_too() {
        let owed = Money::<Usd>::from_minor(-100);
        let shares = owed.split(3).unwrap();
        let total = shares
            .iter()
            .try_fold(Money::<Usd>::zero(), |acc, m| acc.add(*m))
            .unwrap();
        assert_eq!(total, owed);
    }

    #[test]
    fn commission_uses_a_named_rounding_policy() {
        // 0.35% of 1,000.00 USD = 3.50 exactly.
        let notional = Money::<Usd>::from_decimal_str("1000.00").unwrap();
        let fee = notional.mul_ratio(35, 10_000, Rounding::HalfEven).unwrap();
        assert_eq!(fee.to_decimal_string(), "3.50");

        // 0.35% of 1.00 USD = 0.0035 -> not representable in cents.
        let small = Money::<Usd>::from_decimal_str("1.00").unwrap();
        let up = small.mul_ratio(35, 10_000, Rounding::Ceil).unwrap();
        let down = small.mul_ratio(35, 10_000, Rounding::Floor).unwrap();
        assert_eq!(up.minor(), 1);
        assert_eq!(down.minor(), 0);
        // The policy is what makes the difference visible and auditable.
        assert_ne!(up, down);
    }

    #[test]
    fn erasing_and_recovering_the_currency_tag() {
        let m = Money::<Eur>::from_minor(12_345);
        let erased = m.erase();
        assert_eq!(erased.currency, "EUR");
        assert_eq!(erased.typed::<Eur>().unwrap(), m);
        assert_eq!(
            erased.typed::<Usd>().unwrap_err(),
            MoneyError::CurrencyMismatch
        );
    }
}

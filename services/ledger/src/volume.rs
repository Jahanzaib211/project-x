//! Volume, parsed the way money is parsed: exactly, or not at all.
//!
//! A client sends a volume as `"0.10"` — a decimal string, never a JSON number,
//! for the same reason amounts are strings (P1). Lots convert to base units by
//! an exact integer path: text -> thousandths of a lot -> scaled units. There is
//! no division by a float and no `parse::<f64>()` anywhere on it.

use domain_kernel::Quantity;
use market_core::Instrument;

/// Why a volume was refused.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum VolumeError {
    /// The text was not a decimal number.
    Malformed,
    /// More than three decimal places. A venue that quotes to 0.001 lots cannot
    /// fill 0.0001, and silently truncating would fill a different order from
    /// the one that was sent.
    TooPrecise,
    /// Zero or negative.
    NonPositive,
    /// So large the conversion cannot be represented.
    Overflow,
}

impl core::fmt::Display for VolumeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Malformed => f.write_str("volume must be a decimal string such as \"0.10\""),
            Self::TooPrecise => f.write_str("volume may carry at most three decimal places"),
            Self::NonPositive => f.write_str("volume must be greater than zero"),
            Self::Overflow => f.write_str("volume is too large"),
        }
    }
}

/// Decimal places a volume may carry: thousandths of a lot.
const VOLUME_PLACES: usize = 3;

/// Parse a lot volume into thousandths of a lot.
///
/// # Errors
/// [`VolumeError`] if the text is not an exact, positive decimal with at most
/// three places.
pub fn milli_lots(text: &str) -> Result<i128, VolumeError> {
    if text.is_empty() || text.len() > 24 {
        return Err(VolumeError::Malformed);
    }
    let (whole_text, frac_text) = match text.split_once('.') {
        Some((whole, frac)) => (whole, frac),
        None => (text, ""),
    };
    if whole_text.is_empty() && frac_text.is_empty() {
        return Err(VolumeError::Malformed);
    }
    if !whole_text.bytes().all(|b| b.is_ascii_digit())
        || !frac_text.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(VolumeError::Malformed);
    }
    if frac_text.len() > VOLUME_PLACES {
        return Err(VolumeError::TooPrecise);
    }

    let whole: i128 = if whole_text.is_empty() {
        0
    } else {
        whole_text.parse().map_err(|_| VolumeError::Overflow)?
    };
    // Pad the fraction out to exactly three places, so "0.1" and "0.100" are
    // the same order rather than differing by a factor of a hundred.
    let mut fraction: i128 = 0;
    for index in 0..VOLUME_PLACES {
        let digit = frac_text
            .as_bytes()
            .get(index)
            .map_or(0, |byte| i128::from(byte.saturating_sub(b'0')));
        fraction = fraction
            .checked_mul(10)
            .and_then(|value| value.checked_add(digit))
            .ok_or(VolumeError::Overflow)?;
    }

    let total = whole
        .checked_mul(1_000)
        .and_then(|value| value.checked_add(fraction))
        .ok_or(VolumeError::Overflow)?;
    if total <= 0 {
        return Err(VolumeError::NonPositive);
    }
    Ok(total)
}

/// Convert thousandths of a lot into the instrument's scaled base units.
///
/// # Errors
/// [`VolumeError::Overflow`] if the product is not representable.
pub fn to_quantity(milli_lots: i128, instrument: &Instrument) -> Result<Quantity, VolumeError> {
    let units_per_lot = instrument
        .contract_size
        .checked_mul(100_000_000)
        .ok_or(VolumeError::Overflow)?;
    let raw = units_per_lot
        .checked_mul(milli_lots)
        .and_then(|value| value.checked_div(1_000))
        .ok_or(VolumeError::Overflow)?;
    Ok(Quantity::from_raw(raw))
}

/// Render scaled base units back as a lot volume, for display.
#[must_use]
pub fn to_lots_text(quantity: Quantity, instrument: &Instrument) -> String {
    let units_per_lot = instrument.contract_size.saturating_mul(100_000_000);
    if units_per_lot <= 0 {
        return "0.000".to_owned();
    }
    let milli = quantity
        .raw()
        .saturating_mul(1_000)
        .checked_div(units_per_lot)
        .unwrap_or(0);
    let whole = milli.checked_div(1_000).unwrap_or(0);
    let frac = milli.checked_rem(1_000).unwrap_or(0).abs();
    format!("{whole}.{frac:03}")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use market_core::instrument::find;

    #[test]
    fn common_volumes_parse_exactly() {
        assert_eq!(milli_lots("1").unwrap(), 1_000);
        assert_eq!(milli_lots("1.0").unwrap(), 1_000);
        assert_eq!(milli_lots("1.000").unwrap(), 1_000);
        assert_eq!(milli_lots("0.10").unwrap(), 100);
        assert_eq!(
            milli_lots("0.1").unwrap(),
            100,
            "0.1 is a tenth, not a thousandth"
        );
        assert_eq!(milli_lots("0.01").unwrap(), 10);
        assert_eq!(milli_lots("12.345").unwrap(), 12_345);
    }

    #[test]
    fn malformed_volumes_are_refused_rather_than_coerced() {
        for bad in ["", "abc", "-1", "1.2.3", "1,5", " 1", "1 ", "+1", "1e3"] {
            assert_eq!(milli_lots(bad), Err(VolumeError::Malformed), "{bad}");
        }
        assert_eq!(milli_lots("0.1234"), Err(VolumeError::TooPrecise));
        assert_eq!(milli_lots("0"), Err(VolumeError::NonPositive));
        assert_eq!(milli_lots("0.000"), Err(VolumeError::NonPositive));
    }

    #[test]
    fn lots_convert_to_the_instruments_base_units() {
        let eurusd = find("EURUSD").unwrap();
        // One lot of a major pair is 100 000 units.
        assert_eq!(
            to_quantity(1_000, eurusd).unwrap(),
            Quantity::from_units(100_000).unwrap()
        );
        assert_eq!(
            to_quantity(100, eurusd).unwrap(),
            Quantity::from_units(10_000).unwrap()
        );

        let gold = find("XAUUSD").unwrap();
        assert_eq!(
            to_quantity(1_000, gold).unwrap(),
            Quantity::from_units(100).unwrap()
        );

        let btc = find("BTCUSD").unwrap();
        assert_eq!(
            to_quantity(1_000, btc).unwrap(),
            Quantity::from_units(1).unwrap()
        );
    }

    #[test]
    fn a_volume_survives_the_round_trip_it_is_displayed_through() {
        let eurusd = find("EURUSD").unwrap();
        for text in ["0.010", "0.100", "1.000", "12.345", "50.000"] {
            let milli = milli_lots(text).unwrap();
            let quantity = to_quantity(milli, eurusd).unwrap();
            assert_eq!(to_lots_text(quantity, eurusd), text);
        }
    }
}

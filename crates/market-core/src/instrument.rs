//! The tradable instrument set.
//!
//! A static table rather than a database read, because every consumer of it
//! must agree exactly and at all times: the margin an order reserves and the
//! notional it settles for are both derived from these numbers, and a service
//! that disagreed about a contract size would compute a different position for
//! the same fill.
//!
//! Every instrument here is **quoted in USD**. That is a deliberate limit of
//! this build, not an oversight: a non-USD quote currency requires a
//! conversion rate at fill time, and a conversion rate is a second market
//! state with its own staleness rules. Adding one is a change to
//! `08-pnl-margin`, and it does not get made implicitly by adding a row here.

use domain_kernel::quantity::UNIT_SCALE;

use crate::session::SessionKind;

/// One tradable instrument.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Instrument {
    /// Canonical symbol, e.g. `EURUSD`.
    pub symbol: &'static str,
    /// Display name.
    pub name: &'static str,
    /// What kind of thing it is, for grouping in the interface.
    pub class: &'static str,
    /// The calendar it trades on (INV-053).
    pub session: SessionKind,
    /// Decimal places the instrument is quoted to, e.g. 5 for `EURUSD`.
    ///
    /// This is the price grid. A price that is not a whole multiple of
    /// [`Instrument::point`] is not a price this instrument can trade at.
    pub digits: u32,
    /// The reference price, in raw units of [`UNIT_SCALE`], that the series
    /// oscillates around.
    pub reference_raw: i128,
    /// Units of the base asset in one lot: 100 000 for a major FX pair, 100
    /// troy ounces for gold, 1 coin for BTC.
    pub contract_size: i128,
    /// The half-spread the venue quotes, in whole price points.
    pub spread_points: i128,
    /// Maximum leverage. Margin is notional divided by this.
    pub max_leverage: i128,
    /// The smallest order the venue accepts, in thousandths of a lot.
    pub min_volume_milli_lots: i128,
    /// The largest single order the venue accepts, in thousandths of a lot.
    pub max_volume_milli_lots: i128,
    /// How far the series moves, as a fraction of the reference price in basis
    /// points, at its widest.
    pub volatility_bps: i128,
    /// Commission charged per lot, per side, in USD cents.
    ///
    /// Non-zero on every instrument on purpose: it is what makes every deal
    /// produce a ledger posting, which is what INV-101 requires. A venue that
    /// charged nothing on an opening trade would have deals with no financial
    /// effect, and "exactly one balanced set of postings" would have to become
    /// "at most one" — a weaker rule, adopted to fit an implementation detail.
    pub commission_per_lot_minor: i128,
}

impl Instrument {
    /// The value of one price increment, in raw [`UNIT_SCALE`] units.
    ///
    /// `digits` is bounded by the table below, so the exponent cannot underflow.
    #[must_use]
    pub fn point(&self) -> i128 {
        let places = UNIT_SCALE.saturating_sub(self.digits);
        (0..places).fold(1i128, |acc, _| acc.saturating_mul(10))
    }

    /// Commission for `quantity`, in USD minor units, rounded up.
    ///
    /// Rounded up for the same reason margin is: a charge rounded down is a
    /// discount nobody approved.
    #[must_use]
    pub fn commission_minor(&self, quantity_raw: i128) -> i128 {
        let units_per_lot = self.contract_size.saturating_mul(100_000_000);
        if units_per_lot <= 0 {
            return 0;
        }
        let numerator = quantity_raw
            .saturating_mul(self.commission_per_lot_minor)
            .saturating_add(units_per_lot.saturating_sub(1));
        numerator.checked_div(units_per_lot).unwrap_or(0)
    }

    /// Render a raw price as the decimal string this instrument quotes.
    ///
    /// Integer arithmetic only: the raw value is split into whole and
    /// fractional parts and the fraction is padded to `digits`. Formatting a
    /// price by dividing into a float would undo, at the last possible moment,
    /// the exactness the rest of the system maintains (INV-001).
    #[must_use]
    pub fn format_price(&self, raw: i128) -> String {
        let point = self.point();
        let ticks = raw.checked_div(point).unwrap_or(0);
        let negative = ticks < 0;
        let magnitude = ticks.unsigned_abs();
        let scale = (0..self.digits).fold(1u128, |acc, _| acc.saturating_mul(10));
        let whole = magnitude.checked_div(scale).unwrap_or(0);
        let frac = magnitude.checked_rem(scale).unwrap_or(0);
        let sign = if negative { "-" } else { "" };
        if self.digits == 0 {
            return format!("{sign}{whole}");
        }
        format!("{sign}{whole}.{frac:0width$}", width = self.digits as usize)
    }

    /// Round a raw price onto this instrument's quoted grid.
    ///
    /// Half-up on the magnitude, so the direction of rounding does not depend
    /// on the sign — prices are positive here, but a rule that only works for
    /// positives is a rule waiting to be reused somewhere it does not hold.
    #[must_use]
    pub fn on_grid(&self, raw: i128) -> i128 {
        let point = self.point();
        if point <= 1 {
            return raw;
        }
        let half = point.saturating_div(2);
        let offset = if raw >= 0 {
            half
        } else {
            half.saturating_neg()
        };
        raw.saturating_add(offset)
            .checked_div(point)
            .map_or(raw, |q| q.saturating_mul(point))
    }
}

/// Every instrument this build can trade.
pub static INSTRUMENTS: &[Instrument] = &[
    Instrument {
        symbol: "EURUSD",
        name: "Euro / US Dollar",
        class: "FX major",
        session: SessionKind::Fx,
        digits: 5,
        reference_raw: 108_500_000, // 1.08500000
        contract_size: 100_000,
        spread_points: 12,
        max_leverage: 500,
        min_volume_milli_lots: 10,
        max_volume_milli_lots: 50_000,
        volatility_bps: 45,
        commission_per_lot_minor: 350,
    },
    Instrument {
        symbol: "GBPUSD",
        name: "Pound Sterling / US Dollar",
        class: "FX major",
        session: SessionKind::Fx,
        digits: 5,
        reference_raw: 127_200_000, // 1.27200000
        contract_size: 100_000,
        spread_points: 16,
        max_leverage: 500,
        min_volume_milli_lots: 10,
        max_volume_milli_lots: 50_000,
        volatility_bps: 55,
        commission_per_lot_minor: 350,
    },
    Instrument {
        symbol: "AUDUSD",
        name: "Australian Dollar / US Dollar",
        class: "FX major",
        session: SessionKind::Fx,
        digits: 5,
        reference_raw: 65_800_000, // 0.65800000
        contract_size: 100_000,
        spread_points: 18,
        max_leverage: 400,
        min_volume_milli_lots: 10,
        max_volume_milli_lots: 50_000,
        volatility_bps: 60,
        commission_per_lot_minor: 350,
    },
    Instrument {
        symbol: "XAUUSD",
        name: "Gold / US Dollar",
        class: "Metal",
        session: SessionKind::Metals,
        digits: 2,
        reference_raw: 235_000_000_000, // 2350.00000000
        contract_size: 100,
        spread_points: 30,
        max_leverage: 200,
        min_volume_milli_lots: 10,
        max_volume_milli_lots: 10_000,
        volatility_bps: 90,
        commission_per_lot_minor: 500,
    },
    Instrument {
        symbol: "BTCUSD",
        name: "Bitcoin / US Dollar",
        class: "Crypto",
        session: SessionKind::Crypto,
        digits: 2,
        reference_raw: 6_820_000_000_000, // 68200.00000000
        contract_size: 1,
        spread_points: 1_200,
        max_leverage: 20,
        min_volume_milli_lots: 10,
        max_volume_milli_lots: 5_000,
        volatility_bps: 320,
        commission_per_lot_minor: 1000,
    },
];

/// The instrument with this symbol, if it is tradable.
#[must_use]
pub fn find(symbol: &str) -> Option<&'static Instrument> {
    INSTRUMENTS.iter().find(|i| i.symbol == symbol)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn symbols_are_unique() {
        for (index, instrument) in INSTRUMENTS.iter().enumerate() {
            let duplicates = INSTRUMENTS
                .iter()
                .enumerate()
                .filter(|(other, candidate)| {
                    *other != index && candidate.symbol == instrument.symbol
                })
                .count();
            assert_eq!(duplicates, 0, "{} appears twice", instrument.symbol);
        }
    }

    /// Every field that later divides or scales a money amount must be usable.
    /// A zero contract size would silently make every position worth nothing.
    #[test]
    fn every_instrument_has_workable_parameters() {
        for instrument in INSTRUMENTS {
            assert!(instrument.contract_size > 0, "{}", instrument.symbol);
            assert!(instrument.max_leverage > 0, "{}", instrument.symbol);
            assert!(instrument.reference_raw > 0, "{}", instrument.symbol);
            assert!(instrument.spread_points > 0, "{}", instrument.symbol);
            assert!(
                instrument.commission_per_lot_minor > 0,
                "{} charges nothing, so a deal on it would post nothing (INV-101)",
                instrument.symbol
            );
            assert!(instrument.digits <= UNIT_SCALE, "{}", instrument.symbol);
            assert!(
                instrument.min_volume_milli_lots > 0
                    && instrument.min_volume_milli_lots <= instrument.max_volume_milli_lots,
                "{}",
                instrument.symbol
            );
        }
    }

    #[test]
    fn a_point_is_the_last_quoted_decimal_place() {
        let eurusd = find("EURUSD").unwrap();
        assert_eq!(eurusd.digits, 5);
        assert_eq!(eurusd.point(), 1_000); // 10^(8-5)
        let gold = find("XAUUSD").unwrap();
        assert_eq!(gold.point(), 1_000_000); // 10^(8-2)
    }

    #[test]
    fn rounding_lands_on_the_quoted_grid() {
        let eurusd = find("EURUSD").unwrap();
        // 1.084996 78 -> 1.08500 (nearest 5th decimal place)
        assert_eq!(eurusd.on_grid(108_499_678), 108_500_000);
        assert_eq!(eurusd.on_grid(108_499_400), 108_499_000);
        // Already on the grid: unchanged.
        assert_eq!(eurusd.on_grid(108_500_000), 108_500_000);
    }

    #[test]
    fn commission_scales_with_volume_and_rounds_up() {
        let eurusd = find("EURUSD").unwrap();
        let lot = eurusd.contract_size * 100_000_000;
        assert_eq!(eurusd.commission_minor(lot), 350, "one lot");
        assert_eq!(eurusd.commission_minor(lot * 3), 1_050, "three lots");
        assert_eq!(eurusd.commission_minor(lot / 10), 35, "a tenth of a lot");
        // A hundredth of a lot is 3.5 cents, which must not become 3.
        assert_eq!(eurusd.commission_minor(lot / 100), 4);
        // And a trade small enough to owe almost nothing still owes something.
        assert_eq!(eurusd.commission_minor(1), 1);
    }

    #[test]
    fn a_price_renders_at_the_instruments_own_precision() {
        let eurusd = find("EURUSD").unwrap();
        assert_eq!(eurusd.format_price(108_500_000), "1.08500");
        assert_eq!(eurusd.format_price(108_499_000), "1.08499");
        assert_eq!(eurusd.format_price(100_000_000), "1.00000");

        let gold = find("XAUUSD").unwrap();
        assert_eq!(gold.format_price(235_000_000_000), "2350.00");
        assert_eq!(gold.format_price(235_012_000_000), "2350.12");

        let btc = find("BTCUSD").unwrap();
        assert_eq!(btc.format_price(6_820_000_000_000), "68200.00");
    }

    #[test]
    fn a_negative_price_keeps_its_sign_in_the_right_place() {
        let eurusd = find("EURUSD").unwrap();
        // Not a price, but the same formatter renders P&L-shaped deltas.
        assert_eq!(eurusd.format_price(-108_500_000), "-1.08500");
        assert_eq!(eurusd.format_price(-1_000), "-0.00001");
    }

    #[test]
    fn an_unknown_symbol_is_not_tradable() {
        assert!(find("NOTREAL").is_none());
        assert!(find("eurusd").is_none(), "symbols are exact, not fuzzy");
    }
}

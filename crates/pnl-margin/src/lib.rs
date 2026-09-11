//! # 08-pnl-margin — what an account is actually worth
//!
//! Balance is what the ledger says. **Equity** is balance plus what the open
//! positions are currently worth, and it is the number that decides whether a
//! client can trade, and whether they get liquidated.
//!
//! ## The four laws
//!
//! - **INV-070** — `equity == balance + Σ unrealised`. Not approximately: the
//!   sum is over exact integer minor units and the equality is asserted on
//!   every valuation this crate produces.
//! - **INV-071** — `used margin == Σ per-position margin` under the active
//!   policy, and the policy version travels with the answer.
//! - **INV-072** — margin level with no used margin is **defined**: it is
//!   absent, not infinity, not zero, and never a division fault. A flat account
//!   has no margin level, and saying "none" is the honest answer where zero
//!   would read as "about to be liquidated" and a huge number would read as
//!   "perfectly safe" (INV-183).
//! - **INV-073** — every figure is reproducible from `(positions, marks,
//!   policy version)`. There is no clock read, no ambient state and no
//!   randomness in this crate, so the same three inputs give the same
//!   valuation forever.
//!
//! ## Margin is taken at the entry price
//!
//! A position's margin requirement is fixed when it opens and does not float
//! with the mark. The alternative — re-deriving margin from the current price —
//! makes a losing position consume more margin exactly as the account can least
//! afford it, which turns an ordinary drawdown into a liquidation cascade. The
//! policy is stated here so it is a decision rather than an accident.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use domain_kernel::{Money, MoneyError, Price, Rounding, Usd};
use market_core::instrument::Instrument;
use position_core::{Position, PositionError};

/// Why a valuation could not be produced.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ValuationError {
    /// A position referenced an instrument the policy does not know.
    UnknownInstrument,
    /// No mark was supplied for a symbol that has an open position. Valuing it
    /// at zero, or skipping it, would both silently misstate equity — so the
    /// whole valuation fails instead (INV-183).
    MissingMark(&'static str),
    /// Arithmetic was not representable.
    Arithmetic(MoneyError),
}

impl core::fmt::Display for ValuationError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::UnknownInstrument => f.write_str("position references an unknown instrument"),
            Self::MissingMark(symbol) => write!(f, "no market mark for {symbol}"),
            Self::Arithmetic(err) => write!(f, "arithmetic: {err}"),
        }
    }
}

impl From<MoneyError> for ValuationError {
    fn from(err: MoneyError) -> Self {
        Self::Arithmetic(err)
    }
}

impl From<PositionError> for ValuationError {
    fn from(err: PositionError) -> Self {
        match err {
            PositionError::Arithmetic(inner) => Self::Arithmetic(inner),
            _ => Self::Arithmetic(MoneyError::Overflow),
        }
    }
}

/// The margin policy in force.
///
/// Carries a version because every figure derived under it is only meaningful
/// alongside the version that produced it (INV-073, INV-081). Changing a rule
/// here without changing the version is how two systems come to disagree about
/// the same account and neither can say why.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct MarginPolicy {
    /// Version identifier, recorded on every decision made under it.
    pub version: &'static str,
    /// Margin level, in basis points, below which no new position may open.
    pub open_threshold_bp: i128,
    /// Margin level, in basis points, at which open positions are liquidated.
    pub stop_out_bp: i128,
}

/// The policy this build runs.
///
/// 100% to open and 50% to stop out are the conventional retail figures; they
/// are constants here rather than configuration because a threshold that can be
/// changed at runtime is a threshold that gets changed during an incident.
pub const POLICY: MarginPolicy = MarginPolicy {
    version: "margin-v1",
    open_threshold_bp: 10_000, // 100%
    stop_out_bp: 5_000,        // 50%
};

/// One basis point of margin level. 10 000 bp == 100%.
pub const ONE_HUNDRED_PERCENT_BP: i128 = 10_000;

/// The margin one position requires.
///
/// `notional at the entry price / leverage`, rounded **up**: rounding a margin
/// requirement down lends the client the remainder, and a fraction of a cent
/// lent a million times is not a fraction of a cent.
///
/// # Errors
/// [`ValuationError::Arithmetic`] if the notional is not representable.
pub fn position_margin(
    position: &Position,
    instrument: &Instrument,
) -> Result<Money<Usd>, ValuationError> {
    let notional = position
        .average_price
        .notional(position.quantity, Rounding::Ceil)?;
    Ok(notional.mul_ratio(1, instrument.max_leverage, Rounding::Ceil)?)
}

/// The margin a prospective order would require, before it exists as a
/// position.
///
/// Same formula, so risk cannot approve on one basis and the book charge on
/// another.
///
/// # Errors
/// [`ValuationError::Arithmetic`] if the notional is not representable.
pub fn order_margin(
    price: Price<Usd>,
    quantity: domain_kernel::Quantity,
    instrument: &Instrument,
) -> Result<Money<Usd>, ValuationError> {
    let notional = price.notional(quantity, Rounding::Ceil)?;
    Ok(notional.mul_ratio(1, instrument.max_leverage, Rounding::Ceil)?)
}

/// One position, valued.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValuedPosition {
    /// The position as the book holds it.
    pub position: Position,
    /// The mark it was valued at.
    pub mark: Price<Usd>,
    /// Profit or loss if it closed at the mark now.
    pub unrealised: Money<Usd>,
    /// Margin it is consuming.
    pub margin: Money<Usd>,
}

/// An account, valued at a moment.
///
/// Every field is derived; none is stored. Two valuations of the same inputs
/// are equal, which is what INV-073 means in practice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Valuation {
    /// What the ledger says the account holds.
    pub balance: Money<Usd>,
    /// Balance plus unrealised (INV-070).
    pub equity: Money<Usd>,
    /// Total unrealised across open positions.
    pub unrealised: Money<Usd>,
    /// Sum of per-position margin (INV-071).
    pub used_margin: Money<Usd>,
    /// Equity minus used margin. May be negative — a negative free margin is a
    /// real state, and clamping it to zero would hide the account that is about
    /// to be stopped out.
    pub free_margin: Money<Usd>,
    /// `equity / used_margin`, in basis points. `None` when nothing is open
    /// (INV-072).
    pub margin_level_bp: Option<i128>,
    /// The positions that produced these numbers.
    pub positions: Vec<ValuedPosition>,
    /// The policy version this was computed under (INV-073).
    pub policy_version: &'static str,
}

impl Valuation {
    /// Whether a new position may be opened, under the policy.
    ///
    /// A flat account has no margin level and may always open; an account with
    /// positions must be at or above the opening threshold.
    #[must_use]
    pub fn may_open(&self, policy: &MarginPolicy) -> bool {
        self.margin_level_bp
            .is_none_or(|level| level >= policy.open_threshold_bp)
    }

    /// Whether the account is at or below the stop-out level.
    #[must_use]
    pub fn is_stopped_out(&self, policy: &MarginPolicy) -> bool {
        self.margin_level_bp
            .is_some_and(|level| level <= policy.stop_out_bp)
    }
}

/// Resolve a mark for a symbol.
///
/// A function rather than a map so the caller decides where marks come from —
/// a live feed in the service, a fixed table in a test — without this crate
/// knowing about either (INV-073: the inputs are explicit).
pub trait Marks {
    /// The current mark for `symbol`, or `None` if there is not one.
    fn mark(&self, symbol: &str) -> Option<Price<Usd>>;
    /// The instrument definition for `symbol`.
    fn instrument(&self, symbol: &str) -> Option<&'static Instrument>;
}

/// Value an account.
///
/// # Errors
/// [`ValuationError`] if a position references an unknown instrument, a mark is
/// missing, or the arithmetic does not fit.
pub fn value_account(
    balance: Money<Usd>,
    positions: &[&Position],
    marks: &dyn Marks,
    policy: &MarginPolicy,
) -> Result<Valuation, ValuationError> {
    let mut valued: Vec<ValuedPosition> = Vec::with_capacity(positions.len());
    let mut unrealised = Money::<Usd>::zero();
    let mut used_margin = Money::<Usd>::zero();

    for position in positions {
        let instrument = marks
            .instrument(&position.symbol)
            .ok_or(ValuationError::UnknownInstrument)?;
        let mark = marks
            .mark(&position.symbol)
            .ok_or(ValuationError::MissingMark(instrument.symbol))?;

        let position_pnl = position.unrealised(mark)?;
        let margin = position_margin(position, instrument)?;
        unrealised = unrealised.add(position_pnl)?;
        used_margin = used_margin.add(margin)?;

        valued.push(ValuedPosition {
            position: (*position).clone(),
            mark,
            unrealised: position_pnl,
            margin,
        });
    }

    // INV-070, stated as the definition rather than checked afterwards.
    let equity = balance.add(unrealised)?;
    let free_margin = equity.sub(used_margin)?;

    // INV-072 — no used margin, no margin level. Not a division, not a
    // sentinel, not infinity: absent.
    let margin_level_bp = if used_margin.minor() == 0 {
        None
    } else {
        equity
            .minor()
            .checked_mul(ONE_HUNDRED_PERCENT_BP)
            .and_then(|scaled| Rounding::Floor.divide(scaled, used_margin.minor()))
    };

    Ok(Valuation {
        balance,
        equity,
        unrealised,
        used_margin,
        free_margin,
        margin_level_bp,
        positions: valued,
        policy_version: policy.version,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use domain_kernel::quantity::Side;
    use domain_kernel::Quantity;
    use event_kernel::Id;
    use market_core::instrument::find;

    /// A fixed mark table. Being able to state the inputs exactly is the point
    /// of the [`Marks`] trait — INV-073 is only meaningful if a test can pin
    /// every input.
    struct FixedMarks(Vec<(&'static str, i128)>);

    impl Marks for FixedMarks {
        fn mark(&self, symbol: &str) -> Option<Price<Usd>> {
            self.0
                .iter()
                .find(|(name, _)| *name == symbol)
                .map(|(_, raw)| Price::from_raw(*raw))
        }
        fn instrument(&self, symbol: &str) -> Option<&'static Instrument> {
            find(symbol)
        }
    }

    fn position(symbol: &str, side: Side, units: i128, entry: i128) -> Position {
        Position {
            account: "50000001".to_owned(),
            symbol: symbol.to_owned(),
            side,
            quantity: Quantity::from_units(units).unwrap(),
            average_price: Price::from_raw(entry),
            opened_tick: 1,
            last_event: Id(1),
        }
    }

    fn usd(decimal: &str) -> Money<Usd> {
        Money::from_decimal_str(decimal).unwrap()
    }

    /// INV-070 — equity is balance plus unrealised, exactly.
    #[test]
    fn inv_070_equity_is_balance_plus_unrealised() {
        let long = position("EURUSD", Side::Buy, 100_000, 108_000_000);
        let short = position("XAUUSD", Side::Sell, 100, 235_000_000_000);
        let marks = FixedMarks(vec![
            ("EURUSD", 108_500_000),     // +0.005 * 100 000 = +500.00
            ("XAUUSD", 234_000_000_000), // +10.00 * 100     = +1 000.00
        ]);

        let valuation = value_account(usd("10000.00"), &[&long, &short], &marks, &POLICY).unwrap();

        assert_eq!(valuation.unrealised.to_decimal_string(), "1500.00");
        assert_eq!(valuation.equity.to_decimal_string(), "11500.00");
        assert_eq!(
            valuation.equity,
            valuation.balance.add(valuation.unrealised).unwrap(),
            "INV-070"
        );
    }

    /// INV-071 — used margin is the sum of the parts, under a named policy.
    #[test]
    fn inv_071_used_margin_is_the_sum_of_per_position_margin() {
        let eurusd = find("EURUSD").unwrap();
        let gold = find("XAUUSD").unwrap();
        let long = position("EURUSD", Side::Buy, 100_000, 108_000_000);
        let short = position("XAUUSD", Side::Sell, 100, 235_000_000_000);
        let marks = FixedMarks(vec![("EURUSD", 108_000_000), ("XAUUSD", 235_000_000_000)]);

        let valuation = value_account(usd("10000.00"), &[&long, &short], &marks, &POLICY).unwrap();

        let expected = position_margin(&long, eurusd)
            .unwrap()
            .add(position_margin(&short, gold).unwrap())
            .unwrap();
        assert_eq!(valuation.used_margin, expected);
        // 100 000 * 1.08 / 500 = 216.00 ; 100 * 2350 / 200 = 1 175.00
        assert_eq!(valuation.used_margin.to_decimal_string(), "1391.00");
        assert_eq!(valuation.policy_version, "margin-v1");
    }

    /// INV-072 — no used margin, no margin level. This is the division-by-zero
    /// that has taken down risk engines, and the answer is "absent", not a
    /// number someone has to interpret.
    #[test]
    fn inv_072_margin_level_with_nothing_open_is_absent_not_a_fault() {
        let marks = FixedMarks(vec![]);
        let valuation = value_account(usd("10000.00"), &[], &marks, &POLICY).unwrap();

        assert_eq!(valuation.margin_level_bp, None);
        assert_eq!(valuation.used_margin.to_decimal_string(), "0.00");
        assert_eq!(valuation.free_margin, valuation.equity);
        // And it does not read as danger: a flat account may open.
        assert!(valuation.may_open(&POLICY));
        assert!(!valuation.is_stopped_out(&POLICY));
    }

    #[test]
    fn inv_072_margin_level_is_equity_over_used_margin_in_basis_points() {
        let long = position("EURUSD", Side::Buy, 100_000, 108_000_000);
        let marks = FixedMarks(vec![("EURUSD", 108_000_000)]);
        // Margin 216.00, equity 10 000.00 -> 4 629.62...% -> 462 962 bp
        let valuation = value_account(usd("10000.00"), &[&long], &marks, &POLICY).unwrap();
        assert_eq!(valuation.margin_level_bp, Some(462_962));
        assert!(valuation.may_open(&POLICY));
        assert!(!valuation.is_stopped_out(&POLICY));
    }

    /// INV-073 — same inputs, same answer. Every time.
    #[test]
    fn inv_073_a_valuation_is_reproducible_from_its_inputs() {
        let long = position("EURUSD", Side::Buy, 50_000, 108_000_000);
        let marks = FixedMarks(vec![("EURUSD", 108_432_000)]);
        let first = value_account(usd("2500.00"), &[&long], &marks, &POLICY).unwrap();
        let second = value_account(usd("2500.00"), &[&long], &marks, &POLICY).unwrap();
        assert_eq!(first, second);
    }

    /// A missing mark fails the whole valuation. Skipping the position would
    /// report an equity that silently excludes it (INV-183).
    #[test]
    fn a_missing_mark_fails_the_valuation_rather_than_omitting_the_position() {
        let long = position("EURUSD", Side::Buy, 100_000, 108_000_000);
        let marks = FixedMarks(vec![("XAUUSD", 235_000_000_000)]);
        assert_eq!(
            value_account(usd("10000.00"), &[&long], &marks, &POLICY),
            Err(ValuationError::MissingMark("EURUSD"))
        );
    }

    #[test]
    fn an_unknown_instrument_is_refused() {
        let mut orphan = position("EURUSD", Side::Buy, 1, 108_000_000);
        orphan.symbol = "NOTREAL".to_owned();
        let marks = FixedMarks(vec![("NOTREAL", 100_000_000)]);
        assert_eq!(
            value_account(usd("10.00"), &[&orphan], &marks, &POLICY),
            Err(ValuationError::UnknownInstrument)
        );
    }

    /// A losing account must report the truth, including a negative free
    /// margin. Clamping at zero hides exactly the account that needs attention.
    #[test]
    fn free_margin_goes_negative_rather_than_being_clamped() {
        let long = position("BTCUSD", Side::Buy, 5, 6_820_000_000_000);
        // Price halves: -34 100 * 5 = -170 500.00 unrealised.
        let marks = FixedMarks(vec![("BTCUSD", 3_410_000_000_000)]);
        let valuation = value_account(usd("100000.00"), &[&long], &marks, &POLICY).unwrap();

        assert_eq!(valuation.unrealised.to_decimal_string(), "-170500.00");
        assert_eq!(valuation.equity.to_decimal_string(), "-70500.00");
        assert!(valuation.free_margin.minor() < 0);
        assert!(valuation.is_stopped_out(&POLICY));
        assert!(!valuation.may_open(&POLICY));
    }

    /// Margin rounds up. A requirement rounded down is credit extended by
    /// accident.
    #[test]
    fn margin_rounds_against_the_client_not_in_their_favour() {
        let gold = find("XAUUSD").unwrap();
        // 1 unit at 2350.005 / 200 = 11.750025 -> must be 11.76, not 11.75.
        let awkward = position("XAUUSD", Side::Buy, 1, 235_000_500_000);
        let margin = position_margin(&awkward, gold).unwrap();
        assert_eq!(margin.to_decimal_string(), "11.76");
    }

    /// Risk sizes an order and the book charges the position: both must use the
    /// same formula, or an order approved at the limit fails to book.
    #[test]
    fn an_order_and_the_position_it_becomes_require_the_same_margin() {
        let eurusd = find("EURUSD").unwrap();
        let price = Price::from_raw(108_437_000);
        let quantity = Quantity::from_units(100_000).unwrap();
        let opened = Position {
            account: "50000001".to_owned(),
            symbol: "EURUSD".to_owned(),
            side: Side::Buy,
            quantity,
            average_price: price,
            opened_tick: 1,
            last_event: Id(1),
        };
        assert_eq!(
            order_margin(price, quantity, eurusd).unwrap(),
            position_margin(&opened, eurusd).unwrap()
        );
    }

    #[test]
    fn margin_does_not_float_with_the_mark() {
        let eurusd = find("EURUSD").unwrap();
        let long = position("EURUSD", Side::Buy, 100_000, 108_000_000);
        let calm = FixedMarks(vec![("EURUSD", 108_000_000)]);
        let crash = FixedMarks(vec![("EURUSD", 90_000_000)]);

        let a = value_account(usd("10000.00"), &[&long], &calm, &POLICY).unwrap();
        let b = value_account(usd("10000.00"), &[&long], &crash, &POLICY).unwrap();
        assert_eq!(a.used_margin, b.used_margin, "margin followed the price");
        assert_eq!(a.used_margin, position_margin(&long, eurusd).unwrap());
        assert!(b.equity.minor() < a.equity.minor());
    }
}

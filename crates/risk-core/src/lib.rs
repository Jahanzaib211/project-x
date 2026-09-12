//! # 09-risk — the gate every order passes through
//!
//! Risk is the last place an order can be stopped for free. After it, the order
//! becomes a deal, the deal becomes ledger postings, and undoing any of that
//! costs a reconciliation.
//!
//! ## The four laws
//!
//! - **INV-080** — identical input and policy version produce an identical
//!   decision. [`assess`] is a pure function of its arguments: no clock, no
//!   I/O, no ambient state.
//! - **INV-081** — a decision records the exact input snapshot and policy
//!   version that produced it. [`Approval::snapshot`] carries it, so a fill can
//!   be explained months later without re-deriving what the account looked like.
//! - **INV-082** — no order reaches execution without a recorded decision.
//!   This is enforced by the type system, not by review: [`Approval`] has a
//!   private field, so the only way to obtain one is [`assess`] returning it,
//!   and `11-execution` will not build a transaction without one.
//! - **INV-083** — **risk fails closed.** An engine that cannot evaluate
//!   rejects. [`unavailable`] is the only behaviour available when inputs are
//!   missing, and there is no code path in this crate that produces an
//!   `Approval` from an error.
//!
//! ## Why the checks are ordered
//!
//! The cheapest and most certain rejections come first, so a malformed order is
//! refused before an account is valued. The order is fixed and tested, because
//! a client who fixes one problem and hits the next should be walked down a
//! stable list rather than a different one each time.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use domain_kernel::quantity::Side;
use domain_kernel::{Money, Price, Quantity, Usd};
use market_core::instrument::Instrument;
use pnl_margin::{order_margin, MarginPolicy, Valuation};

/// Why an order was refused.
///
/// Every variant is a reason a client can be told, in those words. "Rejected"
/// with no reason is how support tickets are made.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Rejection {
    /// The symbol is not tradable here.
    UnknownInstrument,
    /// The account is not in a state that may originate financial effects
    /// (INV-032).
    AccountNotTradable,
    /// Below the instrument's minimum volume.
    VolumeBelowMinimum {
        /// The minimum, in thousandths of a lot.
        minimum_milli_lots: i128,
    },
    /// Above the instrument's maximum single-order volume.
    VolumeAboveMaximum {
        /// The maximum, in thousandths of a lot.
        maximum_milli_lots: i128,
    },
    /// The account does not have enough free margin for this order.
    InsufficientFreeMargin {
        /// What the order needs, in minor units.
        required_minor: i128,
        /// What the account has, in minor units.
        available_minor: i128,
    },
    /// The account is already below the level at which new positions may open.
    MarginLevelTooLow {
        /// The account's level, in basis points.
        level_bp: i128,
        /// The threshold it must meet.
        threshold_bp: i128,
    },
    /// The market state offered was too old to trade on (INV-062).
    StaleMarket {
        /// How old it was.
        age_ms: u64,
    },
    /// The instrument's market is closed (INV-084). The price on offer is a
    /// frozen one, and nothing fills at a frozen price.
    MarketClosed,
    /// The engine could not evaluate. Fails closed (INV-083).
    EngineUnavailable,
}

impl Rejection {
    /// A stable machine-readable code. Clients branch on this, so it is part of
    /// the API contract and does not change with the prose.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::UnknownInstrument => "UNKNOWN_INSTRUMENT",
            Self::AccountNotTradable => "ACCOUNT_NOT_TRADABLE",
            Self::VolumeBelowMinimum { .. } => "VOLUME_BELOW_MINIMUM",
            Self::VolumeAboveMaximum { .. } => "VOLUME_ABOVE_MAXIMUM",
            Self::InsufficientFreeMargin { .. } => "INSUFFICIENT_FREE_MARGIN",
            Self::MarginLevelTooLow { .. } => "MARGIN_LEVEL_TOO_LOW",
            Self::StaleMarket { .. } => "STALE_MARKET",
            Self::MarketClosed => "MARKET_CLOSED",
            Self::EngineUnavailable => "RISK_ENGINE_UNAVAILABLE",
        }
    }
}

impl Rejection {
    /// Recover a rejection from its logged form: the code plus the numbers
    /// the code carries, in the order [`Rejection::code`] lists them.
    ///
    /// Used when a journal replays a refused order (INV-082: a decision is
    /// kept). `None` for a code this version does not know.
    #[must_use]
    pub fn from_logged(code: &str, numbers: &[i128]) -> Option<Self> {
        let n = |i: usize| numbers.get(i).copied().unwrap_or(0);
        Some(match code {
            "UNKNOWN_INSTRUMENT" => Self::UnknownInstrument,
            "ACCOUNT_NOT_TRADABLE" => Self::AccountNotTradable,
            "VOLUME_BELOW_MINIMUM" => Self::VolumeBelowMinimum {
                minimum_milli_lots: n(0),
            },
            "VOLUME_ABOVE_MAXIMUM" => Self::VolumeAboveMaximum {
                maximum_milli_lots: n(0),
            },
            "INSUFFICIENT_FREE_MARGIN" => Self::InsufficientFreeMargin {
                required_minor: n(0),
                available_minor: n(1),
            },
            "MARGIN_LEVEL_TOO_LOW" => Self::MarginLevelTooLow {
                level_bp: n(0),
                threshold_bp: n(1),
            },
            "STALE_MARKET" => Self::StaleMarket {
                age_ms: u64::try_from(n(0)).unwrap_or(0),
            },
            "MARKET_CLOSED" => Self::MarketClosed,
            "RISK_ENGINE_UNAVAILABLE" => Self::EngineUnavailable,
            _ => return None,
        })
    }

    /// The numbers a rejection carries, in a stable order, for the log.
    #[must_use]
    pub fn numbers(self) -> Vec<i128> {
        match self {
            Self::VolumeBelowMinimum { minimum_milli_lots } => vec![minimum_milli_lots],
            Self::VolumeAboveMaximum { maximum_milli_lots } => vec![maximum_milli_lots],
            Self::InsufficientFreeMargin {
                required_minor,
                available_minor,
            } => vec![required_minor, available_minor],
            Self::MarginLevelTooLow {
                level_bp,
                threshold_bp,
            } => vec![level_bp, threshold_bp],
            Self::StaleMarket { age_ms } => vec![i128::from(age_ms)],
            Self::UnknownInstrument
            | Self::AccountNotTradable
            | Self::MarketClosed
            | Self::EngineUnavailable => Vec::new(),
        }
    }
}

impl core::fmt::Display for Rejection {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::UnknownInstrument => f.write_str("that instrument is not tradable"),
            Self::AccountNotTradable => f.write_str("this account cannot place orders"),
            Self::VolumeBelowMinimum { minimum_milli_lots } => write!(
                f,
                "volume is below the minimum of {} lots",
                milli_lots_to_text(*minimum_milli_lots)
            ),
            Self::VolumeAboveMaximum { maximum_milli_lots } => write!(
                f,
                "volume is above the maximum of {} lots",
                milli_lots_to_text(*maximum_milli_lots)
            ),
            Self::InsufficientFreeMargin { .. } => f.write_str("not enough free margin"),
            Self::MarginLevelTooLow { .. } => {
                f.write_str("margin level is below the level required to open")
            }
            Self::StaleMarket { age_ms } => {
                write!(f, "the price is {age_ms}ms old and cannot be traded on")
            }
            Self::MarketClosed => f.write_str("the market for this instrument is closed"),
            Self::EngineUnavailable => {
                f.write_str("risk checks are unavailable, so the order was refused")
            }
        }
    }
}

/// Render thousandths of a lot as a decimal string, without floating point.
fn milli_lots_to_text(milli_lots: i128) -> String {
    let whole = milli_lots.checked_div(1_000).unwrap_or(0);
    let frac = milli_lots.checked_rem(1_000).unwrap_or(0).abs();
    format!("{whole}.{frac:03}")
}

/// Exactly what risk looked at, kept so the decision can be explained later.
///
/// This is INV-081 made concrete. Every number here was an input; none is
/// re-derived at read time, because a snapshot that recomputes itself is not a
/// snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    /// Account the order was for.
    pub account: String,
    /// Instrument symbol.
    pub symbol: &'static str,
    /// Side of the order.
    pub side: Side,
    /// Quantity in scaled units.
    pub quantity_raw: i128,
    /// The price risk assessed against.
    pub price_raw: i128,
    /// The tick that price came from.
    pub tick: u64,
    /// Account equity at the time, in minor units.
    pub equity_minor: i128,
    /// Free margin at the time, in minor units.
    pub free_margin_minor: i128,
    /// Used margin at the time, in minor units.
    pub used_margin_minor: i128,
    /// Margin level at the time, if there was one.
    pub margin_level_bp: Option<i128>,
    /// The margin this order required.
    pub required_margin_minor: i128,
    /// Margin policy version in force.
    pub policy_version: &'static str,
    /// Risk policy version in force.
    pub risk_version: &'static str,
}

/// Permission to execute one specific order.
///
/// The private field is the whole point: an `Approval` cannot be constructed
/// outside this crate, so no amount of care or carelessness downstream can
/// produce one without [`assess`] having run and said yes (INV-082).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Approval {
    snapshot: Snapshot,
    required_margin: Money<Usd>,
    /// Uninhabited from outside: this field is what makes the struct
    /// unconstructible elsewhere.
    _sealed: Sealed,
}

/// A private marker. Not exported, so no external module can name it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Sealed;

impl Approval {
    /// What risk looked at when it approved (INV-081).
    #[must_use]
    pub const fn snapshot(&self) -> &Snapshot {
        &self.snapshot
    }

    /// The margin this order was approved to consume.
    #[must_use]
    pub const fn required_margin(&self) -> Money<Usd> {
        self.required_margin
    }

    /// The account the approval is for. Execution must check this matches the
    /// order it is about to book.
    #[must_use]
    pub fn account(&self) -> &str {
        &self.snapshot.account
    }
}

/// The outcome of a risk assessment. Recorded either way (INV-082): a rejection
/// is a decision, and it is kept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// The order may proceed.
    Approved(Box<Approval>),
    /// The order may not proceed, and this is why.
    Rejected {
        /// The reason.
        reason: Rejection,
        /// What was looked at, where anything was. `None` when the engine could
        /// not evaluate at all.
        snapshot: Option<Box<Snapshot>>,
        /// Risk policy version.
        risk_version: &'static str,
    },
}

impl Decision {
    /// The approval, if this decision was one.
    #[must_use]
    pub fn approval(&self) -> Option<&Approval> {
        match self {
            Self::Approved(approval) => Some(approval),
            Self::Rejected { .. } => None,
        }
    }

    /// Whether the order may proceed.
    #[must_use]
    pub const fn is_approved(&self) -> bool {
        matches!(self, Self::Approved(_))
    }
}

/// The risk policy version. Travels on every decision (INV-081).
pub const RISK_VERSION: &str = "risk-v1";

/// The order risk is being asked about.
#[derive(Clone, Debug)]
pub struct OrderIntent<'a> {
    /// Trading account number.
    pub account: &'a str,
    /// The instrument.
    pub instrument: &'a Instrument,
    /// Side.
    pub side: Side,
    /// Quantity, in scaled base units.
    pub quantity: Quantity,
    /// The price this would fill at.
    pub price: Price<Usd>,
    /// The tick that price came from.
    pub tick: u64,
    /// How old the market state was when it was read.
    pub market_age_ms: u64,
    /// Whether the account is in a state that may trade (INV-032).
    pub account_tradable: bool,
    /// Whether the instrument's market is open at `tick` (INV-084).
    pub session_open: bool,
    /// Whether this order closes out the whole of an existing position.
    ///
    /// The venue's minimum order size is a rule about *opening*. A residual
    /// position below it — left by a partial close, or by two orders that
    /// netted — must still be closable, or it is a position the client can
    /// never leave. Every other check applies to a close as to any order.
    pub closes_position: bool,
}

/// The oldest market state an order may be assessed against (INV-062).
pub const MAX_MARKET_AGE_MS: u64 = 2_000;

/// Assess an order.
///
/// Pure: same intent, same valuation, same policy, same decision — forever
/// (INV-080).
#[must_use]
pub fn assess(intent: &OrderIntent<'_>, valuation: &Valuation, policy: &MarginPolicy) -> Decision {
    // Cheapest and most certain first, so the client is walked down a stable
    // list rather than a different one on each attempt.
    if !intent.account_tradable {
        return reject(Rejection::AccountNotTradable, None);
    }
    // INV-084 — before anything about price or margin. A closed market has no
    // price to reason about; the one on offer is frozen and would fill nobody.
    if !intent.session_open {
        return reject(Rejection::MarketClosed, None);
    }

    let milli_lots = milli_lots_of(intent.quantity, intent.instrument);
    if milli_lots <= 0 {
        return reject(
            Rejection::VolumeBelowMinimum {
                minimum_milli_lots: intent.instrument.min_volume_milli_lots,
            },
            None,
        );
    }
    if milli_lots < intent.instrument.min_volume_milli_lots && !intent.closes_position {
        return reject(
            Rejection::VolumeBelowMinimum {
                minimum_milli_lots: intent.instrument.min_volume_milli_lots,
            },
            None,
        );
    }
    if milli_lots > intent.instrument.max_volume_milli_lots {
        return reject(
            Rejection::VolumeAboveMaximum {
                maximum_milli_lots: intent.instrument.max_volume_milli_lots,
            },
            None,
        );
    }
    if intent.market_age_ms > MAX_MARKET_AGE_MS {
        return reject(
            Rejection::StaleMarket {
                age_ms: intent.market_age_ms,
            },
            None,
        );
    }

    // INV-083 — if the margin cannot be computed, the answer is no. There is
    // deliberately no branch here that approves on an error.
    let Ok(required) = order_margin(intent.price, intent.quantity, intent.instrument) else {
        return reject(Rejection::EngineUnavailable, None);
    };

    let snapshot = Snapshot {
        account: intent.account.to_owned(),
        symbol: intent.instrument.symbol,
        side: intent.side,
        quantity_raw: intent.quantity.raw(),
        price_raw: intent.price.raw(),
        tick: intent.tick,
        equity_minor: valuation.equity.minor(),
        free_margin_minor: valuation.free_margin.minor(),
        used_margin_minor: valuation.used_margin.minor(),
        margin_level_bp: valuation.margin_level_bp,
        required_margin_minor: required.minor(),
        policy_version: valuation.policy_version,
        risk_version: RISK_VERSION,
    };

    if !valuation.may_open(policy) {
        // `may_open` is false only when a level exists, so this reads the level
        // that actually failed rather than inventing one.
        let level_bp = valuation.margin_level_bp.unwrap_or(0);
        return reject(
            Rejection::MarginLevelTooLow {
                level_bp,
                threshold_bp: policy.open_threshold_bp,
            },
            Some(snapshot),
        );
    }

    if valuation.free_margin.minor() < required.minor() {
        return reject(
            Rejection::InsufficientFreeMargin {
                required_minor: required.minor(),
                available_minor: valuation.free_margin.minor(),
            },
            Some(snapshot),
        );
    }

    Decision::Approved(Box::new(Approval {
        snapshot,
        required_margin: required,
        _sealed: Sealed,
    }))
}

/// The decision to make when risk cannot be evaluated at all (INV-083).
///
/// Named, exported and tested, so "fail closed" is a function someone calls
/// rather than a paragraph someone remembers.
#[must_use]
pub const fn unavailable() -> Decision {
    Decision::Rejected {
        reason: Rejection::EngineUnavailable,
        snapshot: None,
        risk_version: RISK_VERSION,
    }
}

fn reject(reason: Rejection, snapshot: Option<Snapshot>) -> Decision {
    Decision::Rejected {
        reason,
        snapshot: snapshot.map(Box::new),
        risk_version: RISK_VERSION,
    }
}

/// A quantity expressed in thousandths of a lot, for the volume limits.
fn milli_lots_of(quantity: Quantity, instrument: &Instrument) -> i128 {
    let units_per_lot = instrument
        .contract_size
        .checked_mul(100_000_000)
        .unwrap_or(i128::MAX);
    quantity
        .raw()
        .checked_mul(1_000)
        .and_then(|scaled| scaled.checked_div(units_per_lot))
        .unwrap_or(i128::MAX)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use domain_kernel::Money;
    use market_core::instrument::find;
    use pnl_margin::POLICY;

    fn usd(decimal: &str) -> Money<Usd> {
        Money::from_decimal_str(decimal).unwrap()
    }

    /// A flat account with `balance` and nothing open.
    fn flat(balance: &str) -> Valuation {
        Valuation {
            balance: usd(balance),
            equity: usd(balance),
            unrealised: Money::zero(),
            used_margin: Money::zero(),
            free_margin: usd(balance),
            margin_level_bp: None,
            positions: Vec::new(),
            policy_version: POLICY.version,
        }
    }

    fn intent<'a>(instrument: &'a Instrument, lots_milli: i128) -> OrderIntent<'a> {
        let units_per_lot = instrument.contract_size.saturating_mul(100_000_000);
        OrderIntent {
            account: "50000001",
            instrument,
            side: Side::Buy,
            quantity: Quantity::from_raw(
                units_per_lot
                    .saturating_mul(lots_milli)
                    .checked_div(1_000)
                    .unwrap_or(0),
            ),
            price: Price::from_raw(instrument.reference_raw),
            tick: 1_000,
            market_age_ms: 0,
            account_tradable: true,
            session_open: true,
            closes_position: false,
        }
    }

    /// INV-080 — the same question gets the same answer. Always.
    #[test]
    fn inv_080_the_same_input_produces_the_same_decision() {
        let eurusd = find("EURUSD").unwrap();
        let order = intent(eurusd, 100);
        let account = flat("10000.00");
        let first = assess(&order, &account, &POLICY);
        let second = assess(&order, &account, &POLICY);
        assert_eq!(first, second);
        assert!(first.is_approved());
    }

    /// INV-081 — the decision carries what produced it.
    #[test]
    fn inv_081_an_approval_records_its_input_snapshot_and_versions() {
        let eurusd = find("EURUSD").unwrap();
        let order = intent(eurusd, 100); // 0.10 lots
        let decision = assess(&order, &flat("10000.00"), &POLICY);
        let approval = decision.approval().unwrap();
        let snapshot = approval.snapshot();

        assert_eq!(snapshot.account, "50000001");
        assert_eq!(snapshot.symbol, "EURUSD");
        assert_eq!(snapshot.side, Side::Buy);
        assert_eq!(snapshot.tick, 1_000);
        assert_eq!(snapshot.equity_minor, 1_000_000);
        assert_eq!(snapshot.free_margin_minor, 1_000_000);
        assert_eq!(snapshot.margin_level_bp, None);
        assert_eq!(snapshot.risk_version, "risk-v1");
        assert_eq!(snapshot.policy_version, "margin-v1");
        // 10 000 units at 1.085 / 500 leverage = 21.70
        assert_eq!(approval.required_margin().to_decimal_string(), "21.70");
        assert_eq!(snapshot.required_margin_minor, 2_170);
    }

    /// INV-081 — a rejection that got far enough to look at the account keeps
    /// what it looked at, so "why was I refused" has an answer.
    #[test]
    fn inv_081_a_margin_rejection_keeps_the_snapshot_that_caused_it() {
        let eurusd = find("EURUSD").unwrap();
        let order = intent(eurusd, 1_000); // 1 lot: needs 217.00
        let decision = assess(&order, &flat("100.00"), &POLICY);

        match decision {
            Decision::Rejected {
                reason,
                snapshot,
                risk_version,
            } => {
                assert_eq!(
                    reason,
                    Rejection::InsufficientFreeMargin {
                        required_minor: 21_700,
                        available_minor: 10_000,
                    }
                );
                assert_eq!(reason.code(), "INSUFFICIENT_FREE_MARGIN");
                assert_eq!(risk_version, "risk-v1");
                let snapshot = snapshot.unwrap();
                assert_eq!(snapshot.equity_minor, 10_000);
                assert_eq!(snapshot.required_margin_minor, 21_700);
            }
            Decision::Approved(_) => panic!("should not have been approved"),
        }
    }

    /// INV-082 — an `Approval` cannot be forged. This test documents the
    /// mechanism; the compiler enforces it, since `Approval { .. }` does not
    /// compile outside this crate and there is no public constructor.
    #[test]
    fn inv_082_the_only_source_of_an_approval_is_a_successful_assessment() {
        let eurusd = find("EURUSD").unwrap();
        let refused = assess(&intent(eurusd, 1), &flat("10000.00"), &POLICY);
        assert!(refused.approval().is_none(), "below minimum volume");
        assert!(unavailable().approval().is_none());

        let allowed = assess(&intent(eurusd, 100), &flat("10000.00"), &POLICY);
        assert!(allowed.approval().is_some());
    }

    /// INV-083 — an engine that cannot answer says no.
    #[test]
    fn inv_083_risk_fails_closed() {
        let decision = unavailable();
        assert!(!decision.is_approved());
        match decision {
            Decision::Rejected { reason, .. } => {
                assert_eq!(reason, Rejection::EngineUnavailable);
                assert_eq!(reason.code(), "RISK_ENGINE_UNAVAILABLE");
            }
            Decision::Approved(_) => panic!("fail-closed produced an approval"),
        }
    }

    /// INV-083, the harder half: an *overflowing* input must reject rather than
    /// slip through. A quantity this large cannot have its margin computed.
    #[test]
    fn inv_083_an_uncomputable_order_rejects_rather_than_approving() {
        let eurusd = find("EURUSD").unwrap();
        let mut order = intent(eurusd, 1_000);
        order.quantity = Quantity::from_raw(i128::MAX);
        let decision = assess(&order, &flat("100000000.00"), &POLICY);
        assert!(!decision.is_approved());
    }

    #[test]
    fn volume_limits_are_enforced_at_both_ends() {
        let eurusd = find("EURUSD").unwrap();
        let account = flat("100000000.00");

        match assess(&intent(eurusd, 9), &account, &POLICY) {
            Decision::Rejected { reason, .. } => assert_eq!(
                reason,
                Rejection::VolumeBelowMinimum {
                    minimum_milli_lots: 10
                }
            ),
            Decision::Approved(_) => panic!("0.009 lots should be below the minimum"),
        }
        // Exactly at the minimum is allowed: the boundary belongs to the client.
        assert!(assess(&intent(eurusd, 10), &account, &POLICY).is_approved());

        match assess(&intent(eurusd, 50_001), &account, &POLICY) {
            Decision::Rejected { reason, .. } => assert_eq!(
                reason,
                Rejection::VolumeAboveMaximum {
                    maximum_milli_lots: 50_000
                }
            ),
            Decision::Approved(_) => panic!("above the maximum should be refused"),
        }
        assert!(assess(&intent(eurusd, 50_000), &account, &POLICY).is_approved());
    }

    #[test]
    fn a_stale_price_cannot_be_traded_on() {
        let eurusd = find("EURUSD").unwrap();
        let mut order = intent(eurusd, 100);
        order.market_age_ms = MAX_MARKET_AGE_MS.saturating_add(1);
        match assess(&order, &flat("10000.00"), &POLICY) {
            Decision::Rejected { reason, .. } => {
                assert_eq!(reason, Rejection::StaleMarket { age_ms: 2_001 });
            }
            Decision::Approved(_) => panic!("a stale price must not trade"),
        }
        order.market_age_ms = MAX_MARKET_AGE_MS;
        assert!(assess(&order, &flat("10000.00"), &POLICY).is_approved());
    }

    /// A residual below the venue minimum can still be closed — and only
    /// closed: the same size as an opening order is refused, and zero is
    /// refused either way.
    #[test]
    fn a_residual_below_the_minimum_can_be_closed_but_not_opened() {
        let eurusd = find("EURUSD").unwrap();
        let mut order = intent(eurusd, 5); // 0.005 lots, below the 0.010 minimum
        assert!(matches!(
            assess(&order, &flat("10000.00"), &POLICY),
            Decision::Rejected {
                reason: Rejection::VolumeBelowMinimum { .. },
                ..
            }
        ));
        order.closes_position = true;
        assert!(assess(&order, &flat("10000.00"), &POLICY).is_approved());
        let mut zero = intent(eurusd, 0);
        zero.closes_position = true;
        assert!(matches!(
            assess(&zero, &flat("10000.00"), &POLICY),
            Decision::Rejected {
                reason: Rejection::VolumeBelowMinimum { .. },
                ..
            }
        ));
    }

    /// INV-084 — a closed market is refused before price or margin is
    /// considered, however well funded the account is.
    #[test]
    fn inv_084_a_closed_market_is_refused_regardless_of_margin() {
        let eurusd = find("EURUSD").unwrap();
        let mut order = intent(eurusd, 100);
        order.session_open = false;
        match assess(&order, &flat("1000000.00"), &POLICY) {
            Decision::Rejected {
                reason, snapshot, ..
            } => {
                assert_eq!(reason, Rejection::MarketClosed);
                assert!(snapshot.is_none(), "no price was reasoned about");
            }
            Decision::Approved(_) => panic!("a closed market must not fill"),
        }
        order.session_open = true;
        assert!(assess(&order, &flat("10000.00"), &POLICY).is_approved());
    }

    #[test]
    fn a_non_tradable_account_is_refused_before_anything_else_is_considered() {
        let eurusd = find("EURUSD").unwrap();
        let mut order = intent(eurusd, 100);
        order.account_tradable = false;
        match assess(&order, &flat("10000.00"), &POLICY) {
            Decision::Rejected {
                reason, snapshot, ..
            } => {
                assert_eq!(reason, Rejection::AccountNotTradable);
                assert!(snapshot.is_none(), "nothing was looked at yet");
            }
            Decision::Approved(_) => panic!("a frozen account must not trade"),
        }
    }

    /// The exactly-at-the-limit case: free margin equal to the requirement is
    /// allowed, one minor unit short is not.
    #[test]
    fn the_margin_boundary_is_inclusive_and_one_cent_matters() {
        let eurusd = find("EURUSD").unwrap();
        let order = intent(eurusd, 1_000); // needs 217.00
        assert!(assess(&order, &flat("217.00"), &POLICY).is_approved());
        assert!(!assess(&order, &flat("216.99"), &POLICY).is_approved());
    }

    #[test]
    fn an_account_below_the_opening_threshold_cannot_add_risk() {
        let eurusd = find("EURUSD").unwrap();
        let stressed = Valuation {
            balance: usd("1000.00"),
            equity: usd("150.00"),
            unrealised: usd("-850.00"),
            used_margin: usd("217.00"),
            free_margin: usd("-67.00"),
            // 150 / 217 = 69.1% -> below the 100% opening threshold.
            margin_level_bp: Some(6_912),
            positions: Vec::new(),
            policy_version: POLICY.version,
        };
        match assess(&intent(eurusd, 100), &stressed, &POLICY) {
            Decision::Rejected {
                reason, snapshot, ..
            } => {
                assert_eq!(
                    reason,
                    Rejection::MarginLevelTooLow {
                        level_bp: 6_912,
                        threshold_bp: 10_000,
                    }
                );
                assert!(snapshot.is_some(), "the account was looked at");
            }
            Decision::Approved(_) => panic!("must not add risk below the threshold"),
        }
    }

    const ALL_REASONS: [Rejection; 9] = [
        Rejection::UnknownInstrument,
        Rejection::AccountNotTradable,
        Rejection::VolumeBelowMinimum {
            minimum_milli_lots: 10,
        },
        Rejection::VolumeAboveMaximum {
            maximum_milli_lots: 50_000,
        },
        Rejection::InsufficientFreeMargin {
            required_minor: 1,
            available_minor: 0,
        },
        Rejection::MarginLevelTooLow {
            level_bp: 1,
            threshold_bp: 2,
        },
        Rejection::StaleMarket { age_ms: 1 },
        Rejection::MarketClosed,
        Rejection::EngineUnavailable,
    ];

    #[test]
    fn every_rejection_has_a_stable_code_and_readable_text() {
        for reason in ALL_REASONS {
            assert_eq!(
                Rejection::from_logged(reason.code(), &reason.numbers()),
                Some(reason),
                "{reason:?} does not survive the log"
            );
        }
        assert_eq!(Rejection::from_logged("NOPE", &[]), None);
        for reason in [
            Rejection::UnknownInstrument,
            Rejection::AccountNotTradable,
            Rejection::VolumeBelowMinimum {
                minimum_milli_lots: 10,
            },
            Rejection::VolumeAboveMaximum {
                maximum_milli_lots: 50_000,
            },
            Rejection::InsufficientFreeMargin {
                required_minor: 1,
                available_minor: 0,
            },
            Rejection::MarginLevelTooLow {
                level_bp: 1,
                threshold_bp: 2,
            },
            Rejection::StaleMarket { age_ms: 1 },
            Rejection::MarketClosed,
            Rejection::EngineUnavailable,
        ] {
            assert!(!reason.code().is_empty());
            assert!(reason
                .code()
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b == b'_'));
            assert!(!reason.to_string().is_empty());
        }
        assert_eq!(milli_lots_to_text(10), "0.010");
        assert_eq!(milli_lots_to_text(50_000), "50.000");
    }
}

//! # 06-market-data — canonical market state
//!
//! One validated, timestamped market state that everything price-dependent
//! reads, and nothing price-dependent goes around.
//!
//! ## The feed is a pure function of the tick index
//!
//! A real deployment reads a provider socket. This build synthesises the feed
//! instead — but it does so as a **pure function** `(instrument, tick) -> mid`,
//! not as a stateful generator with a random seed in a mutable field. That
//! choice is what makes everything downstream testable:
//!
//! - **Replay is exact.** Replaying an order that filled at tick 41 209 011
//!   recomputes the same mid, so a fill can be re-derived from the journal
//!   alone (INV-014, INV-024). A generator holding state could not do that.
//! - **History is free.** A chart asking for 200 candles does not need 200
//!   candles to have been stored; any past tick is computable.
//! - **Tests do not sleep.** A test asserts on tick 1 000 rather than waiting
//!   for one to arrive.
//!
//! The only thing the real feed adds is where the tick index comes from: here
//! the service reads a clock at the system boundary and divides. That read is
//! the *whole* of the non-determinism, and it happens outside this crate.
//!
//! ## Rules
//!
//! - **INV-050** — a quote that fails validation never reaches the canonical
//!   state. [`Quote::validated`] is the only constructor.
//! - **INV-051** — a consumer can always tell how stale a state is, so it can
//!   refuse to act on it.
//! - **INV-052** — the canonical state for a tick is identical everywhere.
//! - **INV-053** — outside its session an instrument's quote is frozen at the
//!   last open tick; no new price is produced while the market is closed.
//! - **INV-061** — bid <= ask on every quote (enforced at construction).

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod candle;
pub mod feed;
pub mod instrument;
pub mod series;
pub mod session;

pub use candle::{Candle, Interval};
pub use feed::{FeedStore, RecordedQuote};
pub use instrument::{Instrument, INSTRUMENTS};
pub use series::mid_raw;
pub use session::{SessionKind, SessionState};

use domain_kernel::{MoneyError, Price, Usd};

/// Why market state could not be produced or used.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum MarketError {
    /// No instrument with that symbol.
    UnknownInstrument,
    /// The requested interval is not one this feed publishes.
    UnknownInterval,
    /// A quote failed validation and was refused (INV-050).
    InvalidQuote(&'static str),
    /// The state is older than the caller's tolerance (INV-051).
    Stale {
        /// How old the state actually is.
        age_ms: u64,
        /// The oldest the caller was willing to accept.
        max_age_ms: u64,
    },
    /// Arithmetic on a price or amount was not representable.
    Arithmetic(MoneyError),
}

impl core::fmt::Display for MarketError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::UnknownInstrument => f.write_str("unknown instrument"),
            Self::UnknownInterval => f.write_str("unknown interval"),
            Self::InvalidQuote(why) => write!(f, "invalid quote: {why}"),
            Self::Stale { age_ms, max_age_ms } => {
                write!(f, "market state is {age_ms}ms old, limit is {max_age_ms}ms")
            }
            Self::Arithmetic(err) => write!(f, "arithmetic: {err}"),
        }
    }
}

impl From<MoneyError> for MarketError {
    fn from(err: MoneyError) -> Self {
        Self::Arithmetic(err)
    }
}

/// How long one tick of the canonical feed lasts, in milliseconds.
///
/// The tick index is `epoch_ms / TICK_MS`, so this is the resolution at which
/// two observers agree without talking to each other (INV-052).
pub const TICK_MS: u64 = 250;

/// One validated, canonical two-sided quote.
///
/// There is no public constructor other than [`Quote::validated`]. A struct
/// literal would let an unchecked quote exist, and an unchecked quote that
/// exists eventually reaches a fill (INV-050).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    symbol: &'static str,
    tick: u64,
    bid: Price<Usd>,
    ask: Price<Usd>,
    /// The tick the prices were actually produced at. Equal to `tick` while
    /// the market is open; the last open tick while it is closed (INV-053).
    priced_tick: u64,
    session_open: bool,
}

impl Quote {
    /// Build a quote, checking everything that must be true of one.
    ///
    /// # Errors
    /// [`MarketError::InvalidQuote`] if a side is non-positive or crossed.
    pub fn validated(
        symbol: &'static str,
        tick: u64,
        bid: Price<Usd>,
        ask: Price<Usd>,
    ) -> Result<Self, MarketError> {
        if bid.raw() <= 0 || ask.raw() <= 0 {
            return Err(MarketError::InvalidQuote("a price must be positive"));
        }
        // INV-061. A crossed quote is not a tight quote, it is a broken feed,
        // and letting one through hands free money to whoever notices first.
        if bid > ask {
            return Err(MarketError::InvalidQuote("bid exceeds ask"));
        }
        Ok(Self {
            symbol,
            tick,
            bid,
            ask,
            priced_tick: tick,
            session_open: true,
        })
    }

    /// Mark this quote as frozen: produced at `priced_tick`, carried forward
    /// unchanged to `tick` because the market has been closed since.
    #[must_use]
    pub const fn frozen_since(mut self, priced_tick: u64) -> Self {
        self.priced_tick = priced_tick;
        self.session_open = false;
        self
    }

    /// Whether the market was open at this quote's tick.
    #[must_use]
    pub const fn session_open(&self) -> bool {
        self.session_open
    }

    /// The tick the prices were produced at (INV-053).
    #[must_use]
    pub const fn priced_tick(&self) -> u64 {
        self.priced_tick
    }

    /// The instrument symbol.
    #[must_use]
    pub const fn symbol(&self) -> &'static str {
        self.symbol
    }

    /// The tick this state belongs to.
    #[must_use]
    pub const fn tick(&self) -> u64 {
        self.tick
    }

    /// The bid.
    #[must_use]
    pub const fn bid(&self) -> Price<Usd> {
        self.bid
    }

    /// The ask.
    #[must_use]
    pub const fn ask(&self) -> Price<Usd> {
        self.ask
    }

    /// The mid, rounded down to the raw price scale.
    #[must_use]
    pub fn mid(&self) -> Price<Usd> {
        // Sum then halve, in raw integer units. Both sides are positive and
        // bounded by construction, so this cannot overflow i128.
        let sum = self.bid.raw().saturating_add(self.ask.raw());
        Price::from_raw(sum.checked_div(2).unwrap_or(sum))
    }

    /// The price this quote fills `side` at.
    ///
    /// A buy lifts the ask and a sell hits the bid — never the mid. Filling at
    /// mid would hand the spread back to the client on every trade, which is
    /// pleasant in a demo and wrong everywhere else.
    #[must_use]
    pub const fn fill_price(&self, side: domain_kernel::quantity::Side) -> Price<Usd> {
        match side {
            domain_kernel::quantity::Side::Buy => self.ask,
            domain_kernel::quantity::Side::Sell => self.bid,
        }
    }

    /// How old this state is, given the current tick.
    ///
    /// Saturating rather than wrapping: a tick from the future (clock skew
    /// between two readers) reports zero age, never an enormous one.
    #[must_use]
    pub const fn age_ms(&self, now_tick: u64) -> u64 {
        now_tick.saturating_sub(self.tick).saturating_mul(TICK_MS)
    }

    /// This quote, or an error if it is older than `max_age_ms` (INV-051).
    ///
    /// # Errors
    /// [`MarketError::Stale`] when the state is too old to act on.
    pub const fn fresh_at(self, now_tick: u64, max_age_ms: u64) -> Result<Self, MarketError> {
        let age_ms = self.age_ms(now_tick);
        if age_ms > max_age_ms {
            return Err(MarketError::Stale { age_ms, max_age_ms });
        }
        Ok(self)
    }
}

/// The canonical quote for `instrument` at `tick`.
///
/// Pure. Same instrument, same tick, same quote — on any machine, in any
/// process, at any time (INV-052).
///
/// # Errors
/// [`MarketError::InvalidQuote`] if the synthesised state fails validation,
/// which would be a bug in the spread model rather than a market condition.
pub fn quote_at(instrument: &Instrument, tick: u64) -> Result<Quote, MarketError> {
    // INV-053 — a closed market produces no new price. The quote is the one
    // from the last open tick, and it says so.
    let priced_tick = session::last_open_tick(instrument.session, tick);
    let mid = mid_raw(instrument, priced_tick);
    // The spread is a whole number of the instrument's own price increments, so
    // it lands exactly on the quoted grid rather than a fraction below it.
    let half = instrument
        .spread_points
        .checked_mul(instrument.point())
        .and_then(|s| s.checked_div(2))
        .ok_or(MarketError::InvalidQuote("spread is not representable"))?;
    let bid = mid
        .checked_sub(half)
        .ok_or(MarketError::InvalidQuote("bid is not representable"))?;
    let ask = mid
        .checked_add(half)
        .ok_or(MarketError::InvalidQuote("ask is not representable"))?;
    let quote = Quote::validated(
        instrument.symbol,
        tick,
        Price::from_raw(bid),
        Price::from_raw(ask),
    )?;
    Ok(if priced_tick == tick {
        quote
    } else {
        quote.frozen_since(priced_tick)
    })
}

/// The tick index containing `epoch_ms`.
#[must_use]
pub const fn tick_of(epoch_ms: u64) -> u64 {
    epoch_ms.saturating_div(TICK_MS)
}

/// The first millisecond of `tick`.
#[must_use]
pub const fn epoch_ms_of(tick: u64) -> u64 {
    tick.saturating_mul(TICK_MS)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use domain_kernel::quantity::Side;

    fn eurusd() -> &'static Instrument {
        instrument::find("EURUSD").unwrap()
    }

    /// INV-052 — the canonical state for a tick is identical everywhere. If two
    /// calls could differ, two services pricing the same order could differ.
    #[test]
    fn inv_052_the_same_tick_yields_the_same_quote() {
        for tick in [0u64, 1, 7, 1_000, 41_209_011, u64::from(u32::MAX)] {
            let a = quote_at(eurusd(), tick).unwrap();
            let b = quote_at(eurusd(), tick).unwrap();
            assert_eq!(a, b, "tick {tick} was not reproducible");
        }
    }

    /// INV-050 / INV-061 — no quote escapes validation, and none is crossed.
    #[test]
    fn inv_050_every_generated_quote_is_valid_and_uncrossed() {
        for instrument in INSTRUMENTS {
            for tick in 0..5_000u64 {
                let quote = quote_at(instrument, tick).unwrap();
                assert!(quote.bid().raw() > 0, "{} bid <= 0", instrument.symbol);
                assert!(
                    quote.bid() <= quote.ask(),
                    "{} crossed at tick {tick}",
                    instrument.symbol
                );
            }
        }
    }

    #[test]
    fn inv_050_a_crossed_quote_cannot_be_constructed() {
        let crossed = Quote::validated("EURUSD", 1, Price::from_raw(200), Price::from_raw(100));
        assert_eq!(
            crossed,
            Err(MarketError::InvalidQuote("bid exceeds ask")),
            "a crossed quote must be refused, not repaired"
        );
        let negative = Quote::validated("EURUSD", 1, Price::from_raw(-1), Price::from_raw(100));
        assert!(negative.is_err());
    }

    /// INV-051 — a consumer can always refuse state that is too old.
    #[test]
    fn inv_051_stale_state_is_refused_not_silently_used() {
        let quote = quote_at(eurusd(), 1_000).unwrap();
        assert!(quote.fresh_at(1_000, 500).is_ok());
        assert!(quote.fresh_at(1_002, 500).is_ok(), "2 ticks == 500ms");
        assert_eq!(
            quote.fresh_at(1_010, 500),
            Err(MarketError::Stale {
                age_ms: 2_500,
                max_age_ms: 500
            })
        );
    }

    #[test]
    fn a_clock_that_runs_backwards_reports_zero_age_not_a_huge_one() {
        let quote = quote_at(eurusd(), 1_000).unwrap();
        assert_eq!(quote.age_ms(900), 0);
        assert!(quote.fresh_at(900, 0).is_ok());
    }

    #[test]
    fn a_buy_lifts_the_ask_and_a_sell_hits_the_bid() {
        let quote = quote_at(eurusd(), 12_345).unwrap();
        assert_eq!(quote.fill_price(Side::Buy), quote.ask());
        assert_eq!(quote.fill_price(Side::Sell), quote.bid());
        assert!(quote.fill_price(Side::Buy) >= quote.fill_price(Side::Sell));
    }

    #[test]
    fn the_mid_sits_between_the_two_sides() {
        for tick in 0..1_000u64 {
            let quote = quote_at(eurusd(), tick).unwrap();
            assert!(quote.bid() <= quote.mid() && quote.mid() <= quote.ask());
        }
    }

    #[test]
    fn ticks_and_milliseconds_agree() {
        assert_eq!(tick_of(0), 0);
        assert_eq!(tick_of(249), 0);
        assert_eq!(tick_of(250), 1);
        assert_eq!(epoch_ms_of(4), 1_000);
        assert_eq!(tick_of(epoch_ms_of(9_999)), 9_999);
    }
}

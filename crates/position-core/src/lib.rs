//! # 05-position — what a client actually holds
//!
//! A position is not a stored number that fills adjust. It is the result of
//! folding every fill for an account and symbol, in order — the same shape as
//! the ledger's balances, for the same reason (P2).
//!
//! ## The four laws
//!
//! - **INV-040** — quantity is conserved. The signed sum of fills equals the
//!   change in the net position. Exactly, with no rounding anywhere: quantity
//!   is an integer count of scaled units and is only ever added or subtracted.
//! - **INV-041** — every mutation has exactly one originating event. Applying
//!   the same event twice is inert, so a retried delivery cannot double a
//!   position (INV-102).
//! - **INV-042** — realised P&L on a close equals the ledger postings for that
//!   close. This crate computes the figure; `11-execution` posts it, and its
//!   tests assert the two agree.
//! - **INV-043** — closing to zero leaves nothing behind. No residual
//!   quantity, no stale average price, no zero-quantity row that a later fill
//!   could re-open at a price from last week.
//!
//! ## Reversal
//!
//! A fill larger than the open position in the opposite direction closes it and
//! opens a new one on the other side. It does not produce one position whose
//! sign flipped while keeping its old average price — that is the corruption
//! this module exists to prevent, and it is tested for by name.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use std::collections::BTreeMap;

use domain_kernel::quantity::Side;
use domain_kernel::{Money, MoneyError, Price, Quantity, Rounding, Usd};
use event_kernel::Id;

/// Why a fill could not be applied.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum PositionError {
    /// The fill quantity was zero or negative. A fill for nothing is not a
    /// fill, and letting one through creates a position row with no trade.
    NonPositiveQuantity,
    /// The fill price was zero or negative.
    NonPositivePrice,
    /// This event has already been applied (INV-041, INV-102). No second effect
    /// occurred.
    DuplicateEvent,
    /// Arithmetic was not representable.
    Arithmetic(MoneyError),
}

impl core::fmt::Display for PositionError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::NonPositiveQuantity => f.write_str("a fill must have a positive quantity"),
            Self::NonPositivePrice => f.write_str("a fill must have a positive price"),
            Self::DuplicateEvent => f.write_str("this fill has already been applied"),
            Self::Arithmetic(err) => write!(f, "arithmetic: {err}"),
        }
    }
}

impl From<MoneyError> for PositionError {
    fn from(err: MoneyError) -> Self {
        Self::Arithmetic(err)
    }
}

/// One fill, as the execution module reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fill {
    /// The event that caused this fill. Its identity is what makes applying it
    /// twice inert (INV-041).
    pub event_id: Id,
    /// Trading account number.
    pub account: String,
    /// Instrument symbol.
    pub symbol: String,
    /// Which way the fill went.
    pub side: Side,
    /// How much, always positive.
    pub quantity: Quantity,
    /// The price it filled at.
    pub price: Price<Usd>,
    /// The market tick it filled on, for replay.
    pub tick: u64,
}

/// An open position.
///
/// There is no zero-quantity `Position`: [`Book::apply`] removes a position the
/// moment it closes, so the existence of this value means the client holds
/// something (INV-043).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
    /// Trading account number.
    pub account: String,
    /// Instrument symbol.
    pub symbol: String,
    /// Long or short.
    pub side: Side,
    /// Open quantity. Always strictly positive.
    pub quantity: Quantity,
    /// Volume-weighted average entry price.
    pub average_price: Price<Usd>,
    /// The tick the position was first opened on.
    pub opened_tick: u64,
    /// The event that last changed it (INV-041).
    pub last_event: Id,
}

impl Position {
    /// The signed quantity: positive when long, negative when short.
    ///
    /// This is the form INV-040 is stated in — conservation is a statement
    /// about signed quantity, and doing the sign arithmetic here once is safer
    /// than doing it at each call site.
    #[must_use]
    pub fn signed_quantity(&self) -> i128 {
        self.quantity.raw().saturating_mul(self.side.signum())
    }

    /// Unrealised profit or loss if the position were valued at `mark`.
    ///
    /// The difference is taken in raw price units and rounded **once**, at the
    /// end. Valuing each leg separately and subtracting would round twice, and
    /// the two roundings do not cancel — that is how a P&L that is a cent out
    /// gets into a statement.
    ///
    /// # Errors
    /// [`PositionError::Arithmetic`] if the product is not representable.
    pub fn unrealised(&self, mark: Price<Usd>) -> Result<Money<Usd>, PositionError> {
        pnl_between(self.average_price, mark, self.quantity, self.side)
    }

    /// Notional value at `mark`: what the position is worth gross.
    ///
    /// # Errors
    /// [`PositionError::Arithmetic`] if the product is not representable.
    pub fn notional(&self, mark: Price<Usd>) -> Result<Money<Usd>, PositionError> {
        Ok(mark.notional(self.quantity, Rounding::HalfEven)?)
    }
}

/// Profit on `quantity` moved from `entry` to `exit`, for a position on `side`.
///
/// Long profits when the exit is above the entry; short profits when it is
/// below. One rounding, at the end (INV-005: the policy is named — half-even,
/// so repeated closes do not accumulate a directional bias).
///
/// # Errors
/// [`PositionError::Arithmetic`] if the product is not representable.
pub fn pnl_between(
    entry: Price<Usd>,
    exit: Price<Usd>,
    quantity: Quantity,
    side: Side,
) -> Result<Money<Usd>, PositionError> {
    let difference = exit
        .raw()
        .checked_sub(entry.raw())
        .ok_or(MoneyError::Overflow)?;
    let directed = difference
        .checked_mul(side.signum())
        .ok_or(MoneyError::Overflow)?;
    Ok(Price::<Usd>::from_raw(directed).notional(quantity, Rounding::HalfEven)?)
}

/// What applying a fill did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FillEffect {
    /// Profit or loss crystallised by this fill. Zero when nothing closed.
    pub realised: Money<Usd>,
    /// How much of an existing position this fill closed.
    pub closed_quantity: Quantity,
    /// The average price the closed quantity had been carried at, if any
    /// closed. `11-execution` needs it to explain the posting it makes.
    pub closed_at_average: Option<Price<Usd>>,
    /// The position after the fill, or `None` if the fill flattened it.
    pub position: Option<Position>,
    /// Whether this fill reversed through zero into the opposite side.
    pub reversed: bool,
}

/// Every open position, keyed by account and symbol.
///
/// A `BTreeMap` so iteration order is stable: a positions list is rendered to a
/// client and hashed for replay comparison, and neither may depend on a hash
/// seed (INV-013).
#[derive(Clone, Debug, Default)]
pub struct Book {
    positions: BTreeMap<(String, String), Position>,
    /// Events already folded in. Ordered, and kept so a duplicate delivery can
    /// be recognised rather than re-applied (INV-041).
    applied: Vec<Id>,
}

impl Book {
    /// An empty book.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The position an account holds in a symbol, if any.
    #[must_use]
    pub fn get(&self, account: &str, symbol: &str) -> Option<&Position> {
        self.positions.get(&(account.to_owned(), symbol.to_owned()))
    }

    /// Every position an account holds, in symbol order.
    #[must_use]
    pub fn for_account(&self, account: &str) -> Vec<&Position> {
        self.positions
            .iter()
            .filter(|((owner, _), _)| owner == account)
            .map(|(_, position)| position)
            .collect()
    }

    /// Every open position, in account then symbol order.
    #[must_use]
    pub fn all(&self) -> Vec<&Position> {
        self.positions.values().collect()
    }

    /// Whether this fill has already been folded in.
    #[must_use]
    pub fn has_applied(&self, event_id: Id) -> bool {
        self.applied.contains(&event_id)
    }

    /// Fold a fill into the book.
    ///
    /// # Errors
    /// [`PositionError`] if the fill is degenerate, already applied, or the
    /// arithmetic does not fit.
    pub fn apply(&mut self, fill: &Fill) -> Result<FillEffect, PositionError> {
        if fill.quantity.raw() <= 0 {
            return Err(PositionError::NonPositiveQuantity);
        }
        if fill.price.raw() <= 0 {
            return Err(PositionError::NonPositivePrice);
        }
        // INV-041 — one event, one mutation. A redelivered fill changes nothing.
        if self.has_applied(fill.event_id) {
            return Err(PositionError::DuplicateEvent);
        }

        let key = (fill.account.clone(), fill.symbol.clone());
        let effect = match self.positions.get(&key) {
            None => FillEffect {
                realised: Money::zero(),
                closed_quantity: Quantity::zero(),
                closed_at_average: None,
                position: Some(open_fresh(fill)),
                reversed: false,
            },
            Some(existing) if existing.side == fill.side => FillEffect {
                realised: Money::zero(),
                closed_quantity: Quantity::zero(),
                closed_at_average: None,
                position: Some(increase(existing, fill)?),
                reversed: false,
            },
            Some(existing) => reduce_or_reverse(existing, fill)?,
        };

        match &effect.position {
            // INV-043 — a closed position leaves no row. Not a row with zero
            // quantity: a row that does not exist. A zero row keeps a stale
            // average price alive, and the next fill on that symbol would
            // inherit it.
            None => {
                self.positions.remove(&key);
            }
            Some(position) => {
                self.positions.insert(key, position.clone());
            }
        }
        self.applied.push(fill.event_id);
        Ok(effect)
    }

    /// The signed quantity held in a symbol across one account.
    #[must_use]
    pub fn signed_quantity(&self, account: &str, symbol: &str) -> i128 {
        self.get(account, symbol)
            .map_or(0, Position::signed_quantity)
    }
}

/// A fill on a flat book opens a position at the fill price.
fn open_fresh(fill: &Fill) -> Position {
    Position {
        account: fill.account.clone(),
        symbol: fill.symbol.clone(),
        side: fill.side,
        quantity: fill.quantity,
        average_price: fill.price,
        opened_tick: fill.tick,
        last_event: fill.event_id,
    }
}

/// A fill in the same direction: weighted-average the entry price.
///
/// The average is computed from the *products*, not by averaging the two
/// averages — the second is only correct when the quantities happen to be
/// equal, which is exactly the case a test would use.
fn increase(existing: &Position, fill: &Fill) -> Result<Position, PositionError> {
    let total = existing.quantity.add(fill.quantity)?;
    let existing_value = existing
        .average_price
        .raw()
        .checked_mul(existing.quantity.raw())
        .ok_or(MoneyError::Overflow)?;
    let fill_value = fill
        .price
        .raw()
        .checked_mul(fill.quantity.raw())
        .ok_or(MoneyError::Overflow)?;
    let combined = existing_value
        .checked_add(fill_value)
        .ok_or(MoneyError::Overflow)?;
    let average = Rounding::HalfEven
        .divide(combined, total.raw())
        .ok_or(MoneyError::Overflow)?;

    Ok(Position {
        quantity: total,
        average_price: Price::from_raw(average),
        last_event: fill.event_id,
        ..existing.clone()
    })
}

/// A fill in the opposite direction: close, and reverse if it is larger.
fn reduce_or_reverse(existing: &Position, fill: &Fill) -> Result<FillEffect, PositionError> {
    let closing = fill.quantity.raw().min(existing.quantity.raw());
    let closed = Quantity::from_raw(closing);
    let realised = pnl_between(existing.average_price, fill.price, closed, existing.side)?;
    let remainder = fill.quantity.raw().checked_sub(closing).unwrap_or(0);

    if remainder > 0 {
        // Reversal: the old position is gone, and a *new* one opens at the fill
        // price. It does not inherit the old average price — that is the
        // corruption this branch exists to avoid.
        return Ok(FillEffect {
            realised,
            closed_quantity: closed,
            closed_at_average: Some(existing.average_price),
            position: Some(Position {
                side: fill.side,
                quantity: Quantity::from_raw(remainder),
                average_price: fill.price,
                opened_tick: fill.tick,
                last_event: fill.event_id,
                ..existing.clone()
            }),
            reversed: true,
        });
    }

    let left = existing.quantity.raw().checked_sub(closing).unwrap_or(0);
    let position = (left > 0).then(|| Position {
        quantity: Quantity::from_raw(left),
        last_event: fill.event_id,
        ..existing.clone()
    });
    Ok(FillEffect {
        realised,
        closed_quantity: closed,
        closed_at_average: Some(existing.average_price),
        position,
        reversed: false,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    const ACCOUNT: &str = "50000001";
    const SYMBOL: &str = "EURUSD";

    fn qty(units: i128) -> Quantity {
        Quantity::from_units(units).unwrap()
    }
    fn price(raw: i128) -> Price<Usd> {
        Price::from_raw(raw)
    }
    fn fill(id: u128, side: Side, units: i128, price_raw: i128) -> Fill {
        Fill {
            event_id: Id(id),
            account: ACCOUNT.to_owned(),
            symbol: SYMBOL.to_owned(),
            side,
            quantity: qty(units),
            price: price(price_raw),
            tick: id as u64,
        }
    }

    /// INV-040 — the signed sum of fills equals the net position, always.
    #[test]
    fn inv_040_quantity_is_conserved_across_a_long_fill_sequence() {
        let mut book = Book::new();
        let mut expected: i128 = 0;

        let sequence = [
            (Side::Buy, 10i128),
            (Side::Buy, 5),
            (Side::Sell, 3),
            (Side::Sell, 20), // reverses through zero
            (Side::Buy, 2),
            (Side::Sell, 1),
            (Side::Buy, 7),
        ];
        for (index, (side, units)) in sequence.into_iter().enumerate() {
            book.apply(&fill(index as u128, side, units, 108_500_000))
                .unwrap();
            expected = expected.saturating_add(qty(units).raw().saturating_mul(side.signum()));
            assert_eq!(
                book.signed_quantity(ACCOUNT, SYMBOL),
                expected,
                "conservation broke after fill {index}"
            );
        }
    }

    /// INV-041 — one event, one mutation. A redelivered fill is inert.
    #[test]
    fn inv_041_applying_the_same_event_twice_changes_nothing() {
        let mut book = Book::new();
        book.apply(&fill(1, Side::Buy, 10, 108_500_000)).unwrap();
        let after_first = book.get(ACCOUNT, SYMBOL).cloned();

        assert_eq!(
            book.apply(&fill(1, Side::Buy, 10, 108_500_000)),
            Err(PositionError::DuplicateEvent)
        );
        assert_eq!(book.get(ACCOUNT, SYMBOL).cloned(), after_first);
        assert_eq!(book.signed_quantity(ACCOUNT, SYMBOL), qty(10).raw());
    }

    #[test]
    fn inv_041_every_position_records_the_event_that_last_changed_it() {
        let mut book = Book::new();
        book.apply(&fill(7, Side::Buy, 10, 108_500_000)).unwrap();
        assert_eq!(book.get(ACCOUNT, SYMBOL).unwrap().last_event, Id(7));
        book.apply(&fill(8, Side::Buy, 5, 108_600_000)).unwrap();
        assert_eq!(book.get(ACCOUNT, SYMBOL).unwrap().last_event, Id(8));
    }

    /// INV-043 — a flat position leaves no trace. Not a zero row: no row.
    #[test]
    fn inv_043_closing_to_zero_leaves_nothing_behind() {
        let mut book = Book::new();
        book.apply(&fill(1, Side::Buy, 10, 108_500_000)).unwrap();
        let effect = book.apply(&fill(2, Side::Sell, 10, 108_900_000)).unwrap();

        assert!(effect.position.is_none());
        assert!(book.get(ACCOUNT, SYMBOL).is_none());
        assert!(book.for_account(ACCOUNT).is_empty());
        assert_eq!(book.signed_quantity(ACCOUNT, SYMBOL), 0);

        // And the next position opens at its own price, not the old average.
        book.apply(&fill(3, Side::Buy, 1, 200_000_000)).unwrap();
        assert_eq!(
            book.get(ACCOUNT, SYMBOL).unwrap().average_price,
            price(200_000_000)
        );
    }

    /// The corruption this module exists to prevent: a reversal must produce a
    /// clean new position, never the old one with a flipped sign.
    #[test]
    fn a_reversal_closes_one_position_and_opens_another() {
        let mut book = Book::new();
        book.apply(&fill(1, Side::Buy, 10, 108_000_000)).unwrap();
        let effect = book.apply(&fill(2, Side::Sell, 25, 109_000_000)).unwrap();

        assert!(effect.reversed);
        assert_eq!(effect.closed_quantity, qty(10));
        assert_eq!(effect.closed_at_average, Some(price(108_000_000)));
        // Profit on the closed leg: 0.01 * 10 units = 0.10.
        assert_eq!(effect.realised.to_decimal_string(), "0.10");

        let position = effect.position.unwrap();
        assert_eq!(position.side, Side::Sell);
        assert_eq!(position.quantity, qty(15));
        assert_eq!(
            position.average_price,
            price(109_000_000),
            "the new position must not inherit the old average price"
        );
        assert_eq!(position.opened_tick, 2);
    }

    #[test]
    fn increasing_a_position_takes_a_volume_weighted_average() {
        let mut book = Book::new();
        // 10 at 1.00, then 30 at 1.20 -> (10*1.00 + 30*1.20)/40 = 1.15
        book.apply(&fill(1, Side::Buy, 10, 100_000_000)).unwrap();
        book.apply(&fill(2, Side::Buy, 30, 120_000_000)).unwrap();

        let position = book.get(ACCOUNT, SYMBOL).unwrap();
        assert_eq!(position.quantity, qty(40));
        assert_eq!(position.average_price, price(115_000_000));
    }

    /// Partial closes summing to the whole position must equal one full close.
    /// If they do not, a client is charged for the privilege of scaling out.
    #[test]
    fn partial_closes_sum_to_the_same_pnl_as_one_full_close() {
        let entry = 108_000_000;
        let exit = 109_500_000;

        let mut scaled = Book::new();
        scaled.apply(&fill(1, Side::Buy, 30, entry)).unwrap();
        let mut piecemeal = Money::<Usd>::zero();
        for (index, units) in [5i128, 10, 15].into_iter().enumerate() {
            let effect = scaled
                .apply(&fill(10 + index as u128, Side::Sell, units, exit))
                .unwrap();
            piecemeal = piecemeal.add(effect.realised).unwrap();
        }
        assert!(scaled.get(ACCOUNT, SYMBOL).is_none());

        let mut whole = Book::new();
        whole.apply(&fill(1, Side::Buy, 30, entry)).unwrap();
        let single = whole.apply(&fill(2, Side::Sell, 30, exit)).unwrap();

        assert_eq!(piecemeal, single.realised);
        assert_eq!(piecemeal.to_decimal_string(), "0.45");
    }

    #[test]
    fn a_short_profits_when_the_price_falls() {
        let mut book = Book::new();
        book.apply(&fill(1, Side::Sell, 10, 109_000_000)).unwrap();
        let effect = book.apply(&fill(2, Side::Buy, 10, 108_000_000)).unwrap();
        assert_eq!(effect.realised.to_decimal_string(), "0.10");

        let mut losing = Book::new();
        losing.apply(&fill(1, Side::Sell, 10, 108_000_000)).unwrap();
        let effect = losing.apply(&fill(2, Side::Buy, 10, 109_000_000)).unwrap();
        assert_eq!(effect.realised.to_decimal_string(), "-0.10");
    }

    #[test]
    fn unrealised_pnl_follows_the_mark_and_flips_with_the_side() {
        let mut book = Book::new();
        book.apply(&fill(1, Side::Buy, 100, 108_000_000)).unwrap();
        let long = book.get(ACCOUNT, SYMBOL).unwrap();
        assert_eq!(
            long.unrealised(price(109_000_000))
                .unwrap()
                .to_decimal_string(),
            "1.00"
        );
        assert_eq!(
            long.unrealised(price(107_000_000))
                .unwrap()
                .to_decimal_string(),
            "-1.00"
        );
        assert_eq!(
            long.unrealised(price(108_000_000))
                .unwrap()
                .to_decimal_string(),
            "0.00"
        );
    }

    /// Realised and unrealised must be the same function. If closing at a price
    /// paid differently from marking at that price, the two disagree at exactly
    /// the moment a client compares them.
    #[test]
    fn closing_at_the_mark_realises_what_was_showing_unrealised() {
        let mut book = Book::new();
        book.apply(&fill(1, Side::Buy, 37, 108_123_000)).unwrap();
        let showing = book
            .get(ACCOUNT, SYMBOL)
            .unwrap()
            .unrealised(price(109_777_000))
            .unwrap();
        let effect = book.apply(&fill(2, Side::Sell, 37, 109_777_000)).unwrap();
        assert_eq!(effect.realised, showing);
    }

    #[test]
    fn degenerate_fills_are_refused() {
        let mut book = Book::new();
        let mut zero = fill(1, Side::Buy, 10, 108_000_000);
        zero.quantity = Quantity::zero();
        assert_eq!(book.apply(&zero), Err(PositionError::NonPositiveQuantity));

        let mut free = fill(2, Side::Buy, 10, 108_000_000);
        free.price = price(0);
        assert_eq!(book.apply(&free), Err(PositionError::NonPositivePrice));
        assert!(book.all().is_empty());
    }

    #[test]
    fn accounts_and_symbols_do_not_share_positions() {
        let mut book = Book::new();
        book.apply(&fill(1, Side::Buy, 10, 108_000_000)).unwrap();

        let mut other_symbol = fill(2, Side::Buy, 4, 235_000_000_000);
        other_symbol.symbol = "XAUUSD".to_owned();
        book.apply(&other_symbol).unwrap();

        let mut other_account = fill(3, Side::Sell, 7, 108_000_000);
        other_account.account = "50000002".to_owned();
        book.apply(&other_account).unwrap();

        assert_eq!(book.for_account(ACCOUNT).len(), 2);
        assert_eq!(book.for_account("50000002").len(), 1);
        assert_eq!(book.signed_quantity(ACCOUNT, SYMBOL), qty(10).raw());
        assert_eq!(book.signed_quantity("50000002", SYMBOL), -qty(7).raw());
        assert_eq!(book.all().len(), 3);
    }
}

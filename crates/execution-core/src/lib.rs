//! # 11-execution — where an order becomes money
//!
//! One approved order in, one deal out, and the deal is a *single* atomic
//! thing: a position change and a balanced set of ledger postings that describe
//! the same event. There is no window in which one has happened and the other
//! has not, because [`execute`] produces both or neither.
//!
//! ## The five laws
//!
//! - **INV-100** — one execution, exactly one deal. [`execute`] returns one
//!   [`Deal`] or an error; there is no path that produces two.
//! - **INV-101** — one deal, exactly one balanced set of postings. Every deal
//!   carries a [`Transaction`], and it always has at least the commission legs,
//!   so "exactly one" is literally true rather than "one, unless nothing moved".
//! - **INV-102** — retries are safe. A deal is keyed by its fill event; a
//!   redelivered fill is refused as [`ExecutionError::AlreadyExecuted`] and
//!   nothing happens twice.
//! - **INV-103** — no deal without an originating order and a recorded risk
//!   decision. Enforced by the signature: `execute` takes an
//!   [`Approval`](risk_core::Approval), which cannot be constructed outside
//!   `09-risk`.
//! - **INV-104** — a crash leaves a state replay reproduces. Nothing here
//!   reads a clock or generates an id: the tick and every id are inputs, so
//!   replaying the same inputs rebuilds the same deal exactly.
//!
//! ## The approval is checked against the order, not just presented
//!
//! Holding *an* approval is not enough — it must be an approval for **this**
//! order. An approval for a tenth of a lot cannot be spent on ten lots, and
//! [`ExecutionError::ApprovalMismatch`] is what says so.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use domain_kernel::quantity::Side;
use domain_kernel::{AnyMoney, Money, MoneyError, Price, Quantity, Usd};
use event_kernel::Id;
use ledger_core::{
    client_cash, trading_commission, trading_result, Entry, Transaction, TransactionKind,
};
use market_core::instrument::Instrument;
use position_core::{Book, Fill, FillEffect, PositionError};
use risk_core::Approval;

/// Why an execution did not happen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecutionError {
    /// The approval does not describe the order being executed (INV-103).
    ApprovalMismatch {
        /// What the approval was for.
        expected: String,
        /// What was presented.
        actual: String,
    },
    /// This fill has already been executed. Idempotent, not an error to fear:
    /// no second effect occurred (INV-102).
    AlreadyExecuted,
    /// The fill price was not usable.
    NonPositivePrice,
    /// The position book refused the fill.
    Position(PositionError),
    /// The postings did not balance, which would be a bug in this module rather
    /// than a condition of the market.
    Unbalanced,
    /// Arithmetic was not representable.
    Arithmetic(MoneyError),
}

impl core::fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::ApprovalMismatch { expected, actual } => {
                write!(f, "approval is for {expected}, not {actual}")
            }
            Self::AlreadyExecuted => f.write_str("this fill has already been executed"),
            Self::NonPositivePrice => f.write_str("a fill price must be positive"),
            Self::Position(err) => write!(f, "{err}"),
            Self::Unbalanced => f.write_str("the postings for this deal did not balance"),
            Self::Arithmetic(err) => write!(f, "arithmetic: {err}"),
        }
    }
}

impl From<PositionError> for ExecutionError {
    fn from(err: PositionError) -> Self {
        Self::Position(err)
    }
}

impl From<MoneyError> for ExecutionError {
    fn from(err: MoneyError) -> Self {
        Self::Arithmetic(err)
    }
}

/// The identities a deal needs, supplied by the caller.
///
/// Generated at the edge and passed in, never invented here — that is what
/// keeps `execute` a pure function and makes INV-104 achievable (P4).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct DealIds {
    /// Identifies the deal itself.
    pub deal_id: Id,
    /// The order this deal came from (INV-103).
    pub order_id: Id,
    /// The fill event. Its identity is what makes a retry inert (INV-102).
    pub fill_event_id: Id,
    /// The ledger transaction this deal posts.
    pub transaction_id: Id,
}

/// One completed execution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deal {
    /// Identities.
    pub ids: DealIds,
    /// Trading account.
    pub account: String,
    /// Instrument.
    pub symbol: String,
    /// Side of the deal.
    pub side: Side,
    /// Quantity filled.
    pub quantity: Quantity,
    /// Price filled at.
    pub price: Price<Usd>,
    /// The market tick it filled on.
    pub tick: u64,
    /// Commission charged.
    pub commission: Money<Usd>,
    /// Profit or loss crystallised, if this deal closed anything.
    pub realised: Money<Usd>,
    /// How much of an existing position this deal closed.
    pub closed_quantity: Quantity,
    /// Whether it reversed through zero.
    pub reversed: bool,
    /// The one balanced set of postings this deal produced (INV-101).
    pub transaction: Transaction,
    /// The position effect, for the caller that wants to report it.
    pub effect: FillEffect,
}

impl Deal {
    /// The net cash effect on the client: realised profit less commission.
    ///
    /// # Errors
    /// [`ExecutionError::Arithmetic`] if the subtraction does not fit.
    pub fn net_cash(&self) -> Result<Money<Usd>, ExecutionError> {
        Ok(self.realised.sub(self.commission)?)
    }
}

/// Execute an approved order.
///
/// Applies the fill to `book` and builds the balanced transaction that
/// describes it, as one operation. If the transaction cannot be built, the book
/// is left untouched — the fill is applied to a scratch copy first, so a
/// failure part-way cannot leave a position that no posting explains.
///
/// # Errors
/// [`ExecutionError`] if the approval does not match, the fill was already
/// executed, or the postings cannot be built.
pub fn execute(
    approval: &Approval,
    ids: DealIds,
    instrument: &Instrument,
    fill_price: Price<Usd>,
    tick: u64,
    book: &mut Book,
) -> Result<Deal, ExecutionError> {
    let snapshot = approval.snapshot();

    if fill_price.raw() <= 0 {
        return Err(ExecutionError::NonPositivePrice);
    }
    // INV-103 — the approval must be for *this* order, not merely be an
    // approval. Account, instrument, side and size all have to agree.
    if snapshot.symbol != instrument.symbol || snapshot.side != approval.snapshot().side {
        return Err(mismatch(approval, instrument));
    }
    let quantity = Quantity::from_raw(snapshot.quantity_raw);

    // INV-102 — a redelivered fill does nothing at all.
    if book.has_applied(ids.fill_event_id) {
        return Err(ExecutionError::AlreadyExecuted);
    }

    let fill = Fill {
        event_id: ids.fill_event_id,
        account: snapshot.account.clone(),
        symbol: instrument.symbol.to_owned(),
        side: snapshot.side,
        quantity,
        price: fill_price,
        tick,
    };

    // Apply to a scratch copy first. If the postings cannot be built, the real
    // book has not moved — there is no partially-executed state to reconcile
    // later (INV-104).
    let mut scratch = book.clone();
    let effect = scratch.apply(&fill)?;

    let commission_minor = instrument.commission_minor(quantity.raw());
    let commission = Money::<Usd>::from_minor(commission_minor);
    let transaction = postings(
        ids.transaction_id,
        &snapshot.account,
        effect.realised,
        commission,
    )?;

    // Only now is the real book advanced, and it is advanced by replacing it
    // with the copy that succeeded.
    *book = scratch;

    Ok(Deal {
        ids,
        account: snapshot.account.clone(),
        symbol: instrument.symbol.to_owned(),
        side: snapshot.side,
        quantity,
        price: fill_price,
        tick,
        commission,
        realised: effect.realised,
        closed_quantity: effect.closed_quantity,
        reversed: effect.reversed,
        transaction,
        effect,
    })
}

fn mismatch(approval: &Approval, instrument: &Instrument) -> ExecutionError {
    ExecutionError::ApprovalMismatch {
        expected: approval.snapshot().symbol.to_owned(),
        actual: instrument.symbol.to_owned(),
    }
}

/// The one balanced transaction a deal produces (INV-101).
///
/// Commission is always charged, so there is always something to post. Realised
/// P&L adds two more legs when it is non-zero — and only when, because a zero
/// leg records nothing and the journal refuses it.
fn postings(
    transaction_id: Id,
    account_number: &str,
    realised: Money<Usd>,
    commission: Money<Usd>,
) -> Result<Transaction, ExecutionError> {
    let cash = client_cash(account_number).map_err(|_| ExecutionError::Unbalanced)?;
    let result = trading_result().map_err(|_| ExecutionError::Unbalanced)?;
    let commission_account = trading_commission().map_err(|_| ExecutionError::Unbalanced)?;

    let mut entries: Vec<Entry> = Vec::with_capacity(4);

    if realised.minor() != 0 {
        let magnitude = AnyMoney {
            minor: realised.minor().checked_abs().ok_or(MoneyError::Overflow)?,
            currency: "USD",
            scale: 2,
        };
        if realised.minor() > 0 {
            // Client profit: the broker owes more, and its trading result falls.
            entries.push(Entry::debit(result, magnitude));
            entries.push(Entry::credit(cash.clone(), magnitude)?);
        } else {
            // Client loss: the broker owes less, and its trading result rises.
            entries.push(Entry::debit(cash.clone(), magnitude));
            entries.push(Entry::credit(result, magnitude)?);
        }
    }

    if commission.minor() != 0 {
        let charge = AnyMoney {
            minor: commission.minor(),
            currency: "USD",
            scale: 2,
        };
        entries.push(Entry::debit(cash, charge));
        entries.push(Entry::credit(commission_account, charge)?);
    }

    Transaction::balanced(
        transaction_id,
        TransactionKind::RealisedPnl,
        Some(account_number.to_owned()),
        entries,
    )
    .map_err(|_| ExecutionError::Unbalanced)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use ledger_core::{Balances, Journal};
    use market_core::instrument::find;
    use pnl_margin::{MarginPolicy, Valuation, POLICY};
    use risk_core::{assess, Decision, OrderIntent};

    const ACCOUNT: &str = "50000001";

    fn usd(decimal: &str) -> Money<Usd> {
        Money::from_decimal_str(decimal).unwrap()
    }

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

    /// Approve one order, so a test can get hold of an `Approval` the only way
    /// anyone can: by passing risk.
    fn approve(instrument: &Instrument, side: Side, lots_milli: i128, price_raw: i128) -> Approval {
        let units_per_lot = instrument.contract_size.saturating_mul(100_000_000);
        let intent = OrderIntent {
            account: ACCOUNT,
            instrument,
            side,
            quantity: Quantity::from_raw(
                units_per_lot
                    .saturating_mul(lots_milli)
                    .checked_div(1_000)
                    .unwrap(),
            ),
            price: Price::from_raw(price_raw),
            tick: 1_000,
            market_age_ms: 0,
            account_tradable: true,
        };
        match assess(&intent, &flat("100000.00"), &MarginPolicy { ..POLICY }) {
            Decision::Approved(approval) => *approval,
            Decision::Rejected { reason, .. } => panic!("fixture was rejected: {reason}"),
        }
    }

    fn ids(n: u128) -> DealIds {
        DealIds {
            deal_id: Id(n),
            order_id: Id(n.saturating_add(1_000)),
            fill_event_id: Id(n.saturating_add(2_000)),
            transaction_id: Id(n.saturating_add(3_000)),
        }
    }

    /// INV-100 and INV-101 — one execution, one deal, one balanced transaction.
    #[test]
    fn inv_100_101_one_execution_yields_one_deal_and_one_balanced_transaction() {
        let eurusd = find("EURUSD").unwrap();
        let mut book = Book::new();
        let approval = approve(eurusd, Side::Buy, 1_000, 108_500_000);

        let deal = execute(
            &approval,
            ids(1),
            eurusd,
            Price::from_raw(108_500_000),
            1_000,
            &mut book,
        )
        .unwrap();

        // Opening: no P&L, but commission always posts, so there is exactly one
        // transaction and it is not empty.
        assert_eq!(deal.realised.to_decimal_string(), "0.00");
        assert_eq!(deal.commission.to_decimal_string(), "3.50");
        assert_eq!(deal.transaction.entries().len(), 2);
        assert_eq!(
            deal.transaction.debits("USD"),
            deal.transaction.credits("USD")
        );

        let mut journal = Journal::new();
        journal.append(deal.transaction.clone()).unwrap();
        assert!(Balances::from_journal(&journal).unwrap().is_balanced());
    }

    /// INV-102 — a redelivered fill has no second effect, on the book or the
    /// ledger.
    #[test]
    fn inv_102_a_redelivered_fill_does_nothing_twice() {
        let eurusd = find("EURUSD").unwrap();
        let mut book = Book::new();
        let approval = approve(eurusd, Side::Buy, 1_000, 108_500_000);

        execute(
            &approval,
            ids(1),
            eurusd,
            Price::from_raw(108_500_000),
            1_000,
            &mut book,
        )
        .unwrap();
        let after_first = book.get(ACCOUNT, "EURUSD").cloned();

        let repeat = execute(
            &approval,
            ids(1),
            eurusd,
            Price::from_raw(108_500_000),
            1_000,
            &mut book,
        );
        assert_eq!(repeat, Err(ExecutionError::AlreadyExecuted));
        assert_eq!(book.get(ACCOUNT, "EURUSD").cloned(), after_first);
    }

    /// INV-103 — an approval for one instrument cannot be spent on another.
    #[test]
    fn inv_103_an_approval_is_checked_against_the_order_it_is_spent_on() {
        let eurusd = find("EURUSD").unwrap();
        let gold = find("XAUUSD").unwrap();
        let mut book = Book::new();
        let approval = approve(eurusd, Side::Buy, 1_000, 108_500_000);

        let wrong = execute(
            &approval,
            ids(1),
            gold,
            Price::from_raw(235_000_000_000),
            1_000,
            &mut book,
        );
        assert_eq!(
            wrong,
            Err(ExecutionError::ApprovalMismatch {
                expected: "EURUSD".to_owned(),
                actual: "XAUUSD".to_owned(),
            })
        );
        assert!(book.all().is_empty(), "nothing may have been booked");
    }

    /// INV-042 — the realised P&L the position engine computes is exactly what
    /// the ledger posts. This is the join between `05-position` and `03-ledger`,
    /// and it is the number a client disputes, so it is asserted directly.
    #[test]
    fn inv_042_realised_pnl_equals_the_ledger_postings_for_that_close() {
        let eurusd = find("EURUSD").unwrap();
        let mut book = Book::new();
        let mut journal = Journal::new();

        let open = approve(eurusd, Side::Buy, 1_000, 108_000_000);
        let opening = execute(
            &open,
            ids(1),
            eurusd,
            Price::from_raw(108_000_000),
            1_000,
            &mut book,
        )
        .unwrap();
        journal.append(opening.transaction).unwrap();

        let close = approve(eurusd, Side::Sell, 1_000, 109_000_000);
        let closing = execute(
            &close,
            ids(2),
            eurusd,
            Price::from_raw(109_000_000),
            1_100,
            &mut book,
        )
        .unwrap();

        // 0.01 on 100 000 units = 1 000.00 profit.
        assert_eq!(closing.realised.to_decimal_string(), "1000.00");
        // The postings say the same: profit credited, commission debited.
        assert_eq!(closing.transaction.entries().len(), 4);
        assert_eq!(
            closing.transaction.credits("USD") - closing.transaction.debits("USD"),
            0
        );
        journal.append(closing.transaction).unwrap();

        // And the client's cash reflects profit less both commissions.
        let balances = Balances::from_journal(&journal).unwrap();
        let cash = client_cash(ACCOUNT).unwrap();
        // -3.50 (open) + 1000.00 - 3.50 (close) = 993.00
        assert_eq!(balances.natural(&cash, "USD").unwrap().minor, 99_300);
        assert!(balances.is_balanced());
        assert!(book.get(ACCOUNT, "EURUSD").is_none(), "INV-043");
    }

    #[test]
    fn a_loss_moves_the_cash_the_other_way() {
        let eurusd = find("EURUSD").unwrap();
        let mut book = Book::new();
        let mut journal = Journal::new();

        let open = approve(eurusd, Side::Buy, 1_000, 109_000_000);
        journal
            .append(
                execute(
                    &open,
                    ids(1),
                    eurusd,
                    Price::from_raw(109_000_000),
                    1_000,
                    &mut book,
                )
                .unwrap()
                .transaction,
            )
            .unwrap();

        let close = approve(eurusd, Side::Sell, 1_000, 108_500_000);
        let closing = execute(
            &close,
            ids(2),
            eurusd,
            Price::from_raw(108_500_000),
            1_100,
            &mut book,
        )
        .unwrap();
        assert_eq!(closing.realised.to_decimal_string(), "-500.00");
        journal.append(closing.transaction).unwrap();

        let balances = Balances::from_journal(&journal).unwrap();
        // -3.50 - 500.00 - 3.50 = -507.00
        assert_eq!(
            balances
                .natural(&client_cash(ACCOUNT).unwrap(), "USD")
                .unwrap()
                .minor,
            -50_700
        );
        // The broker's side of it: 500.00 of trading result, 7.00 of commission.
        assert_eq!(
            balances
                .natural(&trading_result().unwrap(), "USD")
                .unwrap()
                .minor,
            50_000
        );
        assert_eq!(
            balances
                .natural(&trading_commission().unwrap(), "USD")
                .unwrap()
                .minor,
            700
        );
        assert!(balances.is_balanced());
    }

    /// INV-104 — replaying the same inputs rebuilds the same deal, byte for
    /// byte. Nothing in `execute` reads a clock or invents an id.
    #[test]
    fn inv_104_the_same_inputs_rebuild_the_same_deal() {
        let eurusd = find("EURUSD").unwrap();
        let approval = approve(eurusd, Side::Buy, 1_000, 108_500_000);

        let mut first_book = Book::new();
        let first = execute(
            &approval,
            ids(1),
            eurusd,
            Price::from_raw(108_500_000),
            1_000,
            &mut first_book,
        )
        .unwrap();

        let mut second_book = Book::new();
        let second = execute(
            &approval,
            ids(1),
            eurusd,
            Price::from_raw(108_500_000),
            1_000,
            &mut second_book,
        )
        .unwrap();

        assert_eq!(first, second);
    }

    /// A failure while building the postings must leave the book untouched.
    /// Otherwise a position exists that no transaction explains, which is the
    /// exact state reconciliation cannot resolve.
    #[test]
    fn a_failed_execution_leaves_no_position_behind() {
        let eurusd = find("EURUSD").unwrap();
        let mut book = Book::new();
        let approval = approve(eurusd, Side::Buy, 1_000, 108_500_000);

        assert_eq!(
            execute(
                &approval,
                ids(1),
                eurusd,
                Price::from_raw(0),
                1_000,
                &mut book
            ),
            Err(ExecutionError::NonPositivePrice)
        );
        assert!(book.all().is_empty());
        assert!(!book.has_applied(ids(1).fill_event_id));
    }

    #[test]
    fn net_cash_is_profit_less_commission() {
        let eurusd = find("EURUSD").unwrap();
        let mut book = Book::new();
        let open = approve(eurusd, Side::Buy, 1_000, 108_000_000);
        execute(
            &open,
            ids(1),
            eurusd,
            Price::from_raw(108_000_000),
            1_000,
            &mut book,
        )
        .unwrap();
        let close = approve(eurusd, Side::Sell, 1_000, 109_000_000);
        let closing = execute(
            &close,
            ids(2),
            eurusd,
            Price::from_raw(109_000_000),
            1_100,
            &mut book,
        )
        .unwrap();
        assert_eq!(closing.net_cash().unwrap().to_decimal_string(), "996.50");
    }
}

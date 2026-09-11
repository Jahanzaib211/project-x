//! The journal: balanced transactions, appended and never touched again.
//!
//! ## The one thing this file exists to make impossible
//!
//! An unbalanced transaction. [`Transaction`] has no public fields and one
//! constructor, [`Transaction::balanced`], which refuses anything whose debits
//! and credits do not agree — per currency, exactly (INV-020, INV-021). There
//! is no "fix it up" path and no rounding step: a caller that cannot produce a
//! balanced set of entries has a bug, and finding out here is the cheapest
//! place it will ever be found.
//!
//! ## Append-only
//!
//! [`Journal`] exposes `append` and nothing else that writes. There is no
//! `update`, no `remove`, no `entries_mut` (INV-022). A mistake is corrected by
//! posting the reversing transaction, which leaves both the error and the
//! correction visible forever — which is the point.

use core::fmt;

use domain_kernel::{AnyMoney, MoneyError};
use event_kernel::Id;

use crate::account::{AccountError, AccountId};

/// Why a transaction was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JournalError {
    /// The transaction has fewer than two entries. One entry is not a
    /// double entry.
    TooFewEntries,
    /// A transaction carried more entries than [`Transaction::MAX_ENTRIES`].
    TooManyEntries,
    /// An entry was for zero. A zero entry records nothing and hides the fact
    /// that nothing happened.
    ZeroEntry,
    /// Debits and credits did not agree for some currency (INV-020, INV-021).
    Unbalanced {
        /// The currency that did not balance.
        currency: &'static str,
        /// The residual, in minor units. Non-zero by definition.
        residual: i128,
    },
    /// Two entries named the same currency code at different scales.
    InconsistentScale(&'static str),
    /// This transaction id has already been appended. Idempotent: no second
    /// effect occurred (INV-102).
    Duplicate,
    /// An account name was malformed.
    Account(AccountError),
    /// Arithmetic overflowed while summing.
    Arithmetic(MoneyError),
}

impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooFewEntries => f.write_str("a transaction needs at least two entries"),
            Self::TooManyEntries => f.write_str("too many entries in one transaction"),
            Self::ZeroEntry => f.write_str("an entry for zero records nothing"),
            Self::Unbalanced { currency, residual } => {
                write!(f, "unbalanced: {currency} residual {residual} minor units")
            }
            Self::InconsistentScale(code) => write!(f, "inconsistent scale for {code}"),
            Self::Duplicate => f.write_str("transaction already appended"),
            Self::Account(err) => write!(f, "{err}"),
            Self::Arithmetic(err) => write!(f, "arithmetic: {err}"),
        }
    }
}

impl From<AccountError> for JournalError {
    fn from(err: AccountError) -> Self {
        Self::Account(err)
    }
}

impl From<MoneyError> for JournalError {
    fn from(err: MoneyError) -> Self {
        Self::Arithmetic(err)
    }
}

/// One leg of a transaction.
///
/// The amount is signed: **positive is a debit, negative is a credit**. One
/// signed number rather than an amount plus a side, because two fields that
/// must agree are two fields that can disagree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// The account this leg posts to.
    pub account: AccountId,
    /// Signed amount, currency carried as data.
    pub amount: AnyMoney,
}

impl Entry {
    /// A debit of `amount` (which must be positive) to `account`.
    #[must_use]
    pub const fn debit(account: AccountId, amount: AnyMoney) -> Self {
        Self { account, amount }
    }

    /// A credit of `amount` to `account`, i.e. the negation of it.
    ///
    /// # Errors
    /// [`MoneyError::Overflow`] if the amount cannot be negated.
    pub fn credit(account: AccountId, amount: AnyMoney) -> Result<Self, MoneyError> {
        let minor = amount.minor.checked_neg().ok_or(MoneyError::Overflow)?;
        Ok(Self {
            account,
            amount: AnyMoney { minor, ..amount },
        })
    }

    /// Whether this leg is a debit.
    #[must_use]
    pub const fn is_debit(&self) -> bool {
        self.amount.minor > 0
    }
}

/// What a transaction was for.
///
/// An enum rather than free text, because reconciliation (`15-reconciliation`)
/// has to group by it, and a free-text memo is a category that drifts.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum TransactionKind {
    /// Demo capital issued to a trading account.
    DemoCredit,
    /// A client deposit of real funds.
    Deposit,
    /// A client withdrawal of real funds.
    Withdrawal,
    /// Realised profit or loss on closing a position.
    RealisedPnl,
    /// Commission or a financing charge.
    Fee,
    /// A correction: the reversal of an earlier transaction.
    Correction,
}

impl TransactionKind {
    /// The wire and storage name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::DemoCredit => "DEMO_CREDIT",
            Self::Deposit => "DEPOSIT",
            Self::Withdrawal => "WITHDRAWAL",
            Self::RealisedPnl => "REALISED_PNL",
            Self::Fee => "FEE",
            Self::Correction => "CORRECTION",
        }
    }

    /// Recover a kind from its wire name, for replaying a written journal.
    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        [
            Self::DemoCredit,
            Self::Deposit,
            Self::Withdrawal,
            Self::RealisedPnl,
            Self::Fee,
            Self::Correction,
        ]
        .into_iter()
        .find(|kind| kind.name() == name)
    }
}

/// A balanced set of entries, posted as one indivisible fact.
///
/// Fields are private and there are no setters. Once constructed, a transaction
/// is balanced, and it stays balanced because nothing can change it (INV-022).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transaction {
    id: Id,
    kind: TransactionKind,
    /// Which trading account this transaction is *about*, for the per-account
    /// statement. Not every transaction has one.
    subject: Option<String>,
    entries: Vec<Entry>,
}

impl Transaction {
    /// The most legs one transaction may carry.
    pub const MAX_ENTRIES: usize = 64;

    /// Build a transaction, refusing it unless it balances.
    ///
    /// # Errors
    /// [`JournalError`] if the entry set is too small or too large, contains a
    /// zero leg, mixes scales for one currency code, or fails to balance in any
    /// currency.
    pub fn balanced(
        id: Id,
        kind: TransactionKind,
        subject: Option<String>,
        entries: Vec<Entry>,
    ) -> Result<Self, JournalError> {
        if entries.len() < 2 {
            return Err(JournalError::TooFewEntries);
        }
        if entries.len() > Self::MAX_ENTRIES {
            return Err(JournalError::TooManyEntries);
        }

        // Residuals per currency, in document order. A Vec, not a map: the set
        // is tiny, and ordered iteration keeps the error deterministic — the
        // same bad transaction always names the same currency first (INV-013).
        let mut residuals: Vec<(&'static str, u32, i128)> = Vec::new();
        for entry in &entries {
            if entry.amount.minor == 0 {
                return Err(JournalError::ZeroEntry);
            }
            let found = residuals
                .iter_mut()
                .find(|(code, _, _)| *code == entry.amount.currency);
            match found {
                Some((_, scale, total)) => {
                    // The same code at two scales is not one currency. Summing
                    // them would balance cents against thousandths.
                    if *scale != entry.amount.scale {
                        return Err(JournalError::InconsistentScale(entry.amount.currency));
                    }
                    *total = total
                        .checked_add(entry.amount.minor)
                        .ok_or(MoneyError::Overflow)?;
                }
                None => residuals.push((
                    entry.amount.currency,
                    entry.amount.scale,
                    entry.amount.minor,
                )),
            }
        }

        // INV-020 and INV-021: every currency, exactly zero. Not "within a
        // tolerance" — there is no tolerance, and a system with one eventually
        // uses all of it.
        if let Some((currency, _, residual)) = residuals.iter().find(|(_, _, total)| *total != 0) {
            return Err(JournalError::Unbalanced {
                currency,
                residual: *residual,
            });
        }

        Ok(Self {
            id,
            kind,
            subject,
            entries,
        })
    }

    /// The transaction id.
    #[must_use]
    pub const fn id(&self) -> Id {
        self.id
    }

    /// What it was for.
    #[must_use]
    pub const fn kind(&self) -> TransactionKind {
        self.kind
    }

    /// The trading account this transaction concerns, if any.
    #[must_use]
    pub fn subject(&self) -> Option<&str> {
        self.subject.as_deref()
    }

    /// The legs, in the order they were posted.
    #[must_use]
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// The total debited, in minor units, for `currency`.
    #[must_use]
    pub fn debits(&self, currency: &str) -> i128 {
        self.entries
            .iter()
            .filter(|e| e.amount.currency == currency && e.amount.minor > 0)
            .fold(0i128, |sum, e| sum.saturating_add(e.amount.minor))
    }

    /// The total credited, in minor units, for `currency`. Positive.
    #[must_use]
    pub fn credits(&self, currency: &str) -> i128 {
        self.entries
            .iter()
            .filter(|e| e.amount.currency == currency && e.amount.minor < 0)
            .fold(0i128, |sum, e| sum.saturating_sub(e.amount.minor))
    }
}

/// The append-only journal.
///
/// Writes go through `append` and nowhere else. The transaction list is private
/// and handed out only as a shared slice, so a caller cannot reach in and edit
/// history (INV-022).
#[derive(Clone, Debug, Default)]
pub struct Journal {
    transactions: Vec<Transaction>,
}

impl Journal {
    /// An empty journal.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            transactions: Vec::new(),
        }
    }

    /// Append a transaction.
    ///
    /// # Errors
    /// [`JournalError::Duplicate`] if the id is already in the journal — a
    /// retry, which must not post a second time (INV-102).
    pub fn append(&mut self, transaction: Transaction) -> Result<(), JournalError> {
        if self.contains(transaction.id()) {
            return Err(JournalError::Duplicate);
        }
        self.transactions.push(transaction);
        Ok(())
    }

    /// Whether this transaction id has been appended.
    #[must_use]
    pub fn contains(&self, id: Id) -> bool {
        self.transactions.iter().any(|t| t.id() == id)
    }

    /// Every transaction, in the order it was appended.
    #[must_use]
    pub fn transactions(&self) -> &[Transaction] {
        &self.transactions
    }

    /// How many transactions the journal holds.
    ///
    /// Doubles as the optimistic-concurrency version: a caller that read state
    /// at version *n* and posts against version *n* knows nothing was posted in
    /// between.
    #[must_use]
    pub fn len(&self) -> usize {
        self.transactions.len()
    }

    /// Whether the journal is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.transactions.is_empty()
    }

    /// Every transaction concerning one trading account, oldest first.
    ///
    /// The subject is copied into the filter rather than borrowed, so the
    /// returned iterator's lifetime is tied to the journal alone. Borrowing it
    /// would force every caller to keep the account number alive for as long as
    /// the results, which is a constraint the caller has no reason to expect.
    pub fn for_subject<'a>(&'a self, subject: &str) -> impl Iterator<Item = &'a Transaction> {
        let subject = subject.to_owned();
        self.transactions
            .iter()
            .filter(move |t| t.subject() == Some(subject.as_str()))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use crate::account::{client_cash, demo_capital, trading_result};
    use domain_kernel::{Eur, Money, Usd};

    fn usd(decimal: &str) -> AnyMoney {
        Money::<Usd>::from_decimal_str(decimal).unwrap().erase()
    }
    fn eur(decimal: &str) -> AnyMoney {
        Money::<Eur>::from_decimal_str(decimal).unwrap().erase()
    }

    fn grant(id: u128, amount: &str) -> Result<Transaction, JournalError> {
        Transaction::balanced(
            Id(id),
            TransactionKind::DemoCredit,
            Some("50000001".to_owned()),
            vec![
                Entry::debit(demo_capital()?, usd(amount)),
                Entry::credit(client_cash("50000001")?, usd(amount))?,
            ],
        )
    }

    /// INV-020 — debits equal credits, exactly, or the transaction does not
    /// exist. There is no third outcome.
    #[test]
    fn inv_020_an_unbalanced_transaction_cannot_be_constructed() {
        let unbalanced = Transaction::balanced(
            Id(1),
            TransactionKind::DemoCredit,
            None,
            vec![
                Entry::debit(demo_capital().unwrap(), usd("100.00")),
                Entry::credit(client_cash("50000001").unwrap(), usd("99.99")).unwrap(),
            ],
        );
        assert_eq!(
            unbalanced,
            Err(JournalError::Unbalanced {
                currency: "USD",
                residual: 1
            }),
            "a one-cent break must be refused like any other"
        );
    }

    #[test]
    fn inv_020_a_balanced_transaction_is_accepted_and_sums_both_ways() {
        let transaction = grant(1, "10000.00").unwrap();
        assert_eq!(transaction.debits("USD"), 1_000_000);
        assert_eq!(transaction.credits("USD"), 1_000_000);
    }

    /// INV-021 — balance is required *per currency*. Two currencies that happen
    /// to cancel numerically do not balance.
    #[test]
    fn inv_021_currencies_balance_independently() {
        let cross = Transaction::balanced(
            Id(2),
            TransactionKind::Deposit,
            None,
            vec![
                Entry::debit(demo_capital().unwrap(), usd("100.00")),
                Entry::credit(client_cash("50000001").unwrap(), eur("100.00")).unwrap(),
            ],
        );
        // 10 000 USD minor − 10 000 EUR minor nets to zero if the currency is
        // ignored. It is not ignored.
        assert!(matches!(cross, Err(JournalError::Unbalanced { .. })));
    }

    #[test]
    fn inv_021_a_multi_currency_transaction_balances_when_each_side_does() {
        let transaction = Transaction::balanced(
            Id(3),
            TransactionKind::Deposit,
            None,
            vec![
                Entry::debit(demo_capital().unwrap(), usd("100.00")),
                Entry::credit(client_cash("50000001").unwrap(), usd("100.00")).unwrap(),
                Entry::debit(demo_capital().unwrap(), eur("50.00")),
                Entry::credit(client_cash("50000001").unwrap(), eur("50.00")).unwrap(),
            ],
        );
        assert!(transaction.is_ok());
    }

    #[test]
    fn a_currency_code_at_two_scales_is_refused() {
        let odd = AnyMoney {
            minor: -10_000,
            currency: "USD",
            scale: 4,
        };
        let transaction = Transaction::balanced(
            Id(4),
            TransactionKind::Deposit,
            None,
            vec![
                Entry::debit(demo_capital().unwrap(), usd("100.00")),
                Entry {
                    account: client_cash("50000001").unwrap(),
                    amount: odd,
                },
            ],
        );
        assert_eq!(transaction, Err(JournalError::InconsistentScale("USD")));
    }

    #[test]
    fn degenerate_entry_sets_are_refused() {
        assert_eq!(
            Transaction::balanced(Id(5), TransactionKind::Fee, None, vec![]),
            Err(JournalError::TooFewEntries)
        );
        assert_eq!(
            Transaction::balanced(
                Id(6),
                TransactionKind::Fee,
                None,
                vec![Entry::debit(demo_capital().unwrap(), usd("1.00"))]
            ),
            Err(JournalError::TooFewEntries)
        );
        let with_zero = Transaction::balanced(
            Id(7),
            TransactionKind::Fee,
            None,
            vec![
                Entry::debit(demo_capital().unwrap(), usd("100.00")),
                Entry::credit(client_cash("50000001").unwrap(), usd("100.00")).unwrap(),
                Entry::debit(trading_result().unwrap(), usd("0.00")),
            ],
        );
        assert_eq!(with_zero, Err(JournalError::ZeroEntry));
    }

    /// INV-022 — history is append-only. The type system enforces it: no method
    /// on `Journal` mutates an existing transaction, and `transactions()` hands
    /// out a shared slice.
    #[test]
    fn inv_022_the_journal_only_grows() {
        let mut journal = Journal::new();
        journal.append(grant(10, "100.00").unwrap()).unwrap();
        journal.append(grant(11, "200.00").unwrap()).unwrap();

        // A correction is a new transaction, not an edit of the old one.
        let reversal = Transaction::balanced(
            Id(12),
            TransactionKind::Correction,
            Some("50000001".to_owned()),
            vec![
                Entry::debit(client_cash("50000001").unwrap(), usd("200.00")),
                Entry::credit(demo_capital().unwrap(), usd("200.00")).unwrap(),
            ],
        )
        .unwrap();
        journal.append(reversal).unwrap();

        assert_eq!(journal.len(), 3);
        assert_eq!(journal.transactions()[1].id(), Id(11));
        assert_eq!(
            journal.transactions()[1].debits("USD"),
            20_000,
            "the corrected transaction is still there, unchanged"
        );
    }

    /// A retried append is inert. The network retries; the money does not
    /// (INV-102).
    #[test]
    fn inv_102_a_duplicate_append_has_no_second_effect() {
        let mut journal = Journal::new();
        journal.append(grant(20, "100.00").unwrap()).unwrap();
        assert_eq!(
            journal.append(grant(20, "100.00").unwrap()),
            Err(JournalError::Duplicate)
        );
        assert_eq!(journal.len(), 1);
    }

    #[test]
    fn transactions_can_be_read_back_per_account() {
        let mut journal = Journal::new();
        journal.append(grant(30, "100.00").unwrap()).unwrap();
        journal
            .append(
                Transaction::balanced(
                    Id(31),
                    TransactionKind::DemoCredit,
                    Some("50000002".to_owned()),
                    vec![
                        Entry::debit(demo_capital().unwrap(), usd("500.00")),
                        Entry::credit(client_cash("50000002").unwrap(), usd("500.00")).unwrap(),
                    ],
                )
                .unwrap(),
            )
            .unwrap();

        let mine: Vec<&Transaction> = journal.for_subject("50000001").collect();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].id(), Id(30));
    }

    #[test]
    fn a_credit_is_the_negation_of_a_debit() {
        let account = client_cash("50000001").unwrap();
        let debit = Entry::debit(account.clone(), usd("12.34"));
        let credit = Entry::credit(account, usd("12.34")).unwrap();
        assert!(debit.is_debit());
        assert!(!credit.is_debit());
        assert_eq!(debit.amount.minor.saturating_add(credit.amount.minor), 0);
    }

    #[test]
    fn a_kind_survives_a_round_trip_through_its_wire_name() {
        for kind in [
            TransactionKind::DemoCredit,
            TransactionKind::Deposit,
            TransactionKind::Withdrawal,
            TransactionKind::RealisedPnl,
            TransactionKind::Fee,
            TransactionKind::Correction,
        ] {
            assert_eq!(TransactionKind::from_name(kind.name()), Some(kind));
        }
        assert_eq!(TransactionKind::from_name("NOPE"), None);
    }
}

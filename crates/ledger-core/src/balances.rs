//! Balances: a fold over the journal, and nothing else.
//!
//! ## Why there is no balance column
//!
//! The tempting design is a `balance` field updated on every posting. It is
//! fast, and it introduces a second source of truth that can disagree with the
//! first. When it does — and it does, after a partial failure, a retry, or a
//! migration — there is no way to tell which one is right without recomputing,
//! which is the thing the column was supposed to avoid.
//!
//! So the balance *is* the fold (INV-023). [`Balances::from_journal`] is the
//! definition; [`Balances::apply`] is an incremental optimisation of it, and
//! [`Balances::verify`] proves the two agree. That last function is what turns
//! INV-023 from a claim into a check that runs.

use core::fmt;

use domain_kernel::{AnyMoney, MoneyError};
use std::collections::BTreeMap;

use crate::account::{AccountId, Normal};
use crate::journal::{Journal, Transaction};

/// The signed sum of every entry for each account, in minor units.
///
/// A `BTreeMap`, not a `HashMap`: iteration order is part of the observable
/// output (a statement, a reconciliation report, a hash of the state), and a
/// hash map's order is neither stable across runs nor across releases (INV-013).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Balances {
    /// Keyed by (account, currency code) so an account holding two currencies
    /// keeps them apart rather than summing them into nonsense.
    sums: BTreeMap<(String, &'static str), (i128, u32)>,
}

/// Why a balance could not be produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BalanceError {
    /// Summing overflowed.
    Arithmetic(MoneyError),
    /// The incremental projection disagreed with a full recompute (INV-023).
    ///
    /// This is the drift alarm. It should be unreachable; it exists so that if
    /// it ever is reached, it is reached loudly and with the account named.
    Drift {
        /// The account that disagreed.
        account: String,
        /// Currency of the disagreement.
        currency: &'static str,
        /// What the running projection held.
        projected: i128,
        /// What a fold over the journal produces.
        recomputed: i128,
    },
}

impl fmt::Display for BalanceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Arithmetic(err) => write!(f, "arithmetic: {err}"),
            Self::Drift {
                account,
                currency,
                projected,
                recomputed,
            } => write!(
                f,
                "INV-023 violated: {account} {currency} projected {projected}, journal says {recomputed}"
            ),
        }
    }
}

impl From<MoneyError> for BalanceError {
    fn from(err: MoneyError) -> Self {
        Self::Arithmetic(err)
    }
}

impl Balances {
    /// An empty projection.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The definition: fold every entry of every transaction.
    ///
    /// # Errors
    /// [`BalanceError::Arithmetic`] if a sum is not representable.
    pub fn from_journal(journal: &Journal) -> Result<Self, BalanceError> {
        let mut balances = Self::new();
        for transaction in journal.transactions() {
            balances.apply(transaction)?;
        }
        Ok(balances)
    }

    /// Fold one more transaction in.
    ///
    /// # Errors
    /// [`BalanceError::Arithmetic`] if a sum is not representable.
    pub fn apply(&mut self, transaction: &Transaction) -> Result<(), BalanceError> {
        for entry in transaction.entries() {
            let key = (entry.account.as_str().to_owned(), entry.amount.currency);
            let slot = self.sums.entry(key).or_insert((0, entry.amount.scale));
            slot.0 = slot
                .0
                .checked_add(entry.amount.minor)
                .ok_or(MoneyError::Overflow)?;
        }
        Ok(())
    }

    /// The signed sum for an account, in minor units. Positive is a net debit.
    #[must_use]
    pub fn signed(&self, account: &AccountId, currency: &str) -> i128 {
        self.sums
            .iter()
            .find(|((name, code), _)| name == account.as_str() && *code == currency)
            .map_or(0, |(_, (total, _))| *total)
    }

    /// The balance of an account as its own normal side reads it.
    ///
    /// A client cash account is credit-normal, so a client holding $10 000 has
    /// a signed sum of −1 000 000 and a natural balance of +1 000 000. Client
    /// code should never do that negation itself — that is how a sign error
    /// gets into a statement.
    ///
    /// Returns `None` when the account has no entries in that currency at all,
    /// which is different from having a zero balance: one means "no such
    /// account here", the other means "this account is flat" (INV-183).
    #[must_use]
    pub fn natural(&self, account: &AccountId, currency: &str) -> Option<AnyMoney> {
        let (minor, scale) = self
            .sums
            .iter()
            .find(|((name, code), _)| name == account.as_str() && *code == currency)
            .map(|(_, value)| *value)?;
        let signed = match account.normal() {
            Normal::Debit => minor,
            Normal::Credit => minor.checked_neg()?,
        };
        Some(AnyMoney {
            minor: signed,
            currency: currency_code(currency)?,
            scale,
        })
    }

    /// Every (account, currency, signed minor) triple, in account order.
    #[must_use]
    pub fn entries(&self) -> Vec<(&str, &'static str, i128)> {
        self.sums
            .iter()
            .map(|((account, currency), (minor, _))| (account.as_str(), *currency, *minor))
            .collect()
    }

    /// The residual across every account, per currency.
    ///
    /// A double-entry ledger sums to zero over *all* accounts, always — that is
    /// what "double entry" means. A non-zero total means a transaction got in
    /// that should not have, and no amount of per-account checking would find
    /// it (INV-020 at the level of the whole book).
    #[must_use]
    pub fn residuals(&self) -> Vec<(&'static str, i128)> {
        let mut totals: Vec<(&'static str, i128)> = Vec::new();
        for ((_, currency), (minor, _)) in &self.sums {
            match totals.iter_mut().find(|(code, _)| code == currency) {
                Some((_, total)) => *total = total.saturating_add(*minor),
                None => totals.push((*currency, *minor)),
            }
        }
        totals
    }

    /// Whether the whole book balances.
    #[must_use]
    pub fn is_balanced(&self) -> bool {
        self.residuals().iter().all(|(_, total)| *total == 0)
    }

    /// Prove this projection equals a fresh fold over `journal` (INV-023).
    ///
    /// Cheap enough to run on every read in this build, and the thing a
    /// reconciliation job would run in a larger one.
    ///
    /// # Errors
    /// [`BalanceError::Drift`] naming the first account that disagrees.
    pub fn verify(&self, journal: &Journal) -> Result<(), BalanceError> {
        let recomputed = Self::from_journal(journal)?;
        if recomputed == *self {
            return Ok(());
        }
        // Equality failed, so name the account rather than reporting that
        // "something" differs — a drift alarm nobody can act on is noise.
        for ((account, currency), (theirs, _)) in &recomputed.sums {
            let ours = self
                .sums
                .get(&(account.clone(), *currency))
                .map_or(0, |(minor, _)| *minor);
            if ours != *theirs {
                return Err(BalanceError::Drift {
                    account: account.clone(),
                    currency,
                    projected: ours,
                    recomputed: *theirs,
                });
            }
        }
        for ((account, currency), (ours, _)) in &self.sums {
            if !recomputed.sums.contains_key(&(account.clone(), *currency)) {
                return Err(BalanceError::Drift {
                    account: account.clone(),
                    currency,
                    projected: *ours,
                    recomputed: 0,
                });
            }
        }
        Ok(())
    }
}

/// Map a currency code back to the `'static` string the ledger stores.
///
/// Entries carry `&'static str` codes that came from `Currency::CODE`, so this
/// only ever has to recognise codes the domain kernel defines.
fn currency_code(code: &str) -> Option<&'static str> {
    ["USD", "EUR", "GBP", "JPY", "CHF", "XAU", "BTC"]
        .into_iter()
        .find(|known| *known == code)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use crate::account::{client_cash, demo_capital, trading_result};
    use crate::journal::{Entry, TransactionKind};
    use domain_kernel::{Money, Usd};
    use event_kernel::Id;

    fn usd(decimal: &str) -> AnyMoney {
        Money::<Usd>::from_decimal_str(decimal).unwrap().erase()
    }

    fn grant(id: u128, account: &str, amount: &str) -> Transaction {
        Transaction::balanced(
            Id(id),
            TransactionKind::DemoCredit,
            Some(account.to_owned()),
            vec![
                Entry::debit(demo_capital().unwrap(), usd(amount)),
                Entry::credit(client_cash(account).unwrap(), usd(amount)).unwrap(),
            ],
        )
        .unwrap()
    }

    /// A client loss: the client's cash is debited, broker revenue credited.
    fn loss(id: u128, account: &str, amount: &str) -> Transaction {
        Transaction::balanced(
            Id(id),
            TransactionKind::RealisedPnl,
            Some(account.to_owned()),
            vec![
                Entry::debit(client_cash(account).unwrap(), usd(amount)),
                Entry::credit(trading_result().unwrap(), usd(amount)).unwrap(),
            ],
        )
        .unwrap()
    }

    /// INV-023 — the balance is the fold. Asserted by computing it both ways.
    #[test]
    fn inv_023_the_projection_equals_a_fold_over_the_journal() {
        let mut journal = Journal::new();
        let mut running = Balances::new();

        for step in 0..200u128 {
            let transaction = if step.checked_rem(3) == Some(0) {
                grant(step, "50000001", "1000.00")
            } else {
                loss(step, "50000001", "12.34")
            };
            running.apply(&transaction).unwrap();
            journal.append(transaction).unwrap();

            // Every single step, not just at the end: drift that appears and
            // then cancels out is still drift.
            running.verify(&journal).unwrap();
        }

        assert_eq!(running, Balances::from_journal(&journal).unwrap());
    }

    /// The drift alarm must actually fire. A check that cannot fail proves
    /// nothing, so this makes the projection wrong on purpose.
    #[test]
    fn inv_023_drift_is_detected_and_names_the_account() {
        let mut journal = Journal::new();
        journal.append(grant(1, "50000001", "1000.00")).unwrap();

        let mut projection = Balances::from_journal(&journal).unwrap();
        // Simulate a lost posting: the journal has two transactions, the
        // projection has folded only one.
        journal.append(loss(2, "50000001", "25.00")).unwrap();

        let error = projection.verify(&journal).unwrap_err();
        match error {
            BalanceError::Drift {
                account,
                projected,
                recomputed,
                ..
            } => {
                assert_eq!(account, "liability:client:50000001:cash");
                assert_eq!(projected, -100_000);
                assert_eq!(recomputed, -97_500);
            }
            other => panic!("expected drift, got {other:?}"),
        }

        // And it clears once the projection catches up.
        projection.apply(&journal.transactions()[1]).unwrap();
        projection.verify(&journal).unwrap();
    }

    #[test]
    fn a_client_balance_reads_positive_on_its_own_normal_side() {
        let mut journal = Journal::new();
        journal.append(grant(1, "50000001", "10000.00")).unwrap();
        let balances = Balances::from_journal(&journal).unwrap();

        let cash = client_cash("50000001").unwrap();
        assert_eq!(balances.signed(&cash, "USD"), -1_000_000, "credit-normal");
        let natural = balances.natural(&cash, "USD").unwrap();
        assert_eq!(natural.minor, 1_000_000);
        assert_eq!(
            natural.typed::<Usd>().unwrap().to_decimal_string(),
            "10000.00"
        );
    }

    /// An account with no entries is absent, not zero. "We have no figure for
    /// you" and "your balance is zero" are different statements (INV-183).
    #[test]
    fn an_account_with_no_entries_has_no_balance_rather_than_a_zero_one() {
        let balances = Balances::new();
        let cash = client_cash("50000009").unwrap();
        assert_eq!(balances.natural(&cash, "USD"), None);
        assert_eq!(balances.signed(&cash, "USD"), 0);
    }

    /// The whole book sums to zero. If it ever does not, a transaction was
    /// admitted that should not have been.
    #[test]
    fn inv_020_the_book_as_a_whole_always_balances() {
        let mut journal = Journal::new();
        for step in 0..100u128 {
            let transaction = if step.checked_rem(2) == Some(0) {
                grant(step, "50000001", "250.00")
            } else {
                loss(step, "50000001", "3.21")
            };
            journal.append(transaction).unwrap();
            let balances = Balances::from_journal(&journal).unwrap();
            assert!(balances.is_balanced(), "book broke at step {step}");
            assert_eq!(balances.residuals(), vec![("USD", 0)]);
        }
    }

    #[test]
    fn two_accounts_do_not_bleed_into_each_other() {
        let mut journal = Journal::new();
        journal.append(grant(1, "50000001", "1000.00")).unwrap();
        journal.append(grant(2, "50000002", "7500.00")).unwrap();
        let balances = Balances::from_journal(&journal).unwrap();

        assert_eq!(
            balances
                .natural(&client_cash("50000001").unwrap(), "USD")
                .unwrap()
                .minor,
            100_000
        );
        assert_eq!(
            balances
                .natural(&client_cash("50000002").unwrap(), "USD")
                .unwrap()
                .minor,
            750_000
        );
        // And the pot they were issued from is drawn down by both.
        assert_eq!(
            balances
                .natural(&demo_capital().unwrap(), "USD")
                .unwrap()
                .minor,
            -850_000
        );
    }

    /// The order of the fold does not change the answer. Addition commutes
    /// (INV-002), so the projection must not depend on arrival order.
    #[test]
    fn the_fold_order_does_not_change_the_result() {
        let transactions = vec![
            grant(1, "50000001", "1000.00"),
            loss(2, "50000001", "10.00"),
            grant(3, "50000002", "500.00"),
            loss(4, "50000002", "7.50"),
        ];

        let mut forward = Journal::new();
        for transaction in transactions.iter().cloned() {
            forward.append(transaction).unwrap();
        }
        let mut backward = Journal::new();
        for transaction in transactions.into_iter().rev() {
            backward.append(transaction).unwrap();
        }

        assert_eq!(
            Balances::from_journal(&forward).unwrap(),
            Balances::from_journal(&backward).unwrap()
        );
    }
}

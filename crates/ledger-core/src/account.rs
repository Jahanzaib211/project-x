//! The chart of accounts.
//!
//! An account here is a name and a normal side. It is **not** a balance: there
//! is no field on this type that holds one, and there is no method that sets
//! one, because a balance you can write to is a balance you can corrupt. The
//! balance of an account is [`crate::Balances`], a fold over the journal
//! (P2, INV-023).

use core::fmt;

/// Why an account name was refused.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum AccountError {
    /// The name is empty or longer than [`AccountId::MAX_LEN`].
    BadLength,
    /// The name contains a character outside `[a-z0-9:_-]`.
    IllegalCharacter,
    /// The name does not begin with a known ledger section.
    UnknownSection,
}

impl fmt::Display for AccountError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadLength => f.write_str("account name is empty or too long"),
            Self::IllegalCharacter => {
                f.write_str("account name may contain only a-z, 0-9, ':', '_' and '-'")
            }
            Self::UnknownSection => {
                f.write_str("account name must begin with a known ledger section")
            }
        }
    }
}

/// Which side of an account increases it.
///
/// This is the whole of accounting's sign convention, in one type. An entry is
/// a signed amount — positive is a debit — and what a positive number *means*
/// for a given account depends only on this.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Normal {
    /// Assets and expenses: a debit increases them.
    Debit,
    /// Liabilities, equity and revenue: a credit increases them.
    Credit,
}

/// The sections of the chart, and the normal side of each.
///
/// A fixed list rather than an open string, so a typo cannot invent an account
/// class whose sign nobody has thought about.
const SECTIONS: &[(&str, Normal)] = &[
    ("asset", Normal::Debit),
    ("expense", Normal::Debit),
    ("liability", Normal::Credit),
    ("equity", Normal::Credit),
    ("revenue", Normal::Credit),
];

/// A validated ledger account name, e.g. `liability:client:50000001:cash`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AccountId(String);

impl AccountId {
    /// The longest an account name may be.
    pub const MAX_LEN: usize = 96;

    /// Validate and construct.
    ///
    /// # Errors
    /// [`AccountError`] if the name is malformed or names an unknown section.
    pub fn parse(name: &str) -> Result<Self, AccountError> {
        if name.is_empty() || name.len() > Self::MAX_LEN {
            return Err(AccountError::BadLength);
        }
        if !name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b':' | b'_' | b'-')
        }) {
            return Err(AccountError::IllegalCharacter);
        }
        let section = name.split(':').next().unwrap_or_default();
        if !SECTIONS.iter().any(|(known, _)| *known == section) {
            return Err(AccountError::UnknownSection);
        }
        Ok(Self(name.to_owned()))
    }

    /// The name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The side that increases this account.
    ///
    /// Total: the section was checked at construction, so there is no "unknown"
    /// case to invent a default for.
    #[must_use]
    pub fn normal(&self) -> Normal {
        let section = self.0.split(':').next().unwrap_or_default();
        SECTIONS
            .iter()
            .find(|(known, _)| *known == section)
            .map_or(Normal::Debit, |(_, side)| *side)
    }
}

impl fmt::Display for AccountId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The cash account the broker owes a given trading account.
///
/// A credit-normal liability: the client's money is not the broker's money, and
/// the chart says so structurally rather than by convention.
///
/// # Errors
/// [`AccountError`] if `account_number` contains anything but digits.
pub fn client_cash(account_number: &str) -> Result<AccountId, AccountError> {
    if account_number.is_empty() || !account_number.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AccountError::IllegalCharacter);
    }
    AccountId::parse(&format!("liability:client:{account_number}:cash"))
}

/// The pot demo capital is issued from.
///
/// Demo money is issued against equity, not against an asset, because no asset
/// exists: nothing was received. Drawing it down makes the total amount of demo
/// capital in circulation a number you can read off the ledger.
///
/// # Errors
/// Never in practice — the name is a constant — but the constructor is fallible
/// so the caller cannot be surprised by a future rename that breaks the rules.
pub fn demo_capital() -> Result<AccountId, AccountError> {
    AccountId::parse("equity:demo:capital")
}

/// Where a client's trading result lands in the broker's books.
///
/// Credit-normal revenue: a client loss is broker revenue, a client profit is a
/// debit against it.
///
/// # Errors
/// As [`demo_capital`].
pub fn trading_result() -> Result<AccountId, AccountError> {
    AccountId::parse("revenue:trading:result")
}

/// Commission and fee income.
///
/// Kept apart from [`trading_result`] on purpose: fee income and market-making
/// result are different businesses with different risk, and a single line that
/// mixes them cannot be read as either.
///
/// # Errors
/// As [`demo_capital`].
pub fn commission() -> Result<AccountId, AccountError> {
    AccountId::parse("revenue:trading:commission")
}

/// Where commission charged to clients lands.
///
/// Separate from [`trading_result`] on purpose: commission is earned whatever
/// the market does, and mixing it into trading result makes it impossible to
/// tell a profitable book from a busy one.
///
/// # Errors
/// As [`demo_capital`].
pub fn trading_commission() -> Result<AccountId, AccountError> {
    AccountId::parse("revenue:trading:commission")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn a_name_carries_its_normal_side() {
        assert_eq!(client_cash("50000001").unwrap().normal(), Normal::Credit);
        assert_eq!(demo_capital().unwrap().normal(), Normal::Credit);
        assert_eq!(trading_result().unwrap().normal(), Normal::Credit);
        assert_eq!(trading_commission().unwrap().normal(), Normal::Credit);
        assert_eq!(commission().unwrap().normal(), Normal::Credit);
        assert_eq!(
            AccountId::parse("asset:house:cash").unwrap().normal(),
            Normal::Debit
        );
        assert_eq!(
            AccountId::parse("expense:fees:card").unwrap().normal(),
            Normal::Debit
        );
    }

    #[test]
    fn malformed_names_are_refused() {
        assert_eq!(AccountId::parse(""), Err(AccountError::BadLength));
        assert_eq!(
            AccountId::parse(&"asset:".repeat(40)),
            Err(AccountError::BadLength)
        );
        assert_eq!(
            AccountId::parse("Asset:house"),
            Err(AccountError::IllegalCharacter)
        );
        assert_eq!(
            AccountId::parse("asset:house cash"),
            Err(AccountError::IllegalCharacter)
        );
        assert_eq!(
            AccountId::parse("profit:house"),
            Err(AccountError::UnknownSection)
        );
    }

    #[test]
    fn a_client_cash_account_is_named_after_its_account_number() {
        assert_eq!(
            client_cash("50000001").unwrap().as_str(),
            "liability:client:50000001:cash"
        );
        assert!(client_cash("").is_err());
        assert!(client_cash("50000001; drop").is_err());
        assert!(client_cash("../etc").is_err());
    }
}

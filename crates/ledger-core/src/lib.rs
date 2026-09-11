//! # 03-ledger — the financial source of truth
//!
//! Every movement of value in the system is a balanced double-entry
//! transaction in this journal. Nothing else moves money; nothing else is
//! believed about money.
//!
//! ## The shape of it
//!
//! - [`Transaction`] can only exist balanced (INV-020, INV-021).
//! - [`Journal`] can only be appended to (INV-022).
//! - [`Balances`] is a fold over the journal, never a stored column (INV-023).
//!
//! Those three sentences are the module. Everything else here is detail in
//! service of them.
//!
//! ## What this crate deliberately does not do
//!
//! It does not know what a position, an order or a market price is. A ledger
//! that understands trading is a ledger that can be argued with about whether a
//! particular trade "really" needed to balance. This one cannot be argued with,
//! because it does not know what a trade is — it only knows that debits equal
//! credits.
//!
//! Durability lives one level up, in the service, which writes the journal to an
//! append-only log and replays it at startup (INV-024).

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod account;
pub mod balances;
pub mod journal;

pub use account::{
    client_cash, demo_capital, trading_commission, trading_result, AccountError, AccountId, Normal,
};
pub use balances::{BalanceError, Balances};
pub use journal::{Entry, Journal, JournalError, Transaction, TransactionKind};

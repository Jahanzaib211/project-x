//! The financial core as a library.
//!
//! `03-ledger` hosts `04-account`, `05-position`, `08-pnl-margin`, `09-risk`
//! and `11-execution` in one process because a trade is one transaction. The
//! same reasoning makes it one *library*: the replay and property suites in
//! `tests/` drive the real [`state::Core`] — open, fund, trade, close, crash,
//! reopen — rather than a model of it, which is the only way a G3 or G6 claim
//! about this module means anything.
//!
//! The binary (`main.rs`) is the HTTP shell around this crate and nothing else.

#![forbid(unsafe_code)]

pub mod quotes;
pub mod state;
pub mod volume;

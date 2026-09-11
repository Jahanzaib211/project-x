//! The financial core's state, and the log that makes it survive a restart.
//!
//! ## One process, one lock, one transaction
//!
//! Valuing an account, checking it against risk, booking the fill and posting
//! the ledger entries all happen inside [`Core::place_order`], under one lock.
//! They are not four services and they are not four commits. A trade is one
//! transaction, and this is what that sentence costs: everything it touches has
//! to live in one place.
//!
//! ## Durability is a fold over a log (INV-024, INV-104)
//!
//! State is never written. **Effects** are appended to a log — an account
//! opening, a deal — and the state is what you get by folding them in order.
//! Restarting replays the log; a crash mid-write truncates the last line, which
//! replay discards as incomplete. There is no snapshot to be inconsistent with
//! the log, and no schema migration that could reinterpret history.
//!
//! `fsync` runs before an effect is acknowledged. A fill the client was told
//! about, that is not on disk, is the one failure this design refuses to have.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use account_core::{
    open_demo, open_real, reset_demo, top_up_demo, AccountOpError, Mode, Status, TradingAccount,
    DEMO_GRANT_MINOR,
};
use domain_kernel::quantity::Side;
use domain_kernel::{AnyMoney, Money, Price, Quantity, Usd};
use event_kernel::Id;
use execution_core::{execute, Deal, DealIds, ExecutionError};
use ledger_core::{client_cash, AccountId, Balances, Entry, Journal, Transaction, TransactionKind};
use market_core::instrument::{find, Instrument};
use market_core::quote_at;
use pnl_margin::{value_account, Marks, Valuation, POLICY};
use position_core::{Book, Fill};
use risk_core::{assess, Decision, OrderIntent, Rejection};
use service_kit::json::{escape, Value};

use crate::volume;

/// Why an operation on the core failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoreError {
    /// No such trading account.
    UnknownAccount(String),
    /// The instrument is not tradable.
    UnknownInstrument(String),
    /// A field was missing or malformed.
    BadRequest(String),
    /// Risk refused the order. Carries the reason, so the client is told which.
    Refused(Rejection),
    /// The account holds no position to close in that symbol.
    NothingToClose,
    /// An account operation was refused by `04-account`'s rules.
    Account(AccountOpError),
    /// Execution refused.
    Execution(ExecutionError),
    /// The core could not be valued, so nothing was attempted (fails closed).
    Unavailable(String),
    /// Writing the log failed, so the effect was not acknowledged.
    NotDurable(String),
}

impl core::fmt::Display for CoreError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::UnknownAccount(number) => write!(f, "no account {number}"),
            Self::UnknownInstrument(symbol) => write!(f, "{symbol} is not tradable"),
            Self::BadRequest(detail) => f.write_str(detail),
            Self::Refused(reason) => write!(f, "{reason}"),
            Self::NothingToClose => f.write_str("there is no open position to close"),
            Self::Account(err) => write!(f, "{err}"),
            Self::Execution(err) => write!(f, "{err}"),
            Self::Unavailable(detail) => write!(f, "unavailable: {detail}"),
            Self::NotDurable(detail) => write!(f, "not durable: {detail}"),
        }
    }
}

impl CoreError {
    /// A stable machine-readable code for the API.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownAccount(_) => "UNKNOWN_ACCOUNT",
            Self::UnknownInstrument(_) => "UNKNOWN_INSTRUMENT",
            Self::BadRequest(_) => "BAD_REQUEST",
            Self::Refused(reason) => reason.code(),
            Self::NothingToClose => "NOTHING_TO_CLOSE",
            Self::Account(err) => match err {
                AccountOpError::WrongMode => "WRONG_MODE",
                AccountOpError::NotPermitted { .. } => "ACCOUNT_NOT_ACTIVE",
                AccountOpError::ExceedsDemoCap { .. } => "DEMO_CAP_EXCEEDED",
                AccountOpError::PositionsOpen => "POSITIONS_OPEN",
                AccountOpError::IllegalTransition { .. } => "ILLEGAL_TRANSITION",
                AccountOpError::NonPositiveAmount
                | AccountOpError::BadAccountNumber
                | AccountOpError::Ledger(_)
                | AccountOpError::Arithmetic(_) => "BAD_REQUEST",
            },
            Self::Execution(_) => "EXECUTION_FAILED",
            Self::Unavailable(_) => "CORE_UNAVAILABLE",
            Self::NotDurable(_) => "NOT_DURABLE",
        }
    }

    /// The HTTP status this maps to.
    #[must_use]
    pub const fn status(&self) -> u16 {
        match self {
            Self::UnknownAccount(_) | Self::UnknownInstrument(_) => 404,
            Self::BadRequest(_) => 400,
            Self::Refused(_) | Self::NothingToClose | Self::Account(_) => 422,
            Self::Execution(_) => 409,
            Self::Unavailable(_) | Self::NotDurable(_) => 503,
        }
    }
}

/// Market state as this process reads it: pure, addressed by tick.
struct TickMarks {
    tick: u64,
}

impl Marks for TickMarks {
    fn mark(&self, symbol: &str) -> Option<Price<Usd>> {
        // Positions are marked at the mid, not at the side they would close on.
        // Marking at the closing side would show a client a loss equal to the
        // spread the instant a position opens, which is true of the exit but not
        // of the holding — and the two are different questions.
        find(symbol).and_then(|instrument| quote_at(instrument, self.tick).ok().map(|q| q.mid()))
    }

    fn instrument(&self, symbol: &str) -> Option<&'static Instrument> {
        find(symbol)
    }
}

/// A recorded order outcome, for the order history.
#[derive(Clone, Debug)]
pub struct OrderRecord {
    /// The order id.
    pub order_id: Id,
    /// Client-supplied idempotency key.
    pub client_key: String,
    /// Account it was for.
    pub account: String,
    /// Instrument.
    pub symbol: String,
    /// Side.
    pub side: Side,
    /// Volume in thousandths of a lot.
    pub milli_lots: i128,
    /// Tick it was decided on.
    pub tick: u64,
    /// The deal, when it filled.
    pub deal: Option<Deal>,
    /// The rejection, when it did not.
    pub rejection: Option<Rejection>,
}

impl OrderRecord {
    /// The terminal state of the order (INV-090).
    #[must_use]
    pub const fn state(&self) -> &'static str {
        if self.deal.is_some() {
            "FILLED"
        } else {
            "REJECTED"
        }
    }
}

/// A demo credit or reset that was posted, kept so a retry finds it.
#[derive(Clone, Debug)]
pub struct CreditRecord {
    /// Client-supplied idempotency key.
    pub client_key: String,
    /// The account it was for.
    pub account: String,
    /// The transaction posted, or `None` for a reset that had nothing to do.
    pub transaction: Option<Transaction>,
}

/// The whole financial core.
pub struct Core {
    journal: Journal,
    balances: Balances,
    book: Book,
    accounts: Vec<TradingAccount>,
    orders: Vec<OrderRecord>,
    credits: Vec<CreditRecord>,
    next_account_number: i128,
    /// Monotonic counter that ids are drawn from.
    ///
    /// Deterministic on purpose: replaying the log restores the same counter, so
    /// a replayed run allocates the same ids as the original (INV-104). A random
    /// id would make two replays differ in a way nothing could reconcile.
    next_id: u128,
    log_path: Option<PathBuf>,
    log: Option<File>,
}

impl Core {
    /// An empty core with no durable log. Used by tests.
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            journal: Journal::new(),
            balances: Balances::new(),
            book: Book::new(),
            accounts: Vec::new(),
            orders: Vec::new(),
            credits: Vec::new(),
            next_account_number: 50_000_001,
            next_id: 1,
            log_path: None,
            log: None,
        }
    }

    /// Open the core at `path`, replaying whatever is already there.
    ///
    /// # Errors
    /// The replayed log could not be read, or the file could not be opened for
    /// appending. Either is fatal: a core that cannot prove what it holds must
    /// not serve.
    pub fn open(path: &Path) -> Result<Self, String> {
        let mut core = Self::in_memory();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        if path.exists() {
            let file = File::open(path).map_err(|err| err.to_string())?;
            for line in BufReader::new(file).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                // A line that does not parse is a torn write from a crash. It
                // can only be the last one, and it is discarded — the effect it
                // described was never acknowledged to anyone.
                let Ok(record) = service_kit::json::parse(&line) else {
                    break;
                };
                core.replay(&record)?;
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|err| err.to_string())?;
        core.log_path = Some(path.to_path_buf());
        core.log = Some(file);
        Ok(core)
    }

    /// How many transactions have been posted. Doubles as the state version.
    #[must_use]
    pub fn version(&self) -> usize {
        self.journal.len()
    }

    /// Every account, in the order they were opened.
    #[must_use]
    pub fn all_accounts(&self) -> &[TradingAccount] {
        &self.accounts
    }

    /// One account.
    #[must_use]
    pub fn account(&self, number: &str) -> Option<&TradingAccount> {
        self.accounts.iter().find(|a| a.number == number)
    }

    /// The whole journal, oldest first.
    #[must_use]
    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    /// Every ledger account and its signed balance, per currency.
    #[must_use]
    pub fn trial_balance(&self) -> Vec<(&str, &'static str, i128)> {
        self.balances.entries()
    }

    /// Every order recorded, newest first.
    #[must_use]
    pub fn all_orders(&self) -> Vec<&OrderRecord> {
        let mut found: Vec<&OrderRecord> = self.orders.iter().collect();
        found.reverse();
        found
    }

    /// How many positions an account has open.
    #[must_use]
    pub fn open_position_count(&self, account: &str) -> usize {
        self.book.for_account(account).len()
    }

    /// A credit or reset already posted under this idempotency key, if any.
    #[must_use]
    pub fn credit_by_key(&self, account: &str, key: &str) -> Option<&CreditRecord> {
        self.credits
            .iter()
            .find(|credit| credit.account == account && credit.client_key == key)
    }

    /// Every order recorded for an account, newest first.
    #[must_use]
    pub fn orders_of(&self, account: &str) -> Vec<&OrderRecord> {
        let mut found: Vec<&OrderRecord> = self
            .orders
            .iter()
            .filter(|order| order.account == account)
            .collect();
        found.reverse();
        found
    }

    /// An order already recorded under this idempotency key, if any.
    ///
    /// INV-181/INV-102: a retried submission returns the first outcome rather
    /// than placing a second order.
    #[must_use]
    pub fn order_by_key(&self, account: &str, key: &str) -> Option<&OrderRecord> {
        self.orders
            .iter()
            .find(|order| order.account == account && order.client_key == key)
    }

    /// Every transaction concerning an account, newest first.
    #[must_use]
    pub fn statement(&self, account: &str) -> Vec<&Transaction> {
        let mut found: Vec<&Transaction> = self.journal.for_subject(account).collect();
        found.reverse();
        found
    }

    /// The ledger balance of an account, or `None` if it has no entries.
    #[must_use]
    pub fn balance_of(&self, account: &str) -> Option<Money<Usd>> {
        let cash = client_cash(account).ok()?;
        self.balances
            .natural(&cash, "USD")
            .and_then(|amount| amount.typed::<Usd>().ok())
    }

    /// Value an account at `tick`.
    ///
    /// # Errors
    /// [`CoreError`] if the account is unknown or cannot be valued. Failing
    /// rather than guessing is the point: an equity figure that quietly omitted
    /// a position would be worse than no figure at all (INV-183).
    pub fn valuation(&self, account: &str, tick: u64) -> Result<Valuation, CoreError> {
        if self.account(account).is_none() {
            return Err(CoreError::UnknownAccount(account.to_owned()));
        }
        let balance = self.balance_of(account).unwrap_or_else(Money::zero);
        let positions = self.book.for_account(account);
        value_account(balance, &positions, &TickMarks { tick }, &POLICY)
            .map_err(|err| CoreError::Unavailable(err.to_string()))
    }

    /// Whether the balance projection still agrees with the journal (INV-023).
    #[must_use]
    pub fn projection_drift(&self) -> u64 {
        u64::from(self.balances.verify(&self.journal).is_err())
    }

    /// Whether the whole book balances (INV-020, at the level of the book).
    #[must_use]
    pub fn imbalanced_transactions(&self) -> u64 {
        u64::from(!self.balances.is_balanced())
    }

    /// Open an account in either mode.
    ///
    /// A demo account is funded from the demo pot in the same effect that
    /// creates it. A real account is created with nothing and no transaction:
    /// nothing was received, so nothing may be recognised.
    ///
    /// # Errors
    /// [`CoreError`] if the account could not be opened or the effect could not
    /// be made durable.
    pub fn open_account(
        &mut self,
        owner: &str,
        nickname: &str,
        leverage: i128,
        mode: Mode,
        tick: u64,
    ) -> Result<TradingAccount, CoreError> {
        let number = self.next_account_number.to_string();
        let (account, transaction) = match mode {
            Mode::Demo => {
                let transaction_id = self.take_id();
                let (account, transaction) = open_demo(
                    &number,
                    owner,
                    nickname,
                    leverage,
                    tick,
                    transaction_id,
                    DEMO_GRANT_MINOR,
                )
                .map_err(|err| CoreError::BadRequest(err.to_string()))?;
                (account, Some(transaction))
            }
            Mode::Real => (
                open_real(&number, owner, nickname, leverage, tick)
                    .map_err(|err| CoreError::BadRequest(err.to_string()))?,
                None,
            ),
        };

        // Durable first, in memory second. The other order can acknowledge an
        // account that a restart would not find.
        self.append_log(&account_record(&account, transaction.as_ref()))?;
        self.commit_account(account.clone(), transaction)
            .map_err(CoreError::Unavailable)?;
        Ok(account)
    }

    /// Freeze, reactivate or close an account (INV-032).
    ///
    /// # Errors
    /// [`CoreError::UnknownAccount`], or [`CoreError::Account`] for a
    /// transition the lifecycle does not allow.
    pub fn set_account_status(
        &mut self,
        number: &str,
        status: Status,
    ) -> Result<TradingAccount, CoreError> {
        let mut updated = self
            .account(number)
            .ok_or_else(|| CoreError::UnknownAccount(number.to_owned()))?
            .clone();
        updated.set_status(status).map_err(CoreError::Account)?;
        self.append_log(&status_record(number, status))?;
        if let Some(stored) = self.accounts.iter_mut().find(|a| a.number == number) {
            *stored = updated.clone();
        }
        Ok(updated)
    }

    /// Issue demo capital to a demo account (INV-034).
    ///
    /// Idempotent on `client_key`: a retry returns the first credit and posts
    /// nothing (INV-181).
    ///
    /// # Errors
    /// [`CoreError::UnknownAccount`], [`CoreError::Account`] for a refusal, or
    /// [`CoreError::NotDurable`].
    pub fn credit_demo(
        &mut self,
        number: &str,
        amount_minor: i128,
        client_key: &str,
    ) -> Result<CreditRecord, CoreError> {
        if let Some(existing) = self.credit_by_key(number, client_key) {
            return Ok(existing.clone());
        }
        let account = self
            .account(number)
            .ok_or_else(|| CoreError::UnknownAccount(number.to_owned()))?
            .clone();
        let balance = self.balance_of(number).map_or(0, Money::minor);
        let transaction_id = self.take_id();
        let transaction = top_up_demo(&account, balance, amount_minor, transaction_id)
            .map_err(CoreError::Account)?;
        self.post_credit(number, client_key, Some(transaction))
    }

    /// Put a demo account back to its opening grant (INV-035).
    ///
    /// # Errors
    /// As [`Core::credit_demo`]; additionally refused while positions are open.
    pub fn reset_demo_account(
        &mut self,
        number: &str,
        client_key: &str,
    ) -> Result<CreditRecord, CoreError> {
        if let Some(existing) = self.credit_by_key(number, client_key) {
            return Ok(existing.clone());
        }
        let account = self
            .account(number)
            .ok_or_else(|| CoreError::UnknownAccount(number.to_owned()))?
            .clone();
        let balance = self.balance_of(number).map_or(0, Money::minor);
        let open = self.open_position_count(number);
        let transaction_id = self.take_id();
        let transaction =
            reset_demo(&account, balance, open, transaction_id).map_err(CoreError::Account)?;
        self.post_credit(number, client_key, transaction)
    }

    fn post_credit(
        &mut self,
        number: &str,
        client_key: &str,
        transaction: Option<Transaction>,
    ) -> Result<CreditRecord, CoreError> {
        let record = CreditRecord {
            client_key: client_key.to_owned(),
            account: number.to_owned(),
            transaction,
        };
        self.append_log(&credit_record(&record))?;
        if let Some(transaction) = &record.transaction {
            self.journal
                .append(transaction.clone())
                .map_err(|err| CoreError::Unavailable(err.to_string()))?;
            self.balances
                .apply(transaction)
                .map_err(|err| CoreError::Unavailable(err.to_string()))?;
        }
        self.credits.push(record.clone());
        Ok(record)
    }

    /// Place a market order: value, check, book and post, atomically.
    ///
    /// # Errors
    /// [`CoreError`] with the specific reason. A refusal is a normal outcome and
    /// is recorded (INV-082) rather than discarded.
    pub fn place_order(
        &mut self,
        account_number: &str,
        symbol: &str,
        side: Side,
        milli_lots: i128,
        tick: u64,
        client_key: &str,
    ) -> Result<OrderRecord, CoreError> {
        // INV-181 — a retry returns the first outcome, it does not place a
        // second order.
        if let Some(existing) = self.order_by_key(account_number, client_key) {
            return Ok(existing.clone());
        }

        let account = self
            .account(account_number)
            .ok_or_else(|| CoreError::UnknownAccount(account_number.to_owned()))?
            .clone();
        let instrument =
            find(symbol).ok_or_else(|| CoreError::UnknownInstrument(symbol.to_owned()))?;

        let quantity = volume::to_quantity(milli_lots, instrument)
            .map_err(|err| CoreError::BadRequest(err.to_string()))?;
        let quote =
            quote_at(instrument, tick).map_err(|err| CoreError::Unavailable(err.to_string()))?;
        let fill_price = quote.fill_price(side);
        let valuation = self.valuation(account_number, tick)?;

        let intent = OrderIntent {
            account: account_number,
            instrument,
            side,
            quantity,
            price: fill_price,
            tick,
            market_age_ms: 0,
            // INV-032, asked once, here, rather than re-tested in three places.
            account_tradable: account.may_originate(),
            // INV-084 — the quote knows whether it is live or frozen.
            session_open: quote.session_open(),
        };

        let order_id = self.take_id();
        match assess(&intent, &valuation, &POLICY) {
            Decision::Rejected { reason, .. } => {
                // A rejection is a decision and it is kept (INV-082). It posts
                // nothing, so it does not go in the durable log — nothing
                // financial happened — but the client is told exactly why.
                let record = OrderRecord {
                    order_id,
                    client_key: client_key.to_owned(),
                    account: account_number.to_owned(),
                    symbol: symbol.to_owned(),
                    side,
                    milli_lots,
                    tick,
                    deal: None,
                    rejection: Some(reason),
                };
                self.orders.push(record);
                Err(CoreError::Refused(reason))
            }
            Decision::Approved(approval) => {
                let ids = DealIds {
                    deal_id: self.take_id(),
                    order_id,
                    fill_event_id: self.take_id(),
                    transaction_id: self.take_id(),
                };
                // Executed against a copy, so a failure leaves the real book
                // untouched and there is no half-done trade to unwind.
                let mut scratch = self.book.clone();
                let deal = execute(&approval, ids, instrument, fill_price, tick, &mut scratch)
                    .map_err(CoreError::Execution)?;

                // Durable before acknowledged. A fill the client was told about
                // must survive the process dying immediately afterwards.
                self.append_log(&deal_record(&deal))?;

                self.book = scratch;
                self.journal
                    .append(deal.transaction.clone())
                    .map_err(|err| CoreError::Unavailable(err.to_string()))?;
                self.balances
                    .apply(&deal.transaction)
                    .map_err(|err| CoreError::Unavailable(err.to_string()))?;

                let record = OrderRecord {
                    order_id,
                    client_key: client_key.to_owned(),
                    account: account_number.to_owned(),
                    symbol: symbol.to_owned(),
                    side,
                    milli_lots,
                    tick,
                    deal: Some(deal),
                    rejection: None,
                };
                self.orders.push(record.clone());
                Ok(record)
            }
        }
    }

    /// Close an open position at the market.
    ///
    /// # Errors
    /// [`CoreError::NothingToClose`] if there is no position, or whatever
    /// placing the closing order returns.
    pub fn close_position(
        &mut self,
        account_number: &str,
        symbol: &str,
        tick: u64,
        client_key: &str,
    ) -> Result<OrderRecord, CoreError> {
        let instrument =
            find(symbol).ok_or_else(|| CoreError::UnknownInstrument(symbol.to_owned()))?;
        let position = self
            .book
            .get(account_number, symbol)
            .ok_or(CoreError::NothingToClose)?;

        // Closing is an ordinary order on the opposite side, for exactly the
        // open quantity. It is not a special path: a close that skipped risk or
        // skipped the journal would be a second way for money to move.
        let side = position.side.opposite();
        let milli = position
            .quantity
            .raw()
            .saturating_mul(1_000)
            .checked_div(instrument.contract_size.saturating_mul(100_000_000))
            .unwrap_or(0);
        if milli <= 0 {
            return Err(CoreError::NothingToClose);
        }
        self.place_order(account_number, symbol, side, milli, tick, client_key)
    }

    /// Take the next deterministic id.
    fn take_id(&mut self) -> Id {
        let id = Id(self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        id
    }

    fn commit_account(
        &mut self,
        account: TradingAccount,
        transaction: Option<Transaction>,
    ) -> Result<(), String> {
        let number: i128 = account.number.parse().unwrap_or(self.next_account_number);
        self.next_account_number = self.next_account_number.max(number.saturating_add(1));
        self.accounts.push(account);
        if let Some(transaction) = transaction {
            self.journal
                .append(transaction.clone())
                .map_err(|err| err.to_string())?;
            self.balances
                .apply(&transaction)
                .map_err(|err| err.to_string())?;
        }
        Ok(())
    }

    /// Append one record to the log and flush it to disk.
    fn append_log(&mut self, line: &str) -> Result<(), CoreError> {
        let Some(file) = self.log.as_mut() else {
            return Ok(());
        };
        writeln!(file, "{line}").map_err(|err| CoreError::NotDurable(err.to_string()))?;
        // Not `flush`: that only reaches the OS buffer. `sync_all` is what makes
        // the acknowledgement true after a power cut.
        file.sync_all()
            .map_err(|err| CoreError::NotDurable(err.to_string()))
    }

    /// Fold one logged record back in.
    fn replay(&mut self, record: &Value) -> Result<(), String> {
        match record.str_field("type") {
            Some("account") => {
                let account = read_account(record).ok_or("malformed account record")?;
                // A real account's record carries `null`: nothing was posted
                // when it opened, and replay must not invent something.
                let transaction = match record.get("transaction") {
                    None | Some(Value::Null) => None,
                    Some(value) => {
                        Some(read_transaction(value).ok_or("malformed transaction record")?)
                    }
                };
                self.bump_id_past(record);
                self.commit_account(account, transaction)
            }
            Some("status") => {
                let number = record.str_field("number").ok_or("no account number")?;
                let status = record
                    .str_field("status")
                    .and_then(Status::parse)
                    .ok_or("malformed status record")?;
                let account = self
                    .accounts
                    .iter_mut()
                    .find(|a| a.number == number)
                    .ok_or("status for an account the log never opened")?;
                // Replayed as written, not re-validated: the transition was
                // legal when it was made, and history is not re-litigated.
                account.status = status;
                Ok(())
            }
            Some("credit") => {
                let transaction = match record.get("transaction") {
                    None | Some(Value::Null) => None,
                    Some(value) => {
                        Some(read_transaction(value).ok_or("malformed transaction record")?)
                    }
                };
                self.bump_id_past(record);
                let credit = CreditRecord {
                    client_key: record.str_field("key").ok_or("no key")?.to_owned(),
                    account: record.str_field("account").ok_or("no account")?.to_owned(),
                    transaction,
                };
                if let Some(transaction) = &credit.transaction {
                    self.journal
                        .append(transaction.clone())
                        .map_err(|err| err.to_string())?;
                    self.balances
                        .apply(transaction)
                        .map_err(|err| err.to_string())?;
                }
                self.credits.push(credit);
                Ok(())
            }
            Some("deal") => {
                let fill = read_fill(record).ok_or("malformed fill record")?;
                let transaction =
                    read_transaction(record.get("transaction").ok_or("no transaction")?)
                        .ok_or("malformed transaction record")?;
                self.bump_id_past(record);
                self.book.apply(&fill).map_err(|err| err.to_string())?;
                self.journal
                    .append(transaction.clone())
                    .map_err(|err| err.to_string())?;
                self.balances
                    .apply(&transaction)
                    .map_err(|err| err.to_string())
            }
            _ => Err("unknown record type".to_owned()),
        }
    }

    /// Keep the id counter ahead of everything the log already used.
    fn bump_id_past(&mut self, record: &Value) {
        for key in ["transactionId", "dealId", "orderId", "fillEventId"] {
            if let Some(value) = record.get(key).and_then(Value::as_u64) {
                self.next_id = self.next_id.max(u128::from(value).saturating_add(1));
            }
        }
        if let Some(value) = record
            .get("transaction")
            .and_then(|t| t.get("id"))
            .and_then(Value::as_u64)
        {
            self.next_id = self.next_id.max(u128::from(value).saturating_add(1));
        }
    }
}

/* ------------------------------------------------------------ log records */

fn entries_json(transaction: &Transaction) -> String {
    transaction
        .entries()
        .iter()
        .map(|entry| {
            format!(
                r#"{{"account":"{}","minor":{},"currency":"{}","scale":{}}}"#,
                escape(entry.account.as_str()),
                entry.amount.minor,
                escape(entry.amount.currency),
                entry.amount.scale
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn transaction_json(transaction: &Transaction) -> String {
    format!(
        r#"{{"id":{},"kind":"{}","subject":"{}","entries":[{}]}}"#,
        transaction.id().0,
        escape(transaction.kind().name()),
        escape(transaction.subject().unwrap_or_default()),
        entries_json(transaction)
    )
}

fn account_record(account: &TradingAccount, transaction: Option<&Transaction>) -> String {
    format!(
        r#"{{"type":"account","number":"{}","owner":"{}","nickname":"{}","mode":"{}","leverage":{},"openedTick":{},"transaction":{}}}"#,
        escape(&account.number),
        escape(&account.owner),
        escape(&account.nickname),
        escape(account.mode.name()),
        account.leverage,
        account.opened_tick,
        transaction.map_or_else(|| "null".to_owned(), transaction_json)
    )
}

fn status_record(number: &str, status: Status) -> String {
    format!(
        r#"{{"type":"status","number":"{}","status":"{}"}}"#,
        escape(number),
        escape(status.name())
    )
}

fn credit_record(credit: &CreditRecord) -> String {
    format!(
        r#"{{"type":"credit","account":"{}","key":"{}","transaction":{}}}"#,
        escape(&credit.account),
        escape(&credit.client_key),
        credit
            .transaction
            .as_ref()
            .map_or_else(|| "null".to_owned(), transaction_json)
    )
}

fn deal_record(deal: &Deal) -> String {
    format!(
        r#"{{"type":"deal","dealId":{},"orderId":{},"fillEventId":{},"account":"{}","symbol":"{}","side":"{}","quantityRaw":{},"priceRaw":{},"tick":{},"transaction":{}}}"#,
        deal.ids.deal_id.0,
        deal.ids.order_id.0,
        deal.ids.fill_event_id.0,
        escape(&deal.account),
        escape(&deal.symbol),
        if deal.side == Side::Buy {
            "BUY"
        } else {
            "SELL"
        },
        deal.quantity.raw(),
        deal.price.raw(),
        deal.tick,
        transaction_json(&deal.transaction)
    )
}

fn read_i128(value: Option<&Value>) -> Option<i128> {
    match value {
        Some(Value::Number(text)) => text.parse().ok(),
        _ => None,
    }
}

fn read_account(record: &Value) -> Option<TradingAccount> {
    Some(TradingAccount {
        number: record.str_field("number")?.to_owned(),
        owner: record.str_field("owner")?.to_owned(),
        mode: Mode::parse(record.str_field("mode")?)?,
        currency: "USD",
        leverage: read_i128(record.get("leverage"))?,
        status: record
            .str_field("status")
            .and_then(Status::parse)
            .unwrap_or(Status::Active),
        opened_tick: record.get("openedTick").and_then(Value::as_u64)?,
        nickname: record.str_field("nickname")?.to_owned(),
    })
}

fn read_fill(record: &Value) -> Option<Fill> {
    Some(Fill {
        event_id: Id(u128::from(
            record.get("fillEventId").and_then(Value::as_u64)?,
        )),
        account: record.str_field("account")?.to_owned(),
        symbol: record.str_field("symbol")?.to_owned(),
        side: match record.str_field("side")? {
            "BUY" => Side::Buy,
            "SELL" => Side::Sell,
            _ => return None,
        },
        quantity: Quantity::from_raw(read_i128(record.get("quantityRaw"))?),
        price: Price::from_raw(read_i128(record.get("priceRaw"))?),
        tick: record.get("tick").and_then(Value::as_u64)?,
    })
}

fn read_transaction(value: &Value) -> Option<Transaction> {
    let id = Id(u128::from(value.get("id").and_then(Value::as_u64)?));
    let kind = TransactionKind::from_name(value.str_field("kind")?)?;
    let subject = value.str_field("subject").map(str::to_owned);
    let Value::Array(rows) = value.get("entries")? else {
        return None;
    };

    let mut entries = Vec::with_capacity(rows.len());
    for row in rows {
        let account = AccountId::parse(row.str_field("account")?).ok()?;
        let minor = read_i128(row.get("minor"))?;
        // The code is matched back to a `'static` string rather than leaked,
        // so a corrupted log cannot introduce a currency the system has never
        // heard of.
        let currency = ["USD", "EUR", "GBP", "JPY", "CHF", "XAU", "BTC"]
            .into_iter()
            .find(|known| *known == row.str_field("currency").unwrap_or_default())?;
        let scale = u32::try_from(row.get("scale").and_then(Value::as_u64)?).ok()?;
        entries.push(Entry {
            account,
            amount: AnyMoney {
                minor,
                currency,
                scale,
            },
        });
    }
    Transaction::balanced(id, kind, subject.filter(|s| !s.is_empty()), entries).ok()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use std::io::Read;

    /// A scratch path that cleans itself up, so the tests leave nothing behind
    /// and can run in parallel without colliding.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "projectx-ledger-test-{name}-{}.log",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&path);
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn text(&self) -> String {
            let mut text = String::new();
            if let Ok(mut file) = File::open(&self.0) {
                let _ = file.read_to_string(&mut text);
            }
            text
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// A summary of everything a client could observe, so two cores can be
    /// compared as wholes rather than field by field.
    fn fingerprint(core: &Core, account: &str, tick: u64) -> String {
        let valuation = core.valuation(account, tick).unwrap();
        let positions: Vec<String> = core
            .book
            .for_account(account)
            .iter()
            .map(|p| {
                format!(
                    "{}:{:?}:{}:{}",
                    p.symbol,
                    p.side,
                    p.quantity.raw(),
                    p.average_price.raw()
                )
            })
            .collect();
        format!(
            "v={} balance={} equity={} used={} free={} level={:?} positions=[{}] entries={:?}",
            core.version(),
            valuation.balance.to_decimal_string(),
            valuation.equity.to_decimal_string(),
            valuation.used_margin.to_decimal_string(),
            valuation.free_margin.to_decimal_string(),
            valuation.margin_level_bp,
            positions.join(","),
            core.balances.entries(),
        )
    }

    /// Open an account and trade it, so there is real history to recover.
    fn trade(core: &mut Core) -> String {
        let account = core
            .open_account("dev-owner-0001", "Demo", 500, Mode::Demo, 1_526_000)
            .unwrap();
        let number = account.number.clone();
        core.place_order(
            &number,
            "EURUSD",
            Side::Buy,
            1_000,
            1_526_000,
            "key-open-0001",
        )
        .unwrap();
        core.place_order(
            &number,
            "XAUUSD",
            Side::Sell,
            100,
            1_526_100,
            "key-open-0002",
        )
        .unwrap();
        // One round trip, so the log carries a realised result as well as open
        // positions.
        core.place_order(
            &number,
            "EURUSD",
            Side::Sell,
            500,
            1_526_200,
            "key-part-0003",
        )
        .unwrap();
        number
    }

    /// INV-024 / INV-104 — the ledger after recovery is identical to the ledger
    /// before the crash. Not "close": identical, including the balance of every
    /// account, every open position and its average price.
    #[test]
    fn inv_024_a_recovered_ledger_is_identical_to_the_one_that_crashed() {
        let scratch = Scratch::new("recovery");

        let (before, account) = {
            let mut core = Core::open(scratch.path()).unwrap();
            let account = trade(&mut core);
            (fingerprint(&core, &account, 1_526_300), account)
        };
        // The process is gone; nothing was written on the way out.

        let recovered = Core::open(scratch.path()).unwrap();
        let after = fingerprint(&recovered, &account, 1_526_300);

        assert_eq!(before, after);
        assert_eq!(recovered.projection_drift(), 0, "INV-023 after replay");
        assert_eq!(
            recovered.imbalanced_transactions(),
            0,
            "INV-020 after replay"
        );
    }

    /// A crash mid-write leaves a partial last line. Replay must discard it —
    /// the effect it described was never acknowledged to anybody — and must not
    /// refuse to start over it.
    #[test]
    fn a_torn_final_write_is_discarded_rather_than_crashing_the_restart() {
        let scratch = Scratch::new("torn");
        let (complete, account) = {
            let mut core = Core::open(scratch.path()).unwrap();
            let account = trade(&mut core);
            (fingerprint(&core, &account, 1_526_300), account)
        };

        // Simulate a power cut part-way through appending the next deal.
        {
            let mut file = OpenOptions::new()
                .append(true)
                .open(scratch.path())
                .unwrap();
            write!(file, r#"{{"type":"deal","dealId":99,"accou"#).unwrap();
        }

        let recovered = Core::open(scratch.path()).unwrap();
        assert_eq!(
            fingerprint(&recovered, &account, 1_526_300),
            complete,
            "a torn line must change nothing"
        );
        assert_eq!(recovered.projection_drift(), 0);
    }

    /// Ids are drawn from a counter that replay restores, so a recovered
    /// process does not reissue an id the crashed one already used — which
    /// would make a new deal collide with an old one.
    #[test]
    fn ids_continue_where_the_crashed_process_left_off() {
        let scratch = Scratch::new("ids");
        let account = {
            let mut core = Core::open(scratch.path()).unwrap();
            trade(&mut core)
        };

        let mut recovered = Core::open(scratch.path()).unwrap();
        let existing: Vec<u128> = recovered
            .journal
            .transactions()
            .iter()
            .map(|t| t.id().0)
            .collect();

        let record = recovered
            .place_order(
                &account,
                "EURUSD",
                Side::Buy,
                100,
                1_526_400,
                "key-after-0001",
            )
            .unwrap();
        let deal = record.deal.unwrap();
        assert!(
            !existing.contains(&deal.ids.transaction_id.0),
            "a recovered process reissued an id that was already used"
        );
        assert_eq!(recovered.projection_drift(), 0);
    }

    /// Every acknowledged effect is on disk before the caller hears about it.
    #[test]
    fn an_effect_is_durable_before_it_is_acknowledged() {
        let scratch = Scratch::new("durable");
        let mut core = Core::open(scratch.path()).unwrap();
        let account = core
            .open_account("dev-owner-0001", "Demo", 500, Mode::Demo, 1_526_000)
            .unwrap();

        // The account's funding is already in the file, before this line runs.
        assert!(scratch.text().contains(r#""type":"account""#));
        assert!(scratch.text().contains("DEMO_CREDIT"));

        core.place_order(
            &account.number,
            "EURUSD",
            Side::Buy,
            100,
            1_526_000,
            "key-x-0001",
        )
        .unwrap();
        let text = scratch.text();
        assert!(text.contains(r#""type":"deal""#));
        assert_eq!(text.lines().count(), 2, "one line per effect, no more");
    }

    /// A rejected order posts nothing, so it must leave no trace in the log —
    /// and it must not consume the client's idempotency key for a later,
    /// legitimate order.
    #[test]
    fn a_rejected_order_writes_nothing_to_the_log() {
        let scratch = Scratch::new("rejected");
        let mut core = Core::open(scratch.path()).unwrap();
        let account = core
            .open_account("dev-owner-0001", "Demo", 500, Mode::Demo, 1_526_000)
            .unwrap();
        let before = scratch.text();

        let refused = core.place_order(
            &account.number,
            "EURUSD",
            Side::Buy,
            49_000,
            1_526_000,
            "key-refused-01",
        );
        assert!(matches!(refused, Err(CoreError::Refused(_))));
        assert_eq!(
            scratch.text(),
            before,
            "a refusal is not a financial effect"
        );

        // It is still recorded as a decision, though (INV-082).
        assert_eq!(core.orders_of(&account.number).len(), 1);
        assert_eq!(core.orders_of(&account.number)[0].state(), "REJECTED");
    }

    /// The whole loop, asserted on the numbers: fund, buy, close, and the
    /// balance moves by exactly the realised result less both commissions.
    #[test]
    fn the_round_trip_moves_the_balance_by_exactly_the_result_less_commission() {
        let mut core = Core::in_memory();
        let account = core
            .open_account("dev-owner-0001", "Demo", 500, Mode::Demo, 2_476_800)
            .unwrap()
            .number;
        assert_eq!(
            core.balance_of(&account).unwrap().to_decimal_string(),
            "10000.00"
        );

        let opened = core
            .place_order(
                &account,
                "EURUSD",
                Side::Buy,
                1_000,
                2_476_800,
                "open-key-0001",
            )
            .unwrap();
        let open_deal = opened.deal.unwrap();

        let closed = core
            .close_position(&account, "EURUSD", 2_477_200, "close-key-0001")
            .unwrap();
        let close_deal = closed.deal.unwrap();

        let expected = Money::<Usd>::from_minor(1_000_000)
            .add(close_deal.realised)
            .unwrap()
            .sub(open_deal.commission)
            .unwrap()
            .sub(close_deal.commission)
            .unwrap();
        assert_eq!(core.balance_of(&account).unwrap(), expected);

        // Flat again, and the whole book still balances.
        assert!(core.book.for_account(&account).is_empty());
        assert_eq!(core.imbalanced_transactions(), 0);
        assert_eq!(core.projection_drift(), 0);
    }

    /// INV-024/INV-104 — accounts of both modes, a status change and demo
    /// credits all come back from the log exactly as they were.
    #[test]
    fn inv_024_modes_statuses_and_credits_survive_a_restart() {
        let scratch = Scratch::new("modes");
        let (demo, real, before) = {
            let mut core = Core::open(scratch.path()).unwrap();
            let demo = core.open_account("o", "Demo", 500, Mode::Demo, 10).unwrap();
            let real = core.open_account("o", "Real", 100, Mode::Real, 11).unwrap();
            core.credit_demo(&demo.number, 12_345, "credit-key-0001")
                .unwrap();
            core.credit_demo(&demo.number, 12_345, "credit-key-0001")
                .unwrap();
            core.set_account_status(&real.number, Status::Frozen)
                .unwrap();
            core.reset_demo_account(&demo.number, "reset-key-00001")
                .unwrap();
            let balance = core.balance_of(&demo.number).unwrap();
            (demo.number, real.number, balance)
        };
        assert_eq!(before.minor(), DEMO_GRANT_MINOR);
        assert!(scratch.text().contains(r#""transaction":null"#));

        let core = Core::open(scratch.path()).unwrap();
        assert_eq!(core.account(&demo).unwrap().mode, Mode::Demo);
        let real_account = core.account(&real).unwrap();
        assert_eq!(real_account.mode, Mode::Real);
        assert_eq!(real_account.status, Status::Frozen);
        assert_eq!(core.balance_of(&real), None);
        assert_eq!(core.balance_of(&demo).unwrap().minor(), before.minor());
        assert!(core.credit_by_key(&demo, "credit-key-0001").is_some());
        assert!(core.credit_by_key(&demo, "reset-key-00001").is_some());
        assert_eq!(core.projection_drift(), 0);
        // Three postings: grant, credit, correction. The replay did not
        // double-apply the retried credit.
        assert_eq!(core.version(), 3);
    }
}

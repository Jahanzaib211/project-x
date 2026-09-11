//! # 04-account — accounts, and what they may do
//!
//! ## This type has no balance field
//!
//! That is the module's entire design. A [`TradingAccount`] is identity,
//! configuration and lifecycle state; the money is in the ledger. There is no
//! `balance` to set, so INV-031 — *no balance mutation exists without a ledger
//! transaction* — is not a rule anyone has to remember. There is nothing to
//! mutate.
//!
//! Consequently every function here that talks about money takes it as an
//! argument, read from `03-ledger` at the moment of asking, and returns a
//! derived figure. Nothing is cached, because a cached balance is a second
//! source of truth (P2).
//!
//! ## The three laws
//!
//! - **INV-030** — `available == balance − reservations − used margin`, and it
//!   only goes negative alongside an explicit deficit, never silently.
//! - **INV-031** — see above: structurally impossible to break.
//! - **INV-032** — a frozen or closed account originates no financial effects.
//!   [`TradingAccount::may_originate`] is the single predicate, and risk,
//!   execution and funding all ask it rather than each testing status
//!   themselves.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use domain_kernel::{Money, MoneyError, Usd};
use event_kernel::Id;
use ledger_core::{client_cash, demo_capital, AccountError, Entry, Transaction, TransactionKind};

/// Why an account operation was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountOpError {
    /// The account number was not well-formed.
    BadAccountNumber,
    /// The account is not in a state that permits this (INV-032).
    NotPermitted {
        /// The status that refused.
        status: Status,
    },
    /// A demo credit was requested for a real-money account, or vice versa.
    WrongMode,
    /// The amount was zero or negative.
    NonPositiveAmount,
    /// A demo top-up would take the account past [`DEMO_CAP_MINOR`].
    ExceedsDemoCap {
        /// What the account would have held, in minor units.
        would_hold: i128,
    },
    /// The account has open positions, and the operation needs it flat.
    PositionsOpen,
    /// The status change is not a legal transition.
    IllegalTransition {
        /// Where the account is.
        from: Status,
        /// Where it was asked to go.
        to: Status,
    },
    /// The chart of accounts refused a name.
    Ledger(AccountError),
    /// Arithmetic was not representable.
    Arithmetic(MoneyError),
}

impl core::fmt::Display for AccountOpError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::BadAccountNumber => f.write_str("account number is not well-formed"),
            Self::NotPermitted { status } => {
                write!(f, "an account that is {} cannot do that", status.name())
            }
            Self::WrongMode => f.write_str("that operation does not apply to this account mode"),
            Self::NonPositiveAmount => f.write_str("the amount must be positive"),
            Self::ExceedsDemoCap { would_hold } => write!(
                f,
                "a demo account may hold at most {} USD; this would leave it holding {}",
                Money::<Usd>::from_minor(DEMO_CAP_MINOR).to_decimal_string(),
                Money::<Usd>::from_minor(*would_hold).to_decimal_string()
            ),
            Self::PositionsOpen => f.write_str("close every open position first"),
            Self::IllegalTransition { from, to } => {
                write!(
                    f,
                    "an account that is {} cannot become {}",
                    from.name(),
                    to.name()
                )
            }
            Self::Ledger(err) => write!(f, "{err}"),
            Self::Arithmetic(err) => write!(f, "arithmetic: {err}"),
        }
    }
}

impl From<AccountError> for AccountOpError {
    fn from(err: AccountError) -> Self {
        Self::Ledger(err)
    }
}

impl From<MoneyError> for AccountOpError {
    fn from(err: MoneyError) -> Self {
        Self::Arithmetic(err)
    }
}

/// Whether an account trades real money or demo capital.
///
/// A type, not a boolean flag on a shared record, because "is this real money"
/// is the single most consequential question about an account and it should
/// never be a field someone can forget to check.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Demo capital. No payment rail is ever involved.
    Demo,
    /// Real client funds.
    Real,
}

impl Mode {
    /// The wire name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Demo => "demo",
            Self::Real => "real",
        }
    }

    /// Parse from the wire name.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "demo" => Some(Self::Demo),
            "real" => Some(Self::Real),
            _ => None,
        }
    }
}

/// Account lifecycle state.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// Trading normally.
    Active,
    /// Temporarily blocked: no new financial effects, existing positions stand.
    Frozen,
    /// Permanently closed.
    Closed,
}

impl Status {
    /// The wire name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Frozen => "frozen",
            Self::Closed => "closed",
        }
    }

    /// Parse from the wire name.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "active" => Some(Self::Active),
            "frozen" => Some(Self::Frozen),
            "closed" => Some(Self::Closed),
            _ => None,
        }
    }

    /// Whether an account in this state may move to `next`.
    ///
    /// Active and frozen are two sides of one switch; closed is terminal. A
    /// closed account that could be reopened would be an account whose history
    /// has a hole in it.
    #[must_use]
    pub const fn may_become(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Active, Self::Frozen | Self::Closed)
                | (Self::Frozen, Self::Active | Self::Closed)
        )
    }
}

/// A trading account.
///
/// Note what is absent: no balance, no equity, no margin, no P&L. Those are
/// read from `03-ledger` and computed by `08-pnl-margin` at the moment of
/// asking (INV-031, INV-184).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradingAccount {
    /// The account number clients see.
    pub number: String,
    /// Who owns it.
    pub owner: String,
    /// Real or demo.
    pub mode: Mode,
    /// Denomination. USD throughout this build.
    pub currency: &'static str,
    /// Leverage cap chosen at opening.
    pub leverage: i128,
    /// Lifecycle state.
    pub status: Status,
    /// The market tick it was opened on.
    pub opened_tick: u64,
    /// A client-friendly label.
    pub nickname: String,
}

impl TradingAccount {
    /// Whether this account may originate a new financial effect (INV-032).
    ///
    /// One predicate, asked by risk, execution and funding alike. Three
    /// separate status checks would be three places to forget a state.
    #[must_use]
    pub const fn may_originate(&self) -> bool {
        matches!(self.status, Status::Active)
    }

    /// Move the account to `next`, if that is a legal transition.
    ///
    /// # Errors
    /// [`AccountOpError::IllegalTransition`] otherwise — including the no-op
    /// case, so a caller that asked for nothing is told nothing happened.
    pub fn set_status(&mut self, next: Status) -> Result<(), AccountOpError> {
        if !self.status.may_become(next) {
            return Err(AccountOpError::IllegalTransition {
                from: self.status,
                to: next,
            });
        }
        self.status = next;
        Ok(())
    }

    /// Available balance: what may be committed to something new.
    ///
    /// INV-030, written as the definition. `reservations` are amounts already
    /// promised elsewhere — a pending withdrawal, say — and `used_margin` is
    /// what open positions hold.
    ///
    /// The result may be negative, and that is deliberate: an account whose
    /// positions moved against it genuinely has less than nothing available,
    /// and clamping to zero would hide it from exactly the report that needs to
    /// see it.
    ///
    /// # Errors
    /// [`AccountOpError::Arithmetic`] if the subtraction is not representable.
    pub fn available(
        &self,
        balance: Money<Usd>,
        reservations: Money<Usd>,
        used_margin: Money<Usd>,
    ) -> Result<Money<Usd>, AccountOpError> {
        Ok(balance.sub(reservations)?.sub(used_margin)?)
    }
}

/// The demo capital every new demo account is issued.
pub const DEMO_GRANT_MINOR: i128 = 1_000_000; // 10 000.00 USD

/// Open a demo account and issue its capital, as one transaction.
///
/// Returns the account and the single balanced transaction that funds it. The
/// caller posts the transaction; this function does not, because posting is the
/// ledger's job and a function that both decides and posts is a function that
/// can post without deciding.
///
/// # Errors
/// [`AccountOpError`] if the number is malformed or the grant is non-positive.
pub fn open_demo(
    number: &str,
    owner: &str,
    nickname: &str,
    leverage: i128,
    opened_tick: u64,
    transaction_id: Id,
    grant_minor: i128,
) -> Result<(TradingAccount, Transaction), AccountOpError> {
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AccountOpError::BadAccountNumber);
    }
    if grant_minor <= 0 {
        return Err(AccountOpError::NonPositiveAmount);
    }

    let account = TradingAccount {
        number: number.to_owned(),
        owner: owner.to_owned(),
        mode: Mode::Demo,
        currency: "USD",
        leverage,
        status: Status::Active,
        opened_tick,
        nickname: nickname.to_owned(),
    };

    let grant = Money::<Usd>::from_minor(grant_minor).erase();
    // Demo money is issued against equity: nothing was received, so no asset
    // may be recognised. The pot is drawn down, which makes the total demo
    // capital in circulation readable straight off the ledger.
    let transaction = Transaction::balanced(
        transaction_id,
        TransactionKind::DemoCredit,
        Some(number.to_owned()),
        vec![
            Entry::debit(demo_capital()?, grant),
            Entry::credit(client_cash(number)?, grant)?,
        ],
    )
    .map_err(|_| AccountOpError::Arithmetic(MoneyError::Overflow))?;

    Ok((account, transaction))
}

/// The most demo capital one account may hold, in minor units.
///
/// A cap rather than "unlimited" because the demo pot is read straight off the
/// ledger as the total in circulation, and an unbounded top-up would let one
/// client make that figure meaningless (INV-034).
pub const DEMO_CAP_MINOR: i128 = 100_000_000; // 1 000 000.00 USD

/// Open a real-money account.
///
/// No transaction accompanies it: nothing was received, so nothing is posted.
/// The account exists and holds nothing until `17-payments` puts something in
/// it, which is the honest state of a real account that has not been funded.
///
/// # Errors
/// [`AccountOpError::BadAccountNumber`] if the number is malformed.
pub fn open_real(
    number: &str,
    owner: &str,
    nickname: &str,
    leverage: i128,
    opened_tick: u64,
) -> Result<TradingAccount, AccountOpError> {
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AccountOpError::BadAccountNumber);
    }
    Ok(TradingAccount {
        number: number.to_owned(),
        owner: owner.to_owned(),
        mode: Mode::Real,
        currency: "USD",
        leverage,
        status: Status::Active,
        opened_tick,
        nickname: nickname.to_owned(),
    })
}

/// Issue more demo capital to an existing demo account.
///
/// `balance_minor` is the account's ledger balance at the moment of asking,
/// passed in rather than looked up (this crate holds no balance — INV-031).
///
/// # Errors
/// - [`AccountOpError::WrongMode`] — the account is real. Demo capital is
///   never issued to a real account, whatever the caller says (INV-034).
/// - [`AccountOpError::NotPermitted`] — the account is frozen or closed.
/// - [`AccountOpError::NonPositiveAmount`], [`AccountOpError::ExceedsDemoCap`].
pub fn top_up_demo(
    account: &TradingAccount,
    balance_minor: i128,
    amount_minor: i128,
    transaction_id: Id,
) -> Result<Transaction, AccountOpError> {
    if account.mode != Mode::Demo {
        return Err(AccountOpError::WrongMode);
    }
    if !account.may_originate() {
        return Err(AccountOpError::NotPermitted {
            status: account.status,
        });
    }
    if amount_minor <= 0 {
        return Err(AccountOpError::NonPositiveAmount);
    }
    let would_hold = balance_minor
        .checked_add(amount_minor)
        .ok_or(AccountOpError::Arithmetic(MoneyError::Overflow))?;
    if would_hold > DEMO_CAP_MINOR {
        return Err(AccountOpError::ExceedsDemoCap { would_hold });
    }

    let grant = Money::<Usd>::from_minor(amount_minor).erase();
    Transaction::balanced(
        transaction_id,
        TransactionKind::DemoCredit,
        Some(account.number.clone()),
        vec![
            Entry::debit(demo_capital()?, grant),
            Entry::credit(client_cash(&account.number)?, grant)?,
        ],
    )
    .map_err(|_| AccountOpError::Arithmetic(MoneyError::Overflow))
}

/// Put a demo account back to its opening grant.
///
/// Returns the correcting transaction, or `None` when the balance is already
/// exactly the grant and there is nothing to post. Refused while positions are
/// open: resetting cash underneath a position would change its margin without
/// a deal, which is a balance moving without a financial effect (INV-035).
///
/// # Errors
/// [`AccountOpError::WrongMode`], [`AccountOpError::NotPermitted`],
/// [`AccountOpError::PositionsOpen`].
pub fn reset_demo(
    account: &TradingAccount,
    balance_minor: i128,
    open_positions: usize,
    transaction_id: Id,
) -> Result<Option<Transaction>, AccountOpError> {
    if account.mode != Mode::Demo {
        return Err(AccountOpError::WrongMode);
    }
    if !account.may_originate() {
        return Err(AccountOpError::NotPermitted {
            status: account.status,
        });
    }
    if open_positions > 0 {
        return Err(AccountOpError::PositionsOpen);
    }
    let difference = DEMO_GRANT_MINOR
        .checked_sub(balance_minor)
        .ok_or(AccountOpError::Arithmetic(MoneyError::Overflow))?;
    if difference == 0 {
        return Ok(None);
    }
    let amount = Money::<Usd>::from_minor(difference.abs()).erase();
    // Short of the grant: draw the shortfall from the pot. Over it: hand the
    // surplus back. Either way the pot still reads as demo capital in
    // circulation, exactly.
    let entries = if difference > 0 {
        vec![
            Entry::debit(demo_capital()?, amount),
            Entry::credit(client_cash(&account.number)?, amount)?,
        ]
    } else {
        vec![
            Entry::debit(client_cash(&account.number)?, amount),
            Entry::credit(demo_capital()?, amount)?,
        ]
    };
    Transaction::balanced(
        transaction_id,
        TransactionKind::Correction,
        Some(account.number.clone()),
        entries,
    )
    .map(Some)
    .map_err(|_| AccountOpError::Arithmetic(MoneyError::Overflow))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use ledger_core::{Balances, Journal};

    fn usd(decimal: &str) -> Money<Usd> {
        Money::from_decimal_str(decimal).unwrap()
    }

    fn account(status: Status) -> TradingAccount {
        TradingAccount {
            number: "50000001".to_owned(),
            owner: "dev-owner-0001".to_owned(),
            mode: Mode::Demo,
            currency: "USD",
            leverage: 500,
            status,
            opened_tick: 1_000,
            nickname: "Demo".to_owned(),
        }
    }

    /// INV-030 — available is balance less what is already committed.
    #[test]
    fn inv_030_available_is_balance_less_reservations_and_margin() {
        let account = account(Status::Active);
        let available = account
            .available(usd("10000.00"), usd("250.00"), usd("1391.00"))
            .unwrap();
        assert_eq!(available.to_decimal_string(), "8359.00");
    }

    /// INV-030's second half: it may go negative, and it must not be clamped.
    #[test]
    fn inv_030_available_goes_negative_rather_than_being_hidden() {
        let account = account(Status::Active);
        let available = account
            .available(usd("100.00"), usd("0.00"), usd("217.00"))
            .unwrap();
        assert_eq!(available.to_decimal_string(), "-117.00");
        assert!(available.minor() < 0);
    }

    /// INV-031 — there is no balance to mutate. This test documents the
    /// mechanism: the only way an account's money changes is a ledger
    /// transaction, and the account type carries no figure that could drift
    /// from it.
    #[test]
    fn inv_031_money_moves_only_through_a_ledger_transaction() {
        let (account, transaction) = open_demo(
            "50000001",
            "dev-owner-0001",
            "Demo",
            500,
            1_000,
            Id(1),
            DEMO_GRANT_MINOR,
        )
        .unwrap();

        let mut journal = Journal::new();
        journal.append(transaction).unwrap();
        let balances = Balances::from_journal(&journal).unwrap();

        let cash = client_cash(&account.number).unwrap();
        let balance = balances.natural(&cash, "USD").unwrap();
        assert_eq!(
            balance.typed::<Usd>().unwrap().to_decimal_string(),
            "10000.00"
        );
        // The grant came out of the demo capital pot, not out of nowhere.
        assert_eq!(
            balances
                .natural(&demo_capital().unwrap(), "USD")
                .unwrap()
                .minor,
            -DEMO_GRANT_MINOR
        );
        assert!(balances.is_balanced());
    }

    /// INV-032 — a frozen or closed account originates nothing.
    #[test]
    fn inv_032_only_an_active_account_may_originate_financial_effects() {
        assert!(account(Status::Active).may_originate());
        assert!(!account(Status::Frozen).may_originate());
        assert!(!account(Status::Closed).may_originate());
    }

    #[test]
    fn a_demo_account_opens_active_in_demo_mode() {
        let (account, _) = open_demo(
            "50000007",
            "owner",
            "My demo",
            200,
            42,
            Id(9),
            DEMO_GRANT_MINOR,
        )
        .unwrap();
        assert_eq!(account.mode, Mode::Demo);
        assert_eq!(account.status, Status::Active);
        assert_eq!(account.currency, "USD");
        assert_eq!(account.leverage, 200);
        assert_eq!(account.opened_tick, 42);
        assert!(account.may_originate());
    }

    #[test]
    fn the_funding_transaction_balances_and_names_its_account() {
        let (_, transaction) =
            open_demo("50000001", "owner", "Demo", 500, 1, Id(3), DEMO_GRANT_MINOR).unwrap();
        assert_eq!(transaction.kind(), TransactionKind::DemoCredit);
        assert_eq!(transaction.subject(), Some("50000001"));
        assert_eq!(transaction.debits("USD"), transaction.credits("USD"));
        assert_eq!(transaction.debits("USD"), DEMO_GRANT_MINOR);
        assert_eq!(transaction.entries().len(), 2);
    }

    #[test]
    fn malformed_openings_are_refused() {
        let bad_number = open_demo("", "o", "n", 500, 1, Id(1), DEMO_GRANT_MINOR);
        assert_eq!(bad_number.unwrap_err(), AccountOpError::BadAccountNumber);

        let injected = open_demo("500; drop", "o", "n", 500, 1, Id(1), DEMO_GRANT_MINOR);
        assert_eq!(injected.unwrap_err(), AccountOpError::BadAccountNumber);

        let free = open_demo("50000001", "o", "n", 500, 1, Id(1), 0);
        assert_eq!(free.unwrap_err(), AccountOpError::NonPositiveAmount);
    }

    #[test]
    fn modes_round_trip_through_their_wire_names() {
        for mode in [Mode::Demo, Mode::Real] {
            assert_eq!(Mode::parse(mode.name()), Some(mode));
        }
        assert_eq!(Mode::parse("paper"), None);
    }

    /// INV-033 — a real account opens with nothing and posts nothing: there is
    /// no transaction to attach, because nothing was received.
    #[test]
    fn inv_033_a_real_account_opens_unfunded_and_active() {
        let account = open_real("50000009", "owner", "Savings", 100, 7).unwrap();
        assert_eq!(account.mode, Mode::Real);
        assert_eq!(account.status, Status::Active);
        assert!(account.may_originate());
        assert!(open_real("", "owner", "x", 100, 7).is_err());
        assert!(open_real("5000x", "owner", "x", 100, 7).is_err());
    }

    /// INV-034 — demo capital goes only to demo accounts, only while active,
    /// and never past the cap.
    #[test]
    fn inv_034_demo_top_ups_are_bounded_and_demo_only() {
        let demo = account(Status::Active);
        let top_up = top_up_demo(&demo, DEMO_GRANT_MINOR, 500_000, Id(9)).unwrap();
        assert_eq!(top_up.kind(), TransactionKind::DemoCredit);
        assert_eq!(top_up.credits("USD"), 500_000);
        assert_eq!(top_up.subject(), Some("50000001"));

        let real = open_real("50000002", "owner", "Real", 100, 1).unwrap();
        assert_eq!(
            top_up_demo(&real, 0, 100, Id(10)),
            Err(AccountOpError::WrongMode)
        );
        assert!(matches!(
            top_up_demo(&account(Status::Frozen), 0, 100, Id(11)),
            Err(AccountOpError::NotPermitted { .. })
        ));
        assert_eq!(
            top_up_demo(&demo, 0, 0, Id(12)),
            Err(AccountOpError::NonPositiveAmount)
        );
        assert!(matches!(
            top_up_demo(&demo, DEMO_CAP_MINOR - 1, 2, Id(13)),
            Err(AccountOpError::ExceedsDemoCap { would_hold }) if would_hold == DEMO_CAP_MINOR + 1
        ));
        // Exactly at the cap is allowed; it is a cap, not a ceiling below it.
        assert!(top_up_demo(&demo, DEMO_CAP_MINOR - 2, 2, Id(14)).is_ok());
    }

    /// INV-035 — a reset is a correction back to the grant, only when flat,
    /// and a no-op when already there.
    #[test]
    fn inv_035_a_reset_corrects_to_the_grant_only_when_flat() {
        let demo = account(Status::Active);
        let short = reset_demo(&demo, 400_000, 0, Id(20)).unwrap().unwrap();
        assert_eq!(short.kind(), TransactionKind::Correction);
        assert_eq!(short.credits("USD"), DEMO_GRANT_MINOR - 400_000);
        let cash = client_cash("50000001").unwrap();
        assert!(short
            .entries()
            .iter()
            .any(|e| e.account == cash && !e.is_debit()));

        let over = reset_demo(&demo, 1_500_000, 0, Id(21)).unwrap().unwrap();
        assert_eq!(over.debits("USD"), 500_000);
        assert!(over
            .entries()
            .iter()
            .any(|e| e.account == cash && e.is_debit()));

        assert_eq!(
            reset_demo(&demo, DEMO_GRANT_MINOR, 0, Id(22)).unwrap(),
            None
        );
        assert_eq!(
            reset_demo(&demo, 0, 1, Id(23)),
            Err(AccountOpError::PositionsOpen)
        );
        let real = open_real("50000002", "owner", "Real", 100, 1).unwrap();
        assert_eq!(
            reset_demo(&real, 0, 0, Id(24)),
            Err(AccountOpError::WrongMode)
        );
    }

    /// INV-032's lifecycle: active and frozen swap; closed is final.
    #[test]
    fn status_transitions_are_a_switch_with_a_terminal_state() {
        let mut demo = account(Status::Active);
        demo.set_status(Status::Frozen).unwrap();
        assert!(!demo.may_originate());
        demo.set_status(Status::Active).unwrap();
        assert!(demo.may_originate());
        assert!(
            demo.set_status(Status::Active).is_err(),
            "a no-op is reported"
        );
        demo.set_status(Status::Closed).unwrap();
        assert!(demo.set_status(Status::Active).is_err());
        assert!(demo.set_status(Status::Frozen).is_err());
        for status in [Status::Active, Status::Frozen, Status::Closed] {
            assert_eq!(Status::parse(status.name()), Some(status));
        }
        assert_eq!(Status::parse("paused"), None);
    }
}

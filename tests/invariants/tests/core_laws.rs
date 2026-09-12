//! G3/G4 — the laws of the financial core, over generated trading histories.
//!
//! The core is one fold: value the account (08), check it (09), book the
//! fill (05), post the entries (03, 11), under one lock, for one account
//! (04). These properties drive that fold — the real `ledger::state::Core`,
//! not a model — with thousands of generated order sequences: random
//! instruments, sides, sizes (in and out of bounds), ticks (open and closed
//! sessions), freezes and top-ups. After *every* step the laws must hold,
//! not only at the end (that is what G4 asks for), and the same seed must
//! produce the same core twice (INV-080, INV-104).
//!
//! Every failure prints its seed; `PROPTEST_SEED=<seed>` reproduces it.

#![allow(
    clippy::unwrap_used,
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing
)]

use account_core::Status;
use domain_kernel::quantity::Side;
use invariants::{for_all, Gen};
use ledger::quotes::QuoteSet;
use ledger::state::{Core, CoreError};
use market_core::instrument::INSTRUMENTS;
use market_core::session::is_open;
use risk_core::Rejection;

// 1970-01-05 10:00 UTC, a Monday: every session is open for the day.
const OPEN: u64 = 1_526_400;
// 1970-01-10 12:00 UTC, a Saturday: FX and metals closed, crypto open.
const SATURDAY: u64 = (9 * 86_400_000 + 12 * 3_600_000) / market_core::TICK_MS;

/// One generated step of a trading history.
#[derive(Clone, Debug)]
enum Step {
    Order {
        instrument: usize,
        side: Side,
        milli: i128,
        tick: u64,
    },
    Close {
        instrument: usize,
        tick: u64,
    },
    Freeze,
    Thaw,
    TopUp(i128),
}

fn step(g: &mut Gen, tick: &mut u64) -> Step {
    // Time only moves forward; sometimes into a closed session.
    *tick += g.in_range(0, 400) as u64;
    match g.in_range(0, 11) {
        0 => Step::Freeze,
        1 => Step::Thaw,
        2 => Step::TopUp(g.in_range(-10_000, 5_000_000)),
        3 | 4 => Step::Close {
            instrument: g.in_range(0, INSTRUMENTS.len() as i128 - 1) as usize,
            tick: *tick,
        },
        _ => {
            let instrument = g.in_range(0, INSTRUMENTS.len() as i128 - 1) as usize;
            let spec = &INSTRUMENTS[instrument];
            // Mostly plausible sizes, sometimes below the minimum or above the maximum.
            let milli = match g.in_range(0, 9) {
                0 => g.in_range(0, spec.min_volume_milli_lots - 1),
                1 => spec.max_volume_milli_lots + g.in_range(1, 5_000),
                _ => g.in_range(spec.min_volume_milli_lots, spec.min_volume_milli_lots * 40),
            };
            let tick = if g.in_range(0, 7) == 0 {
                SATURDAY + *tick - OPEN
            } else {
                *tick
            };
            Step::Order {
                instrument,
                side: if g.in_range(0, 1) == 0 {
                    Side::Buy
                } else {
                    Side::Sell
                },
                milli,
                tick,
            }
        }
    }
}

/// Apply one step to a core, returning what happened.
fn apply(
    core: &mut Core,
    account: &str,
    step: &Step,
    n: usize,
) -> Result<Option<CoreError>, String> {
    let key = |label: &str| format!("law-{label}-{n:06}");
    match step {
        Step::Order {
            instrument,
            side,
            milli,
            tick,
        } => {
            let symbol = INSTRUMENTS[*instrument].symbol;
            let quotes = QuoteSet::synthetic(*tick);
            match core.place_order(
                account,
                symbol,
                *side,
                *milli,
                *tick,
                &quotes,
                &key("order"),
            ) {
                Ok(_) => Ok(None),
                Err(err @ CoreError::Refused(_)) => Ok(Some(err)),
                Err(err) => Err(format!("order failed for a non-risk reason: {err}")),
            }
        }
        Step::Close { instrument, tick } => {
            let symbol = INSTRUMENTS[*instrument].symbol;
            let quotes = QuoteSet::synthetic(*tick);
            match core.close_position(account, symbol, *tick, &quotes, &key("close")) {
                Ok(_) => Ok(None),
                Err(err @ (CoreError::Refused(_) | CoreError::NothingToClose)) => Ok(Some(err)),
                Err(err) => Err(format!("close failed for a non-risk reason: {err}")),
            }
        }
        Step::Freeze => match core.set_account_status(account, Status::Frozen) {
            Ok(_) | Err(CoreError::Account(_)) => Ok(None),
            Err(err) => Err(format!("freeze failed: {err}")),
        },
        Step::Thaw => match core.set_account_status(account, Status::Active) {
            Ok(_) | Err(CoreError::Account(_)) => Ok(None),
            Err(err) => Err(format!("thaw failed: {err}")),
        },
        Step::TopUp(minor) => match core.credit_demo(account, *minor, &key("credit")) {
            Ok(_) => Ok(None),
            Err(err @ CoreError::Account(_)) => Ok(Some(err)),
            Err(err) => Err(format!("credit failed for a non-account reason: {err}")),
        },
    }
}

/// The laws that must hold after every step.
fn laws(core: &Core, account: &str, tick: u64, at: &str) -> Result<(), String> {
    // INV-020 / INV-023 — the book balances and the projection is the journal.
    if core.imbalanced_transactions() != 0 {
        return Err(format!(
            "{at}: INV-020 an unbalanced transaction was posted"
        ));
    }
    if core.projection_drift() != 0 {
        return Err(format!(
            "{at}: INV-023 the balance projection drifted from the journal"
        ));
    }
    let valuation = core
        .valuation(account, &QuoteSet::synthetic(tick))
        .map_err(|err| format!("{at}: could not value: {err}"))?;
    // INV-070 — equity is balance plus unrealised, exactly.
    let equity = valuation
        .balance
        .add(valuation.unrealised)
        .map_err(|e| format!("{at}: {e}"))?;
    if equity != valuation.equity {
        return Err(format!(
            "{at}: INV-070 equity {} != balance {} + unrealised {}",
            valuation.equity, valuation.balance, valuation.unrealised
        ));
    }
    // INV-030 — free margin is equity less used margin.
    let free = valuation
        .equity
        .sub(valuation.used_margin)
        .map_err(|e| format!("{at}: {e}"))?;
    if free != valuation.free_margin {
        return Err(format!(
            "{at}: INV-030 free margin is not equity less used margin"
        ));
    }
    // INV-072 — a margin level exists exactly when something is open.
    if valuation.margin_level_bp.is_some() != !valuation.positions.is_empty() {
        return Err(format!(
            "{at}: INV-072 margin level present/absent disagrees with open positions"
        ));
    }
    // INV-101 — every deal posted exactly one transaction, and it is in the
    // journal under the deal's own id; INV-082 — every order, filled or
    // refused, is on record.
    for order in core.all_orders() {
        if let Some(deal) = &order.deal {
            if !core.journal().contains(deal.ids.transaction_id) {
                return Err(format!(
                    "{at}: INV-101 deal {} has no transaction in the journal",
                    deal.ids.deal_id
                ));
            }
        } else if order.rejection.is_none() {
            return Err(format!(
                "{at}: INV-082 order {} is neither filled nor refused",
                order.order_id
            ));
        }
    }
    Ok(())
}

/// INV-020/023/030/070/072/082/101 hold after every step of any history,
/// and a refused order books nothing.
#[test]
fn inv_020_the_core_holds_its_laws_after_every_step() {
    for_all("core laws after every step", 400, 0xC04E, |g| {
        let mut core = Core::in_memory();
        let account = core
            .open_account("law", "Law", 500, account_core::Mode::Demo, OPEN)
            .unwrap()
            .number;
        let mut tick = OPEN;
        let steps = g.small_count() as usize + 5;
        for n in 0..steps {
            let s = step(g, &mut tick);
            let before = core.journal().len();
            let outcome = apply(&mut core, &account, &s, n)?;
            if outcome.is_some() && core.journal().len() != before {
                return Err(format!("step {n} {s:?}: a refusal posted a transaction"));
            }
            laws(&core, &account, tick, &format!("step {n} {s:?}"))?;
        }
        Ok(())
    });
}

/// INV-084 — on a closed session every order is refused as MARKET_CLOSED,
/// whatever the account holds; INV-032 — while frozen, everything is refused
/// as ACCOUNT_NOT_TRADABLE, and the freeze is the reason given first.
#[test]
fn inv_084_closed_sessions_and_inv_032_frozen_accounts_refuse_everything() {
    for_all("closed and frozen refusals", 600, 0x0832, |g| {
        let mut core = Core::in_memory();
        let account = core
            .open_account("law", "Law", 500, account_core::Mode::Demo, OPEN)
            .unwrap()
            .number;
        let instrument = &INSTRUMENTS[g.in_range(0, INSTRUMENTS.len() as i128 - 1) as usize];
        let milli = g.in_range(
            instrument.min_volume_milli_lots,
            instrument.min_volume_milli_lots * 5,
        );
        let side = if g.in_range(0, 1) == 0 {
            Side::Buy
        } else {
            Side::Sell
        };

        let closed_tick = SATURDAY + g.in_range(0, 100_000) as u64;
        let quotes = QuoteSet::synthetic(closed_tick);
        let outcome = core.place_order(
            &account,
            instrument.symbol,
            side,
            milli,
            closed_tick,
            &quotes,
            "closed-000001",
        );
        if is_open(instrument.session, closed_tick) {
            if !outcome.is_ok() {
                return Err(format!(
                    "{} is open on a Saturday but the order was refused: {outcome:?}",
                    instrument.symbol
                ));
            }
        } else if !matches!(outcome, Err(CoreError::Refused(Rejection::MarketClosed))) {
            return Err(format!(
                "{} is closed but the order was not refused as MARKET_CLOSED: {outcome:?}",
                instrument.symbol
            ));
        }

        core.set_account_status(&account, Status::Frozen).unwrap();
        let open_tick = OPEN + g.in_range(0, 1_000) as u64;
        let quotes = QuoteSet::synthetic(open_tick);
        let frozen = core.place_order(
            &account,
            instrument.symbol,
            side,
            milli,
            open_tick,
            &quotes,
            "frozen-000001",
        );
        if !matches!(
            frozen,
            Err(CoreError::Refused(Rejection::AccountNotTradable))
        ) {
            return Err(format!(
                "a frozen account was not refused as ACCOUNT_NOT_TRADABLE: {frozen:?}"
            ));
        }
        if core.credit_demo(&account, 100, "frozen-credit-1").is_ok() {
            return Err("a frozen account accepted demo capital".into());
        }
        Ok(())
    });
}

/// INV-080 / INV-104 — the same history produces the same core: every
/// decision, fill, id and balance, twice, from the same seed.
#[test]
fn inv_080_the_same_history_produces_the_same_core() {
    for_all("determinism", 150, 0x0800, |g| {
        let mut tick = OPEN;
        let steps: Vec<Step> = (0..g.small_count() as usize + 5)
            .map(|_| step(g, &mut tick))
            .collect();
        let run = |steps: &[Step]| -> Result<String, String> {
            let mut core = Core::in_memory();
            let account = core
                .open_account("law", "Law", 500, account_core::Mode::Demo, OPEN)
                .unwrap()
                .number;
            for (n, s) in steps.iter().enumerate() {
                apply(&mut core, &account, s, n)?;
            }
            let orders: Vec<String> = core
                .all_orders()
                .iter()
                .map(|o| {
                    format!(
                        "{}:{}:{:?}:{:?}",
                        o.order_id,
                        o.state(),
                        o.deal.as_ref().map(|d| (d.price.raw(), d.realised.minor())),
                        o.rejection.map(|r| r.code())
                    )
                })
                .collect();
            let journal: Vec<String> = core
                .journal()
                .transactions()
                .iter()
                .map(|t| format!("{:?}", t))
                .collect();
            Ok(format!(
                "{orders:?}|{journal:?}|{:?}",
                core.balance_of(&account).map(|m| m.minor())
            ))
        };
        let first = run(&steps)?;
        let second = run(&steps)?;
        if first != second {
            return Err("two runs of one history diverged".into());
        }
        Ok(())
    });
}

/// INV-040..043 — the book nets per symbol: after any history the position's
/// signed quantity equals the sum of the signed fills that touched it, and
/// closing everything leaves the book empty with the ledger still balanced.
#[test]
fn inv_040_positions_are_the_net_of_their_fills_and_close_to_flat() {
    for_all("position netting", 300, 0x0400, |g| {
        let mut core = Core::in_memory();
        let account = core
            .open_account("law", "Law", 500, account_core::Mode::Demo, OPEN)
            .unwrap()
            .number;
        let instrument = &INSTRUMENTS[g.in_range(0, 2) as usize]; // majors: cheap margin
        let mut expected: i128 = 0;
        let mut tick = OPEN;
        for n in 0..g.small_count() as usize + 3 {
            tick += g.in_range(1, 50) as u64;
            let side = if g.in_range(0, 1) == 0 {
                Side::Buy
            } else {
                Side::Sell
            };
            let milli = g.in_range(
                instrument.min_volume_milli_lots,
                instrument.min_volume_milli_lots * 20,
            );
            let quotes = QuoteSet::synthetic(tick);
            if core
                .place_order(
                    &account,
                    instrument.symbol,
                    side,
                    milli,
                    tick,
                    &quotes,
                    &format!("net-{n:06}"),
                )
                .is_ok()
            {
                expected += if side == Side::Buy { milli } else { -milli };
            }
            let valuation = core.valuation(&account, &quotes).unwrap();
            let held: i128 = valuation
                .positions
                .iter()
                .filter(|p| p.position.symbol == instrument.symbol)
                .map(|p| {
                    let milli: i128 = ledger::volume::milli_lots(&ledger::volume::to_lots_text(
                        p.position.quantity,
                        instrument,
                    ))
                    .unwrap();
                    if p.position.side == Side::Buy {
                        milli
                    } else {
                        -milli
                    }
                })
                .sum();
            if held != expected {
                return Err(format!(
                    "step {n}: book holds {held} milli-lots, fills net to {expected}"
                ));
            }
        }
        if expected != 0 {
            tick += 1;
            let quotes = QuoteSet::synthetic(tick);
            core.close_position(&account, instrument.symbol, tick, &quotes, "net-close-0001")
                .map_err(|e| format!("close failed: {e}"))?;
        }
        if core.open_position_count(&account) != 0 {
            return Err("closing everything left a position".into());
        }
        if core.imbalanced_transactions() != 0 || core.projection_drift() != 0 {
            return Err("the ledger is not balanced after closing out".into());
        }
        Ok(())
    });
}

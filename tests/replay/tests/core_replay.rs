//! G6 — the financial core replays from its journal, exactly.
//!
//! A scripted, seeded trading history is written through the real
//! `ledger::state::Core` to a journal on disk — accounts of both modes, demo
//! credits, fills at pinned ticks, closes, a freeze — and the core is then
//! reopened from that file alone. Everything it holds must match: balances,
//! positions, average prices, orders, ids, the next id it would issue.
//!
//! The digest is printed as `state_hash=<hex>`; CI runs this binary twice in
//! separate processes and diffs the hashes, so an address- or allocation-
//! order-dependent fold is caught even when a single process agrees with
//! itself. This is the G6 claim for 03-ledger and for everything it hosts —
//! 04-account, 05-position, 08-pnl-margin, 09-risk and 11-execution — and for
//! the OMS lifecycle folded from a recorded walk.

#![allow(
    clippy::arithmetic_side_effects,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing
)]

use std::path::PathBuf;

use account_core::{Mode, Status};
use domain_kernel::quantity::Side;
use invariants::Gen;
use ledger::quotes::QuoteSet;
use ledger::state::Core;
use market_core::instrument::INSTRUMENTS;
use oms::lifecycle::{Lifecycle, OrderState};

// 1970-01-05 10:00 UTC, a Monday: every session is open.
const OPEN: u64 = 1_526_400;

struct Scratch(PathBuf);
impl Scratch {
    fn new(name: &str) -> Self {
        let mut path = std::env::temp_dir();
        path.push(format!("projectx-replay-{name}-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// FNV-1a over a string. Deliberately not `DefaultHasher`, whose output may
/// change between Rust versions; a replay digest has to mean the same thing
/// next year.
fn fnv(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

/// Everything observable about a core, as one canonical string.
fn snapshot(core: &Core, accounts: &[String], tick: u64) -> String {
    let mut out = String::new();
    for account in accounts {
        let a = core.account(account).unwrap();
        out.push_str(&format!(
            "account {} {} {:?} lev={} status={:?} balance={:?}\n",
            a.number,
            a.owner,
            a.mode,
            a.leverage,
            a.status,
            core.balance_of(account).map(|m| m.minor())
        ));
        if let Ok(v) = core.valuation(account, &QuoteSet::synthetic(tick)) {
            out.push_str(&format!(
                "  equity={} unrealised={} used={} free={} level={:?}\n",
                v.equity, v.unrealised, v.used_margin, v.free_margin, v.margin_level_bp
            ));
            for p in &v.positions {
                out.push_str(&format!(
                    "  position {} {:?} qty={} avg={} opened={} last={}\n",
                    p.position.symbol,
                    p.position.side,
                    p.position.quantity.raw(),
                    p.position.average_price.raw(),
                    p.position.opened_tick,
                    p.position.last_event.0
                ));
            }
        }
        for o in core.orders_of(account) {
            out.push_str(&format!(
                "  order {} {} {} {:?} {} tick={} deal={:?} rejection={:?}\n",
                o.order_id.0,
                o.client_key,
                o.symbol,
                o.side,
                o.milli_lots,
                o.tick,
                o.deal.as_ref().map(|d| (
                    d.ids.deal_id.0,
                    d.ids.transaction_id.0,
                    d.price.raw(),
                    d.commission.minor(),
                    d.realised.minor(),
                    d.closed_quantity.raw(),
                    d.reversed
                )),
                o.rejection.map(|r| r.code())
            ));
        }
    }
    for t in core.journal().transactions() {
        out.push_str(&format!(
            "tx {} {} {:?}",
            t.id().0,
            t.kind().name(),
            t.subject()
        ));
        for e in t.entries() {
            out.push_str(&format!(
                " [{} {} {}]",
                e.account.as_str(),
                e.amount.minor,
                e.amount.currency
            ));
        }
        out.push('\n');
    }
    out.push_str(&format!(
        "version={} drift={} imbalanced={}\n",
        core.version(),
        core.projection_drift(),
        core.imbalanced_transactions()
    ));
    out
}

/// Drive a seeded history through a core on disk. Returns the accounts and
/// the last tick, so the reopened core can be valued at the same moment.
fn script(core: &mut Core, g: &mut Gen) -> (Vec<String>, u64) {
    let demo = core
        .open_account("replay", "Demo", 500, Mode::Demo, OPEN)
        .unwrap()
        .number;
    let real = core
        .open_account("replay", "Real", 100, Mode::Real, OPEN + 1)
        .unwrap()
        .number;
    let second = core
        .open_account("other", "Second", 200, Mode::Demo, OPEN + 2)
        .unwrap()
        .number;
    core.credit_demo(&demo, 250_000, "replay-credit-0001")
        .unwrap();
    core.credit_demo(&demo, 250_000, "replay-credit-0001")
        .unwrap(); // a retry
    let mut tick = OPEN + 3;
    for n in 0..60u32 {
        tick += g.in_range(1, 200) as u64;
        let account = if g.in_range(0, 3) == 0 {
            &second
        } else {
            &demo
        };
        let instrument = &INSTRUMENTS[g.in_range(0, INSTRUMENTS.len() as i128 - 1) as usize];
        let quotes = QuoteSet::synthetic(tick);
        match g.in_range(0, 5) {
            0 => {
                let _ = core.close_position(
                    account,
                    instrument.symbol,
                    tick,
                    &quotes,
                    &format!("replay-close-{n:04}"),
                );
            }
            _ => {
                let side = if g.in_range(0, 1) == 0 {
                    Side::Buy
                } else {
                    Side::Sell
                };
                let milli = g.in_range(
                    instrument.min_volume_milli_lots,
                    instrument.min_volume_milli_lots * 30,
                );
                let _ = core.place_order(
                    account,
                    instrument.symbol,
                    side,
                    milli,
                    tick,
                    &quotes,
                    &format!("replay-order-{n:04}"),
                );
            }
        }
    }
    core.set_account_status(&real, Status::Frozen).unwrap();
    core.reset_demo_account(&second, "replay-reset-0001").ok();
    (vec![demo, real, second], tick)
}

#[test]
fn the_core_reopened_from_its_journal_is_the_core_that_wrote_it() {
    let scratch = Scratch::new("core");
    let mut g = Gen::new(0x6006);
    let (accounts, tick, before) = {
        let mut core = Core::open(&scratch.0).unwrap();
        let (accounts, tick) = script(&mut core, &mut g);
        let before = snapshot(&core, &accounts, tick);
        (accounts, tick, before)
    };
    assert!(before.contains("tx "), "the script posted nothing");
    assert!(before.contains("position "), "the script opened nothing");

    let reopened = Core::open(&scratch.0).unwrap();
    let after = snapshot(&reopened, &accounts, tick);
    assert_eq!(
        before, after,
        "the reopened core differs from the one that wrote the journal"
    );

    // The next id is part of the state: a replayed core must not reuse one.
    let mut a = Core::open(&scratch.0).unwrap();
    let mut b = Core::open(&scratch.0).unwrap();
    let quotes = QuoteSet::synthetic(tick + 10);
    let oa = a
        .place_order(
            &accounts[0],
            "EURUSD",
            Side::Buy,
            100,
            tick + 10,
            &quotes,
            "replay-next-0001",
        )
        .unwrap();
    let ob = b
        .place_order(
            &accounts[0],
            "EURUSD",
            Side::Buy,
            100,
            tick + 10,
            &quotes,
            "replay-next-0001",
        )
        .unwrap();
    assert_eq!(
        oa.order_id, ob.order_id,
        "two replays issued different next ids"
    );

    println!("state_hash={:016x}", fnv(&after));
}

/// The same seed, two independent cores, two journals: byte-identical logs
/// and identical states. This is the cross-process half of the claim, in one
/// process; CI does the two-process half by diffing the printed hashes.
#[test]
fn two_cores_fed_the_same_history_write_the_same_journal() {
    let a = Scratch::new("twin-a");
    let b = Scratch::new("twin-b");
    let run = |path: &PathBuf| {
        let mut g = Gen::from_seed(0x7717);
        let mut core = Core::open(path).unwrap();
        let (accounts, tick) = script(&mut core, &mut g);
        snapshot(&core, &accounts, tick)
    };
    let sa = run(&a.0);
    let sb = run(&b.0);
    assert_eq!(sa, sb);
    let la = std::fs::read_to_string(&a.0).unwrap();
    let lb = std::fs::read_to_string(&b.0).unwrap();
    assert_eq!(la, lb, "the two journals differ byte for byte");
    println!("state_hash={:016x}", fnv(&sa));
}

/// The OMS lifecycle is a fold: replaying a recorded walk of transitions
/// gives the same history, and the same terminal verdict, every time.
#[test]
fn the_order_lifecycle_replays_from_its_recorded_walk() {
    let mut g = Gen::new(0x0e11);
    let mut recorded: Vec<Vec<OrderState>> = Vec::new();
    for _ in 0..500 {
        let mut life = Lifecycle::new();
        let mut walk = vec![life.current()];
        for _ in 0..g.small_count() + 4 {
            let next = OrderState::ALL[g.in_range(0, OrderState::ALL.len() as i128 - 1) as usize];
            if life.advance(next).is_ok() {
                walk.push(next);
            }
        }
        recorded.push(walk);
    }
    let mut digest = String::new();
    for walk in &recorded {
        let mut life = Lifecycle::new();
        for state in walk.iter().skip(1) {
            life.advance(*state)
                .expect("a recorded transition was legal when it was recorded");
        }
        assert_eq!(life.history(), walk.as_slice());
        digest.push_str(&format!("{:?}\n", life.history()));
    }
    println!("state_hash={:016x}", fnv(&digest));
}

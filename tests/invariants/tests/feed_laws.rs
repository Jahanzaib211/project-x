//! G3/G4 — the laws of the recorded feed, over generated input.
//!
//! `06-market-data` and `13-lp-connectivity` promise that nothing invalid
//! enters the record (INV-050), that a duplicate is applied once (INV-122),
//! that a reorder is recorded rather than skipped (INV-121), that the record
//! folds to the same digest wherever it is rebuilt (INV-054), and that a
//! quote served from it is always the latest one at or before the tick asked
//! for. Each is stated here as a property over thousands of generated quote
//! streams — including crossed, negative, absurd and out-of-order ones —
//! with a seed that reproduces any failure.

#![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]

use invariants::{for_all, Gen};
use market_core::feed::{FeedStore, Recorded, MAX_JUMP_BPS, MAX_SPREAD_BPS};
use market_core::instrument::{find, INSTRUMENTS};
use market_core::session::is_open;

// 1970-01-05 10:00 UTC, a Monday: every session is open for the day.
const OPEN: u64 = 1_526_400;

/// A plausible quote around the instrument's reference, sometimes not.
fn generate(g: &mut Gen, reference: i128) -> (i128, i128) {
    let mid = reference + g.in_range(-reference / 50, reference / 50);
    let spread = g.in_range(0, reference / 400);
    match g.in_range(0, 19) {
        0 => (mid + spread, mid), // crossed
        1 => (0, mid),            // zero
        2 => (-mid, mid),         // negative
        3 => (mid, mid * 2),      // absurd spread
        _ => (mid - spread / 2, mid + spread / 2),
    }
}

/// INV-050 — whatever arrives, the store never holds a crossed, non-positive
/// or absurdly wide quote, and every quote it serves passes the same checks.
#[test]
fn inv_050_nothing_invalid_is_ever_held() {
    for_all("nothing invalid is held", 3_000, 0x50_50, |g| {
        let mut store = FeedStore::new();
        let instrument = INSTRUMENTS[g.in_range(0, INSTRUMENTS.len() as i128 - 1) as usize];
        let mut tick = OPEN;
        for seq in 0..g.small_count() as u64 + 1 {
            tick += g.in_range(0, 8) as u64;
            let (bid, ask) = generate(g, instrument.reference_raw);
            let _ = store.record(instrument.symbol, tick, seq, bid, ask);
        }
        for probe in [OPEN, tick, tick + 5] {
            if let Some(q) = store.latest_at(instrument.symbol, probe) {
                if q.bid_raw <= 0 || q.ask_raw <= 0 {
                    return Err("a non-positive price was held".into());
                }
                if q.bid_raw > q.ask_raw {
                    return Err("a crossed quote was held".into());
                }
                let mid = q.mid_raw();
                if q.ask_raw - q.bid_raw > mid * MAX_SPREAD_BPS / 10_000 {
                    return Err("an absurd spread was held".into());
                }
                if q.tick > probe {
                    return Err("latest_at returned a quote from the future".into());
                }
            }
        }
        Ok(())
    });
}

/// INV-122 / INV-121 — a duplicate is applied once; a reorder is kept and
/// counted; the record is in tick order whatever the arrival order.
#[test]
fn inv_122_duplicates_once_and_reorders_kept_in_order() {
    for_all("duplicates and reorders", 2_000, 0x12_21, |g| {
        let mut store = FeedStore::new();
        let instrument = find("EURUSD").unwrap();
        let mid = instrument.reference_raw;
        let mut expected_len = 0u64;
        let mut ticks = Vec::new();
        for seq in 0..g.small_count() as u64 + 2 {
            let tick = OPEN + g.in_range(0, 50) as u64;
            let outcome = store
                .record(instrument.symbol, tick, seq, mid - 500, mid + 500)
                .unwrap();
            match outcome {
                Recorded::Duplicate => {
                    return Err("a fresh (tick, seq) was called a duplicate".into())
                }
                Recorded::Accepted | Recorded::OutOfOrder => expected_len += 1,
            }
            // Replaying the very same quote must change nothing.
            let again = store
                .record(instrument.symbol, tick, seq, mid - 500, mid + 500)
                .unwrap();
            if again != Recorded::Duplicate {
                return Err(format!("a resend was recorded as {again:?}"));
            }
            ticks.push(tick);
        }
        if store.len() != expected_len {
            return Err(format!("held {} but accepted {expected_len}", store.len()));
        }
        // Whatever order they arrived in, a probe at any tick sees the latest
        // quote at or before it — i.e. the record is in tick order.
        let mut sorted = ticks.clone();
        sorted.sort_unstable();
        for (i, probe) in sorted.iter().enumerate() {
            let got = store.latest_at(instrument.symbol, *probe).unwrap().tick;
            if got != sorted[i] {
                return Err(format!("probe at {probe} returned tick {got}"));
            }
        }
        Ok(())
    });
}

/// INV-054 — two stores fed the same accepted records in the same order have
/// the same digest; any difference in content or order changes it.
#[test]
fn inv_054_the_digest_is_a_function_of_the_accepted_records() {
    for_all("digest determinism", 1_500, 0x05_04, |g| {
        let instrument = find("BTCUSD").unwrap();
        let mut a = FeedStore::new();
        let mut b = FeedStore::new();
        let mut accepted = Vec::new();
        for seq in 0..g.small_count() as u64 + 2 {
            let tick = OPEN + seq;
            let (bid, ask) = generate(g, instrument.reference_raw);
            let ra = a.record(instrument.symbol, tick, seq, bid, ask);
            let rb = b.record(instrument.symbol, tick, seq, bid, ask);
            if ra != rb {
                return Err("two stores judged the same quote differently".into());
            }
            if ra.is_ok() {
                accepted.push((tick, seq, bid, ask));
            }
        }
        if a.state_hash() != b.state_hash() {
            return Err("same records, different digest".into());
        }
        if accepted.len() >= 2 {
            let mut c = FeedStore::new();
            for (tick, seq, bid, ask) in accepted.iter().rev() {
                c.record(instrument.symbol, *tick, *seq, *bid, *ask)
                    .unwrap();
            }
            if c.state_hash() == a.state_hash() {
                return Err("reversed order, same digest".into());
            }
        }
        Ok(())
    });
}

/// INV-050 (spike) and INV-053 — a jump beyond the limit from a recent quote
/// is refused; outside the session the served quote is frozen and marked so.
#[test]
fn inv_050_spikes_refused_and_inv_053_frozen_outside_session() {
    for_all("spikes and sessions", 1_500, 0x05_53, |g| {
        let instrument = find("XAUUSD").unwrap();
        let mut store = FeedStore::new();
        let mid = instrument.reference_raw;
        store
            .record(instrument.symbol, OPEN, 1, mid - 100, mid + 100)
            .unwrap();
        let factor = g.in_range(1, 4_000); // basis points of the move
        let moved = mid + mid * factor / 10_000;
        let outcome = store.record(instrument.symbol, OPEN + 1, 2, moved - 100, moved + 100);
        if factor > MAX_JUMP_BPS && outcome.is_ok() {
            return Err(format!("a {factor}bps jump was recorded"));
        }
        if factor <= MAX_JUMP_BPS && outcome.is_err() {
            return Err(format!("a {factor}bps move was refused"));
        }
        // Saturday 1970-01-10 12:00 UTC.
        let saturday = (9 * 86_400_000 + 12 * 3_600_000) / market_core::TICK_MS;
        if is_open(instrument.session, saturday) {
            return Err("the calendar thinks Saturday is open".into());
        }
        let frozen = store.quote_at(instrument, saturday).unwrap();
        if frozen.session_open() || frozen.priced_tick() > saturday {
            return Err("a closed-session quote was not frozen".into());
        }
        Ok(())
    });
}

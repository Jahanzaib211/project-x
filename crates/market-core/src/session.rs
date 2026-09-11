//! Trading sessions: when an instrument's market is open.
//!
//! A market that is closed does not produce prices. Before this module the
//! synthetic feed moved every instrument around the clock, so gold "traded" on
//! a Saturday afternoon at prices no venue would ever have quoted, and an order
//! against it was accepted. Both are now impossible by construction:
//!
//! - **INV-053** — outside its session an instrument's quote is *frozen* at the
//!   last open tick. No new price is produced, and the quote says it is frozen.
//! - **INV-084** — an order on a closed session is refused by risk, whatever
//!   the frozen price would have implied.
//!
//! Everything here is a pure function of the tick, in UTC, with no clock and no
//! allocation, so replay is exact and the calendar can be tested at any point
//! in history without waiting for a weekend to arrive.
//!
//! ## The calendar
//!
//! | Kind | Open | Closed |
//! |---|---|---|
//! | FX | Sunday 22:00 → Friday 22:00 | the weekend |
//! | Metals | Sunday 23:00 → Friday 22:00 | the weekend, and 22:00–23:00 daily |
//! | Crypto | always | never |
//!
//! Plus two fixed holidays, 25 December and 1 January, on which FX and metals
//! are closed all day. This is the standard retail calendar in UTC; a venue
//! with a different one changes this table, not the callers.

use crate::{epoch_ms_of, tick_of, TICK_MS};

/// Which calendar an instrument trades on.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SessionKind {
    /// Spot FX: Sunday 22:00 to Friday 22:00 UTC.
    Fx,
    /// Spot metals: as FX, but opening at 23:00 with a daily hour's break.
    Metals,
    /// Crypto: continuous.
    Crypto,
}

impl SessionKind {
    /// The wire name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Fx => "fx",
            Self::Metals => "metals",
            Self::Crypto => "crypto",
        }
    }

    /// A one-line description of the hours, for an interface to show.
    #[must_use]
    pub const fn hours(self) -> &'static str {
        match self {
            Self::Fx => "Sun 22:00 – Fri 22:00 UTC",
            Self::Metals => "Sun 23:00 – Fri 22:00 UTC, daily break 22:00 – 23:00",
            Self::Crypto => "24/7",
        }
    }
}

/// The state of a session at one tick.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct SessionState {
    /// Whether the market is open at the tick asked about.
    pub open: bool,
    /// The last tick at which the market was open (the tick itself when open).
    pub last_open_tick: u64,
    /// The tick at which the state next flips: the next open when closed, the
    /// next close when open. `None` for a continuous market.
    pub next_transition_tick: Option<u64>,
}

const MS_PER_MINUTE: u64 = 60_000;
const MS_PER_HOUR: u64 = 3_600_000;
const MS_PER_DAY: u64 = 86_400_000;
/// How far a transition search looks: sixteen days, in minutes.
const SEARCH_LIMIT_MINUTES: u32 = 16 * 24 * 60;

/// `a / b`, with zero for a zero divisor. The divisors here are all constants,
/// so this never happens; the form keeps the arithmetic explicit (P1).
const fn div(a: u64, b: u64) -> u64 {
    match a.checked_div(b) {
        Some(q) => q,
        None => 0,
    }
}

/// `a % b`, with zero for a zero divisor.
const fn rem(a: u64, b: u64) -> u64 {
    match a.checked_rem(b) {
        Some(r) => r,
        None => 0,
    }
}

/// Day of week for an epoch millisecond, `0 = Sunday … 6 = Saturday`.
const fn weekday(ms: u64) -> u64 {
    // 1970-01-01 was a Thursday, which is 4 with Sunday at 0.
    rem(div(ms, MS_PER_DAY).saturating_add(4), 7)
}

/// The civil date of an epoch millisecond, as `(year, month, day)`.
///
/// Howard Hinnant's `civil_from_days`, in integers. Only needed for the fixed
/// holidays, and only ever called for a handful of ticks per request. Written
/// with checked and Euclidean operations because the workspace forbids bare
/// arithmetic; the values are all small.
fn civil(ms: u64) -> (i64, u32, u32) {
    let days = i64::try_from(div(ms, MS_PER_DAY)).unwrap_or(i64::MAX);
    let z = days.saturating_add(719_468);
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = doe
        .saturating_sub(doe.div_euclid(1_460))
        .saturating_add(doe.div_euclid(36_524))
        .saturating_sub(doe.div_euclid(146_096))
        .div_euclid(365);
    let y = yoe.saturating_add(era.saturating_mul(400));
    let doy = doe.saturating_sub(
        yoe.saturating_mul(365)
            .saturating_add(yoe.div_euclid(4))
            .saturating_sub(yoe.div_euclid(100)),
    );
    let mp = doy.saturating_mul(5).saturating_add(2).div_euclid(153);
    let d = doy
        .saturating_sub(mp.saturating_mul(153).saturating_add(2).div_euclid(5))
        .saturating_add(1);
    let m = if mp < 10 {
        mp.saturating_add(3)
    } else {
        mp.saturating_sub(9)
    };
    let year = if m <= 2 { y.saturating_add(1) } else { y };
    (
        year,
        u32::try_from(m).unwrap_or(0),
        u32::try_from(d).unwrap_or(0),
    )
}

/// Whether the day containing `ms` is a fixed holiday.
fn is_holiday(ms: u64) -> bool {
    let (_, month, day) = civil(ms);
    (month == 12 && day == 25) || (month == 1 && day == 1)
}

/// Whether the market is open at `ms`.
fn open_at_ms(kind: SessionKind, ms: u64) -> bool {
    let day = weekday(ms);
    let hour = div(rem(ms, MS_PER_DAY), MS_PER_HOUR);
    match kind {
        SessionKind::Crypto => true,
        SessionKind::Fx => {
            if is_holiday(ms) {
                return false;
            }
            match day {
                6 => false,      // Saturday
                0 => hour >= 22, // Sunday, from 22:00
                5 => hour < 22,  // Friday, until 22:00
                _ => true,
            }
        }
        SessionKind::Metals => {
            if is_holiday(ms) {
                return false;
            }
            match day {
                6 => false,
                0 => hour >= 23, // Sunday, from 23:00
                5 => hour < 22,  // Friday, until 22:00
                _ => hour != 22, // Monday to Thursday, closed 22:00–23:00
            }
        }
    }
}

/// Whether `kind` is open at `tick`.
#[must_use]
pub fn is_open(kind: SessionKind, tick: u64) -> bool {
    open_at_ms(kind, epoch_ms_of(tick))
}

/// The most recent tick at or before `tick` at which the market was open.
///
/// Every closed window ends on a minute boundary, so the search steps back a
/// minute at a time and then settles on the exact tick. Bounded: a market that
/// has somehow been closed for more than sixteen days reports the tick asked
/// for, which is the honest answer to "when was it last open" in a calendar
/// this module does not describe.
#[must_use]
pub fn last_open_tick(kind: SessionKind, tick: u64) -> u64 {
    if is_open(kind, tick) {
        return tick;
    }
    let mut ms = epoch_ms_of(tick);
    // Step back to the start of the current minute first, then by minutes.
    ms = ms.saturating_sub(rem(ms, MS_PER_MINUTE));
    let mut steps = 0u32;
    while ms >= MS_PER_MINUTE && steps < SEARCH_LIMIT_MINUTES {
        ms = ms.saturating_sub(MS_PER_MINUTE);
        steps = steps.saturating_add(1);
        if open_at_ms(kind, ms) {
            // The last open millisecond is the end of this minute; the last
            // open tick is the one containing it.
            return tick_of(ms.saturating_add(MS_PER_MINUTE).saturating_sub(1));
        }
    }
    tick
}

/// The next tick at which the state flips, or `None` for a continuous market.
#[must_use]
pub fn next_transition_tick(kind: SessionKind, tick: u64) -> Option<u64> {
    if matches!(kind, SessionKind::Crypto) {
        return None;
    }
    let now_open = is_open(kind, tick);
    let mut ms = epoch_ms_of(tick);
    ms = ms.saturating_sub(rem(ms, MS_PER_MINUTE));
    let mut steps = 0u32;
    while steps < SEARCH_LIMIT_MINUTES {
        ms = ms.saturating_add(MS_PER_MINUTE);
        steps = steps.saturating_add(1);
        if open_at_ms(kind, ms) != now_open {
            return Some(tick_of(ms));
        }
    }
    None
}

/// Everything about the session at `tick`, in one read.
#[must_use]
pub fn state_at(kind: SessionKind, tick: u64) -> SessionState {
    SessionState {
        open: is_open(kind, tick),
        last_open_tick: last_open_tick(kind, tick),
        next_transition_tick: next_transition_tick(kind, tick),
    }
}

/// The session state as JSON, for the services to embed verbatim.
///
/// Rendered here so every service says the same thing about the same tick.
/// Numbers only, so no escaping is needed.
#[must_use]
pub fn state_json(kind: SessionKind, tick: u64) -> String {
    let state = state_at(kind, tick);
    let next = state
        .next_transition_tick
        .map_or_else(|| "null".to_owned(), |t| epoch_ms_of(t).to_string());
    format!(
        r#"{{"kind":"{}","open":{},"pricedTick":{},"pricedMs":{},"nextTransitionMs":{next},"hours":"{}"}}"#,
        kind.name(),
        state.open,
        state.last_open_tick,
        epoch_ms_of(state.last_open_tick),
        kind.hours()
    )
}

/// Milliseconds until the next transition, for an interface to count down.
#[must_use]
pub fn ms_until_transition(kind: SessionKind, tick: u64) -> Option<u64> {
    next_transition_tick(kind, tick).map(|next| next.saturating_sub(tick).saturating_mul(TICK_MS))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]
    use super::*;

    /// A tick for a UTC date and time, built from the civil date arithmetic in
    /// reverse so the tests read as dates rather than as magic numbers.
    fn at(year: i64, month: u32, day: u32, hour: u64, minute: u64) -> u64 {
        // days_from_civil, Hinnant again.
        let y = if month <= 2 { year - 1 } else { year };
        let era = y.div_euclid(400);
        let yoe = y.rem_euclid(400);
        let mp = if month > 2 { month - 3 } else { month + 9 } as i64;
        let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        let ms = (days as u64) * MS_PER_DAY + hour * MS_PER_HOUR + minute * MS_PER_MINUTE;
        tick_of(ms)
    }

    #[test]
    fn the_calendar_arithmetic_round_trips() {
        // 2026-09-12 is a Saturday.
        let saturday = at(2026, 9, 12, 12, 0);
        assert_eq!(weekday(epoch_ms_of(saturday)), 6);
        assert_eq!(civil(epoch_ms_of(saturday)), (2026, 9, 12));
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(weekday(0), 4, "the epoch was a Thursday");
    }

    /// INV-053 — the weekend is closed for FX and metals and open for crypto.
    #[test]
    fn inv_053_the_weekend_is_closed_except_for_crypto() {
        let saturday = at(2026, 9, 12, 12, 0);
        assert!(!is_open(SessionKind::Fx, saturday));
        assert!(!is_open(SessionKind::Metals, saturday));
        assert!(is_open(SessionKind::Crypto, saturday));

        // Friday 21:59 open, 22:00 closed.
        assert!(is_open(SessionKind::Fx, at(2026, 9, 11, 21, 59)));
        assert!(!is_open(SessionKind::Fx, at(2026, 9, 11, 22, 0)));
        // Sunday: FX opens 22:00, metals 23:00.
        assert!(!is_open(SessionKind::Fx, at(2026, 9, 13, 21, 59)));
        assert!(is_open(SessionKind::Fx, at(2026, 9, 13, 22, 0)));
        assert!(!is_open(SessionKind::Metals, at(2026, 9, 13, 22, 30)));
        assert!(is_open(SessionKind::Metals, at(2026, 9, 13, 23, 0)));
    }

    #[test]
    fn metals_take_a_daily_break_and_fx_does_not() {
        let tuesday_break = at(2026, 9, 15, 22, 30);
        assert!(!is_open(SessionKind::Metals, tuesday_break));
        assert!(is_open(SessionKind::Fx, tuesday_break));
        assert!(is_open(SessionKind::Metals, at(2026, 9, 15, 23, 0)));
        assert!(is_open(SessionKind::Metals, at(2026, 9, 15, 21, 59)));
    }

    #[test]
    fn fixed_holidays_close_fx_and_metals_all_day() {
        // 2026-12-25 is a Friday; 2027-01-01 is a Friday.
        assert!(!is_open(SessionKind::Fx, at(2026, 12, 25, 10, 0)));
        assert!(!is_open(SessionKind::Metals, at(2027, 1, 1, 10, 0)));
        assert!(is_open(SessionKind::Crypto, at(2026, 12, 25, 10, 0)));
        assert!(is_open(SessionKind::Fx, at(2026, 12, 24, 10, 0)));
    }

    /// INV-053 — while closed, the last open tick is the final tick before the
    /// close, and it does not move as the weekend goes on.
    #[test]
    fn inv_053_the_frozen_tick_is_the_last_tick_before_the_close() {
        let close = at(2026, 9, 11, 22, 0);
        let frozen = last_open_tick(SessionKind::Fx, at(2026, 9, 12, 15, 0));
        assert_eq!(frozen, close - 1);
        assert!(is_open(SessionKind::Fx, frozen));
        assert!(!is_open(SessionKind::Fx, frozen + 1));
        assert_eq!(
            last_open_tick(SessionKind::Fx, at(2026, 9, 13, 21, 0)),
            close - 1
        );
        // Open: the tick itself.
        let monday = at(2026, 9, 14, 9, 0);
        assert_eq!(last_open_tick(SessionKind::Fx, monday), monday);
        assert_eq!(
            last_open_tick(SessionKind::Crypto, at(2026, 9, 12, 15, 0)),
            at(2026, 9, 12, 15, 0)
        );
    }

    #[test]
    fn the_next_transition_is_the_open_when_closed_and_the_close_when_open() {
        let saturday = at(2026, 9, 12, 15, 0);
        assert_eq!(
            next_transition_tick(SessionKind::Fx, saturday),
            Some(at(2026, 9, 13, 22, 0))
        );
        assert_eq!(
            next_transition_tick(SessionKind::Metals, saturday),
            Some(at(2026, 9, 13, 23, 0))
        );
        let monday = at(2026, 9, 14, 9, 0);
        assert_eq!(
            next_transition_tick(SessionKind::Fx, monday),
            Some(at(2026, 9, 18, 22, 0))
        );
        assert_eq!(
            next_transition_tick(SessionKind::Metals, monday),
            Some(at(2026, 9, 14, 22, 0))
        );
        assert_eq!(next_transition_tick(SessionKind::Crypto, monday), None);
        assert_eq!(
            ms_until_transition(SessionKind::Fx, saturday),
            Some((at(2026, 9, 13, 22, 0) - saturday) * TICK_MS)
        );
        let state = state_at(SessionKind::Fx, saturday);
        assert!(!state.open);
        assert_eq!(state.last_open_tick, at(2026, 9, 11, 22, 0) - 1);
    }
}

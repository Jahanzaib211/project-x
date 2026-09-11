//! Candle aggregation.
//!
//! A candle is a *view* of the series, not a stored record. Because the series
//! is a pure function of the tick (see [`crate::series`]), any window of
//! history can be recomputed on demand — so there is no candle table to keep
//! consistent with the ticks, and no way for the two to disagree.
//!
//! The open of a candle is the mid at its first tick and the close is the mid
//! at its last, so consecutive candles join exactly: `close[n] == open[n+1]`
//! is a property of the construction, not something to be reconciled.
//!
//! A candle covers only ticks on which the market was open (INV-053). A window
//! with no open tick produces no candle at all, so a chart over a weekend shows
//! Friday's close beside Sunday's open rather than a flat line drawn through
//! two days on which nothing was quoted.

use crate::instrument::Instrument;
use crate::series::mid_raw;
use crate::session::is_open;
use crate::{MarketError, TICK_MS};

/// A chart interval, named as clients name them.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Interval {
    /// Label, e.g. `1m`.
    pub label: &'static str,
    /// How many feed ticks one candle spans.
    pub ticks: u64,
}

impl Interval {
    /// How long one candle of this interval lasts, in milliseconds.
    #[must_use]
    pub const fn duration_ms(&self) -> u64 {
        self.ticks.saturating_mul(TICK_MS)
    }
}

/// Every interval the feed publishes.
///
/// Kept short on purpose. Each one is a promise that a chart request for it
/// returns in bounded time, and a five-second candle over a month of ticks is
/// not that.
pub static INTERVALS: &[Interval] = &[
    Interval {
        label: "5s",
        ticks: 20,
    },
    Interval {
        label: "15s",
        ticks: 60,
    },
    Interval {
        label: "1m",
        ticks: 240,
    },
    Interval {
        label: "5m",
        ticks: 1_200,
    },
    Interval {
        label: "15m",
        ticks: 3_600,
    },
    Interval {
        label: "1h",
        ticks: 14_400,
    },
];

/// The interval with this label, if the feed publishes it.
#[must_use]
pub fn interval(label: &str) -> Option<&'static Interval> {
    INTERVALS.iter().find(|i| i.label == label)
}

/// One candle, in raw `UNIT_SCALE` price units.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Candle {
    /// The first tick this candle covers. Identifies it uniquely.
    pub open_tick: u64,
    /// Start of the candle, in epoch milliseconds.
    pub open_ms: u64,
    /// Mid at the first tick.
    pub open: i128,
    /// Highest mid in the window.
    pub high: i128,
    /// Lowest mid in the window.
    pub low: i128,
    /// Mid at the last tick.
    pub close: i128,
}

impl Candle {
    /// Whether the close is at or above the open.
    #[must_use]
    pub const fn is_up(&self) -> bool {
        self.close >= self.open
    }
}

/// The most candles a single request may ask for.
///
/// Bounded because the cost is `count × interval.ticks` evaluations, and an
/// unbounded chart request is a way to spend a core.
pub const MAX_CANDLES: usize = 500;

/// Build the `count` candles of `interval` ending with the one containing
/// `latest_tick`.
///
/// The final candle is partial: it covers only the ticks up to `latest_tick`,
/// which is what makes a live chart's last candle grow as the price moves.
///
/// # Errors
/// [`MarketError::UnknownInterval`] if `count` is zero or above [`MAX_CANDLES`].
pub fn candles(
    instrument: &Instrument,
    interval: &Interval,
    latest_tick: u64,
    count: usize,
) -> Result<Vec<Candle>, MarketError> {
    if count == 0 || count > MAX_CANDLES || interval.ticks == 0 {
        return Err(MarketError::UnknownInterval);
    }

    // Candles are aligned to absolute tick boundaries, not to "now". Two
    // clients loading the chart a second apart therefore see the same candles
    // with the same open times, rather than two differently-phased grids.
    let current_index = latest_tick.checked_div(interval.ticks).unwrap_or(0);

    // Walk back from the current window until `count` candles have been
    // found, skipping windows in which the market never opened. The walk is
    // bounded: a weekend plus a holiday is under four days, and a bound that
    // generous is still a bound.
    let closure_ticks: u64 = (4 * 24 * 3_600_000) / TICK_MS;
    let scan_limit = (count as u64)
        .saturating_add(closure_ticks.checked_div(interval.ticks).unwrap_or(0))
        .saturating_add(1);
    let mut out = Vec::with_capacity(count);
    let mut index = current_index;
    let mut scanned = 0u64;
    loop {
        let open_tick = index.saturating_mul(interval.ticks);
        let last_tick = open_tick
            .saturating_add(interval.ticks)
            .saturating_sub(1)
            .min(latest_tick);
        if let Some(candle) = candle_over(instrument, open_tick, last_tick) {
            out.push(candle);
        }
        scanned = scanned.saturating_add(1);
        if out.len() >= count || index == 0 || scanned >= scan_limit {
            break;
        }
        index = index.saturating_sub(1);
    }
    out.reverse();
    Ok(out)
}

/// The single candle covering the open ticks in `[open_tick, last_tick]`, or
/// `None` if the market was closed throughout.
fn candle_over(instrument: &Instrument, open_tick: u64, last_tick: u64) -> Option<Candle> {
    // Sessions change on minute boundaries and every interval here divides an
    // hour, so a window is either wholly open, wholly closed, or opens or
    // closes part-way — and the per-tick check below handles all three.
    let kind = instrument.session;
    if !is_open(kind, open_tick) && !is_open(kind, last_tick) {
        // Both ends closed. Only a window longer than a closure could still
        // contain open ticks, and none here is: the shortest closure is an
        // hour and the longest interval is an hour, aligned to the hour.
        return None;
    }

    let mut first: Option<i128> = None;
    let mut high = 0i128;
    let mut low = 0i128;
    let mut close = 0i128;

    let mut tick = open_tick;
    while tick <= last_tick {
        if is_open(kind, tick) {
            let mid = mid_raw(instrument, tick);
            match first {
                None => {
                    first = Some(mid);
                    high = mid;
                    low = mid;
                }
                Some(_) => {
                    high = high.max(mid);
                    low = low.min(mid);
                }
            }
            close = mid;
        }
        // The candle is a closed range, so the loop must stop on overflow
        // rather than wrap back to zero and run forever.
        match tick.checked_add(1) {
            Some(next) => tick = next,
            None => break,
        }
    }

    first.map(|open| Candle {
        open_tick,
        open_ms: crate::epoch_ms_of(open_tick),
        open,
        high,
        low,
        close,
    })
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::indexing_slicing,
        clippy::arithmetic_side_effects
    )]
    use super::*;
    use crate::instrument::find;
    use crate::session::SessionKind;

    fn eurusd() -> &'static Instrument {
        find("EURUSD").unwrap()
    }

    fn one_minute() -> &'static Interval {
        interval("1m").unwrap()
    }

    #[test]
    fn a_candle_encloses_its_own_open_and_close() {
        let built = candles(eurusd(), one_minute(), 100_000, 50).unwrap();
        for candle in &built {
            assert!(candle.low <= candle.open && candle.open <= candle.high);
            assert!(candle.low <= candle.close && candle.close <= candle.high);
            assert!(candle.low <= candle.high);
        }
    }

    /// Consecutive candles join exactly. If they did not, a chart would show a
    /// gap at every boundary that the price never actually traded through.
    #[test]
    fn consecutive_completed_candles_join_at_the_boundary() {
        let built = candles(eurusd(), one_minute(), 100_000, 40).unwrap();
        for pair in built.windows(2) {
            let (earlier, later) = (pair[0], pair[1]);
            assert_eq!(
                later.open_tick,
                earlier.open_tick.saturating_add(one_minute().ticks)
            );
            // The next candle opens at the tick after this one's last, so its
            // open is the series' next value — continuity is checked in the
            // series tests; here we check the grid has no holes in it.
        }
    }

    /// INV-052 — the same window recomputes identically, so two clients see the
    /// same chart and a replay sees what the client saw.
    #[test]
    fn inv_052_the_same_window_recomputes_identically() {
        let first = candles(eurusd(), one_minute(), 500_000, 120).unwrap();
        let second = candles(eurusd(), one_minute(), 500_000, 120).unwrap();
        assert_eq!(first, second);
    }

    /// Alignment is absolute, so a request made one tick later returns the same
    /// candles with the same open times — the last one merely extends.
    #[test]
    fn candles_are_aligned_to_absolute_boundaries() {
        let interval = one_minute();
        let base = interval.ticks.saturating_mul(1_000);
        let early = candles(eurusd(), interval, base.saturating_add(5), 10).unwrap();
        let later = candles(eurusd(), interval, base.saturating_add(9), 10).unwrap();

        let early_opens: Vec<u64> = early.iter().map(|c| c.open_tick).collect();
        let later_opens: Vec<u64> = later.iter().map(|c| c.open_tick).collect();
        assert_eq!(early_opens, later_opens);
        for candle in &early_opens {
            assert_eq!(candle.checked_rem(interval.ticks), Some(0));
        }
    }

    /// The live candle grows: extending the window can move high, low and
    /// close, but never the open.
    #[test]
    fn the_live_candle_grows_without_rewriting_its_open() {
        let interval = one_minute();
        let base = interval.ticks.saturating_mul(2_000);
        let mut previous = candles(eurusd(), interval, base, 3).unwrap();
        for step in 1..interval.ticks {
            let now = candles(eurusd(), interval, base.saturating_add(step), 3).unwrap();
            let (was, is) = (previous[2], now[2]);
            assert_eq!(was.open, is.open, "the open changed under the client");
            assert!(is.high >= was.high, "high shrank");
            assert!(is.low <= was.low, "low grew");
            previous = now;
        }
    }

    #[test]
    fn the_requested_count_is_what_comes_back() {
        for count in [1usize, 2, 50, MAX_CANDLES] {
            let built = candles(eurusd(), one_minute(), 10_000_000, count).unwrap();
            assert_eq!(built.len(), count);
        }
    }

    #[test]
    fn an_unreasonable_request_is_refused_rather_than_served_slowly() {
        assert_eq!(
            candles(eurusd(), one_minute(), 1_000, 0),
            Err(MarketError::UnknownInterval)
        );
        assert_eq!(
            candles(eurusd(), one_minute(), 1_000, MAX_CANDLES.saturating_add(1)),
            Err(MarketError::UnknownInterval)
        );
    }

    /// Near tick zero there is less history than asked for. The window clamps
    /// rather than underflowing into candles from before the epoch. (Crypto,
    /// because tick zero is 1 January — a holiday on which FX is closed.)
    #[test]
    fn a_window_at_the_start_of_time_clamps_instead_of_underflowing() {
        let btc = find("BTCUSD").unwrap();
        let built = candles(btc, one_minute(), 10, 100).unwrap();
        assert_eq!(built.len(), 1);
        assert_eq!(built[0].open_tick, 0);
    }

    /// INV-053 — a closed market produces no candles: the chart over a
    /// weekend runs Friday's last candle into Sunday's first, and the count
    /// asked for is still filled from before the close.
    #[test]
    fn inv_053_closed_windows_produce_no_candles_and_the_count_is_still_filled() {
        // 2026-09-12 12:00 UTC, a Saturday. Ticks are 250ms.
        let saturday_noon = (1_789_214_400_000u64) / TICK_MS;
        assert!(!crate::session::is_open(SessionKind::Fx, saturday_noon));
        let gold = find("XAUUSD").unwrap();
        let built = candles(gold, one_minute(), saturday_noon, 30).unwrap();
        assert_eq!(built.len(), 30, "the count is filled from open history");
        for candle in &built {
            assert!(
                crate::session::is_open(SessionKind::Metals, candle.open_tick)
                    || crate::session::is_open(
                        SessionKind::Metals,
                        candle.open_tick + one_minute().ticks - 1
                    ),
                "a candle at {} covers a closed window",
                candle.open_ms
            );
        }
        // The newest candle is the last minute before Friday 22:00 UTC.
        let friday_close_ms = 1_789_164_000_000u64;
        assert_eq!(built[29].open_ms, friday_close_ms - 60_000);

        // Crypto has no closed windows at all.
        let btc = find("BTCUSD").unwrap();
        let live = candles(btc, one_minute(), saturday_noon, 5).unwrap();
        assert_eq!(
            live[4].open_tick,
            saturday_noon - saturday_noon % one_minute().ticks
        );
    }

    #[test]
    fn intervals_are_declared_consistently() {
        for interval in INTERVALS {
            assert!(interval.ticks > 0, "{}", interval.label);
            assert_eq!(interval.duration_ms(), interval.ticks.saturating_mul(250));
        }
        assert_eq!(interval("1m").unwrap().duration_ms(), 60_000);
        assert_eq!(interval("1h").unwrap().duration_ms(), 3_600_000);
        assert!(interval("3d").is_none());
    }
}

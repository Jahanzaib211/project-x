//! The recorded feed: quotes that arrived from the world, kept in tick order.
//!
//! ## Why a store, when the synthetic series needed none
//!
//! The synthetic feed is a pure function of the tick, so history is free. A
//! real provider's quote is a fact that happened once; it must be *recorded*
//! or it is gone, and everything downstream that was priced against it becomes
//! unreproducible. This store is that record: an append-only, per-symbol,
//! tick-indexed list of validated quotes.
//!
//! - **INV-050** — a quote that fails validation never enters the store.
//!   [`FeedStore::record`] is the only way in, and it checks.
//! - **INV-052 / INV-054** — the store's whole content folds into one hash.
//!   Two stores that replayed the same records have the same hash; a service
//!   that rebuilt its store from its log can prove it holds what it held.
//! - **INV-122** — a duplicate (same symbol, tick, sequence) is applied once.
//!
//! The store holds no clock and does no I/O. Persistence — the append-only
//! log and its replay — belongs to the service that owns the store, exactly
//! as the ledger's journal belongs to the ledger service.

use std::collections::BTreeMap;

use domain_kernel::Price;

use crate::candle::{Candle, Interval, MAX_CANDLES};
use crate::instrument::{find, Instrument};
use crate::session::{is_open, last_open_tick};
use crate::{epoch_ms_of, MarketError, Quote};

/// One quote as recorded.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct RecordedQuote {
    /// The feed tick the quote belongs to.
    pub tick: u64,
    /// Provider sequence within the tick, so two quotes in one tick keep
    /// their order and a resend is recognisable.
    pub seq: u64,
    /// Bid, in raw price units.
    pub bid_raw: i128,
    /// Ask, in raw price units.
    pub ask_raw: i128,
}

impl RecordedQuote {
    /// The mid, in raw price units.
    #[must_use]
    pub fn mid_raw(&self) -> i128 {
        let sum = self.bid_raw.saturating_add(self.ask_raw);
        sum.checked_div(2).unwrap_or(sum)
    }
}

/// What happened to a submitted quote.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Recorded {
    /// Appended in order.
    Accepted,
    /// Appended, but its tick is earlier than the latest already held. It is
    /// kept — it is a fact — and is reported so a gap can be counted.
    OutOfOrder,
    /// Already held. Nothing changed (INV-122).
    Duplicate,
}

/// The widest spread accepted, in basis points of the mid.
///
/// A spread beyond this is not a wide market, it is a broken feed: a decimal
/// point in the wrong place, a stale side, a provider quoting two instruments
/// under one symbol. Refused rather than recorded (INV-050).
pub const MAX_SPREAD_BPS: i128 = 500;

/// The recorded feed for every instrument.
#[derive(Clone, Debug, Default)]
pub struct FeedStore {
    quotes: BTreeMap<&'static str, Vec<RecordedQuote>>,
    hash: u64,
    count: u64,
    out_of_order: u64,
}

/// FNV-1a over a 64-bit word. Not a `Hasher`: the value is part of the
/// observable behaviour (a replayed store must reproduce it), so it must not
/// change with the standard library.
fn fnv(hash: u64, word: u64) -> u64 {
    word.to_le_bytes().iter().fold(hash, |acc, byte| {
        (acc ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;

impl FeedStore {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self {
            quotes: BTreeMap::new(),
            hash: FNV_OFFSET,
            count: 0,
            out_of_order: 0,
        }
    }

    /// Validate a quote and, if it holds, record it (INV-050).
    ///
    /// # Errors
    /// [`MarketError::UnknownInstrument`] for a symbol not in the table;
    /// [`MarketError::InvalidQuote`] for a non-positive or crossed price or an
    /// absurd spread.
    pub fn record(
        &mut self,
        symbol: &str,
        tick: u64,
        seq: u64,
        bid_raw: i128,
        ask_raw: i128,
    ) -> Result<Recorded, MarketError> {
        let instrument = find(symbol).ok_or(MarketError::UnknownInstrument)?;
        // The same checks a synthetic quote passes, on the same constructor.
        let quote = Quote::validated(
            instrument.symbol,
            tick,
            Price::from_raw(bid_raw),
            Price::from_raw(ask_raw),
        )?;
        let mid = quote.mid().raw();
        let spread = ask_raw.saturating_sub(bid_raw);
        let widest = mid
            .saturating_mul(MAX_SPREAD_BPS)
            .checked_div(10_000)
            .unwrap_or(0);
        if spread > widest {
            return Err(MarketError::InvalidQuote("spread is absurd for the mid"));
        }

        let series = self.quotes.entry(instrument.symbol).or_default();
        if series
            .iter()
            .rev()
            .take_while(|q| q.tick >= tick)
            .any(|q| q.tick == tick && q.seq == seq)
        {
            return Ok(Recorded::Duplicate);
        }
        let recorded = RecordedQuote {
            tick,
            seq,
            bid_raw,
            ask_raw,
        };
        let out_of_order = series.last().is_some_and(|last| last.tick > tick);
        // Insert in tick order so `latest_at` can binary-search. Out-of-order
        // arrivals are rare and short, so the scan back is short too.
        let position = series.partition_point(|q| (q.tick, q.seq) <= (tick, seq));
        series.insert(position, recorded);

        // The hash folds over arrival order, which is what the log records.
        let mut hash = fnv(self.hash, seed_of(instrument.symbol));
        hash = fnv(hash, tick);
        hash = fnv(hash, seq);
        hash = fnv(hash, bid_raw as u64);
        hash = fnv(hash, (bid_raw >> 64) as u64);
        hash = fnv(hash, ask_raw as u64);
        hash = fnv(hash, (ask_raw >> 64) as u64);
        self.hash = hash;
        self.count = self.count.saturating_add(1);
        if out_of_order {
            self.out_of_order = self.out_of_order.saturating_add(1);
            Ok(Recorded::OutOfOrder)
        } else {
            Ok(Recorded::Accepted)
        }
    }

    /// The latest recorded quote at or before `tick`, if any.
    #[must_use]
    pub fn latest_at(&self, symbol: &str, tick: u64) -> Option<&RecordedQuote> {
        let series = self.quotes.get(symbol)?;
        let end = series.partition_point(|q| q.tick <= tick);
        end.checked_sub(1).and_then(|i| series.get(i))
    }

    /// The most recent recorded tick for `symbol`.
    #[must_use]
    pub fn last_tick(&self, symbol: &str) -> Option<u64> {
        self.quotes.get(symbol)?.last().map(|q| q.tick)
    }

    /// The canonical quote for `instrument` at `tick` from the record.
    ///
    /// While the session is open the quote carries the tick it was *recorded*
    /// at, so its age is the feed's real staleness (INV-051) and a consumer
    /// can refuse it. Outside the session it is the last open quote, carried
    /// forward and marked frozen (INV-053) — the same rule the synthetic feed
    /// follows. `None` if nothing has been recorded that early.
    #[must_use]
    pub fn quote_at(&self, instrument: &Instrument, tick: u64) -> Option<Quote> {
        let priced_tick = last_open_tick(instrument.session, tick);
        let recorded = self.latest_at(instrument.symbol, priced_tick)?;
        let bid = Price::from_raw(recorded.bid_raw);
        let ask = Price::from_raw(recorded.ask_raw);
        if priced_tick == tick {
            Quote::validated(instrument.symbol, recorded.tick, bid, ask).ok()
        } else {
            Quote::validated(instrument.symbol, tick, bid, ask)
                .ok()
                .map(|quote| quote.frozen_since(recorded.tick))
        }
    }

    /// Candles over the record, ending with the window containing
    /// `latest_tick`.
    ///
    /// Only ticks with a recorded quote contribute, and only while the session
    /// is open. A window with neither produces no candle, and the walk back
    /// stops at the first recorded quote rather than inventing history.
    ///
    /// # Errors
    /// [`MarketError::UnknownInterval`] if `count` is zero or above
    /// [`MAX_CANDLES`].
    pub fn candles(
        &self,
        instrument: &Instrument,
        interval: &Interval,
        latest_tick: u64,
        count: usize,
    ) -> Result<Vec<Candle>, MarketError> {
        if count == 0 || count > MAX_CANDLES || interval.ticks == 0 {
            return Err(MarketError::UnknownInterval);
        }
        let Some(series) = self.quotes.get(instrument.symbol) else {
            return Ok(Vec::new());
        };
        let Some(first_tick) = series.first().map(|q| q.tick) else {
            return Ok(Vec::new());
        };

        let mut out = Vec::with_capacity(count);
        let mut index = latest_tick.checked_div(interval.ticks).unwrap_or(0);
        loop {
            let open_tick = index.saturating_mul(interval.ticks);
            let last_tick = open_tick
                .saturating_add(interval.ticks)
                .saturating_sub(1)
                .min(latest_tick);
            if let Some(candle) = self.candle_over(instrument, series, open_tick, last_tick) {
                out.push(candle);
            }
            if out.len() >= count || index == 0 || last_tick < first_tick {
                break;
            }
            index = index.saturating_sub(1);
        }
        out.reverse();
        Ok(out)
    }

    fn candle_over(
        &self,
        instrument: &Instrument,
        series: &[RecordedQuote],
        open_tick: u64,
        last_tick: u64,
    ) -> Option<Candle> {
        let start = series.partition_point(|q| q.tick < open_tick);
        let end = series.partition_point(|q| q.tick <= last_tick);
        let window = series.get(start..end)?;
        let mut first: Option<i128> = None;
        let mut high = 0i128;
        let mut low = 0i128;
        let mut close = 0i128;
        for quote in window {
            if !is_open(instrument.session, quote.tick) {
                continue;
            }
            let mid = quote.mid_raw();
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
        first.map(|open| Candle {
            open_tick,
            open_ms: epoch_ms_of(open_tick),
            open,
            high,
            low,
            close,
        })
    }

    /// A digest of everything recorded, in arrival order (INV-054).
    #[must_use]
    pub const fn state_hash(&self) -> u64 {
        self.hash
    }

    /// How many quotes are held.
    #[must_use]
    pub const fn len(&self) -> u64 {
        self.count
    }

    /// Whether nothing has been recorded.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// How many quotes arrived later than a quote already held.
    #[must_use]
    pub const fn out_of_order(&self) -> u64 {
        self.out_of_order
    }

    /// The symbols with at least one recorded quote.
    #[must_use]
    pub fn symbols(&self) -> Vec<&'static str> {
        self.quotes.keys().copied().collect()
    }

    /// How many quotes are held for `symbol`.
    #[must_use]
    pub fn len_of(&self, symbol: &str) -> usize {
        self.quotes.get(symbol).map_or(0, Vec::len)
    }

    /// Drop everything older than `keep_from_tick` for every symbol.
    ///
    /// Memory is bounded by the caller, not by this crate: a store that grew
    /// without limit would eventually be the outage. The hash is *not*
    /// rewound — it is a record of what was ever accepted, and pruning
    /// working memory does not un-accept anything.
    pub fn prune_before(&mut self, keep_from_tick: u64) -> u64 {
        let mut dropped = 0u64;
        for series in self.quotes.values_mut() {
            let cut = series.partition_point(|q| q.tick < keep_from_tick);
            dropped = dropped.saturating_add(cut as u64);
            series.drain(..cut);
        }
        dropped
    }
}

/// A stable per-symbol word for the hash.
fn seed_of(symbol: &str) -> u64 {
    symbol
        .bytes()
        .fold(FNV_OFFSET, |hash, byte| fnv(hash, u64::from(byte)))
}

/// Parse a decimal price string into raw units, exactly.
///
/// `"1.08500"` → `108_500_000`. Up to eight decimal places; more are refused
/// rather than rounded, because a provider that sends nine places is sending
/// a precision this system does not represent and the loss should be visible.
#[must_use]
pub fn parse_price_raw(text: &str) -> Option<i128> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let (whole, frac) = match text.split_once('.') {
        Some((w, f)) => (w, f),
        None => (text, ""),
    };
    if whole.is_empty() && frac.is_empty() {
        return None;
    }
    if !whole.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if frac.len() > 8 || whole.len() > 24 {
        return None;
    }
    let whole_value: i128 = if whole.is_empty() {
        0
    } else {
        whole.parse().ok()?
    };
    let mut frac_value: i128 = if frac.is_empty() {
        0
    } else {
        frac.parse().ok()?
    };
    for _ in frac.len()..8 {
        frac_value = frac_value.checked_mul(10)?;
    }
    whole_value
        .checked_mul(100_000_000)?
        .checked_add(frac_value)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use crate::candle::interval;

    // 1970-01-05 10:00 UTC, a Monday — every session is open.
    const OPEN: u64 = 1_526_400;

    fn eurusd() -> &'static Instrument {
        find("EURUSD").unwrap()
    }

    /// INV-050 — a quote that fails validation never enters the store.
    #[test]
    fn inv_050_invalid_quotes_are_refused_and_leave_no_trace() {
        let mut store = FeedStore::new();
        let before = store.state_hash();
        assert!(
            store
                .record("EURUSD", OPEN, 1, 108_500_000, 108_400_000)
                .is_err(),
            "crossed"
        );
        assert!(
            store.record("EURUSD", OPEN, 1, 0, 108_400_000).is_err(),
            "zero"
        );
        assert!(
            store
                .record("EURUSD", OPEN, 1, 100_000_000, 120_000_000)
                .is_err(),
            "absurd spread"
        );
        assert_eq!(
            store.record("NOTREAL", OPEN, 1, 1, 2),
            Err(MarketError::UnknownInstrument)
        );
        assert!(store.is_empty());
        assert_eq!(store.state_hash(), before, "a refusal changes nothing");
        assert_eq!(
            store.record("EURUSD", OPEN, 1, 108_500_000, 108_520_000),
            Ok(Recorded::Accepted)
        );
        assert_eq!(store.len(), 1);
    }

    /// INV-122 — the same quote applied twice is applied once.
    #[test]
    fn inv_122_a_duplicate_is_applied_exactly_once() {
        let mut store = FeedStore::new();
        store
            .record("EURUSD", OPEN, 7, 108_500_000, 108_520_000)
            .unwrap();
        let hash = store.state_hash();
        assert_eq!(
            store.record("EURUSD", OPEN, 7, 108_500_000, 108_520_000),
            Ok(Recorded::Duplicate)
        );
        assert_eq!(store.len(), 1);
        assert_eq!(store.state_hash(), hash);
        // A different sequence in the same tick is a different quote.
        assert_eq!(
            store.record("EURUSD", OPEN, 8, 108_510_000, 108_530_000),
            Ok(Recorded::Accepted)
        );
        assert_eq!(store.len(), 2);
    }

    /// INV-054 — the same records in the same order give the same hash, and
    /// a different order or content gives a different one.
    #[test]
    fn inv_054_the_hash_is_a_function_of_the_records_in_order() {
        let mut a = FeedStore::new();
        let mut b = FeedStore::new();
        for (tick, seq) in [(OPEN, 1), (OPEN + 1, 1), (OPEN + 1, 2)] {
            a.record("EURUSD", tick, seq, 108_500_000, 108_520_000)
                .unwrap();
            b.record("EURUSD", tick, seq, 108_500_000, 108_520_000)
                .unwrap();
        }
        assert_eq!(a.state_hash(), b.state_hash());
        let mut c = FeedStore::new();
        c.record("EURUSD", OPEN + 1, 1, 108_500_000, 108_520_000)
            .unwrap();
        c.record("EURUSD", OPEN, 1, 108_500_000, 108_520_000)
            .unwrap();
        assert_ne!(a.state_hash(), c.state_hash(), "arrival order is recorded");
        let mut d = FeedStore::new();
        d.record("EURUSD", OPEN, 1, 108_500_001, 108_520_000)
            .unwrap();
        assert_ne!(a.state_hash(), d.state_hash());
    }

    #[test]
    fn out_of_order_arrivals_are_kept_in_tick_order_and_counted() {
        let mut store = FeedStore::new();
        store
            .record("EURUSD", OPEN + 10, 1, 108_600_000, 108_620_000)
            .unwrap();
        assert_eq!(
            store.record("EURUSD", OPEN + 5, 1, 108_500_000, 108_520_000),
            Ok(Recorded::OutOfOrder)
        );
        assert_eq!(store.out_of_order(), 1);
        assert_eq!(
            store.latest_at("EURUSD", OPEN + 7).unwrap().bid_raw,
            108_500_000
        );
        assert_eq!(
            store.latest_at("EURUSD", OPEN + 10).unwrap().bid_raw,
            108_600_000
        );
        assert_eq!(store.latest_at("EURUSD", OPEN), None);
        assert_eq!(store.last_tick("EURUSD"), Some(OPEN + 10));
    }

    /// INV-053 — a recorded quote is frozen outside the session, like a
    /// synthetic one.
    #[test]
    fn inv_053_recorded_quotes_freeze_at_the_close() {
        let mut store = FeedStore::new();
        // Friday 1970-01-09 21:59 UTC.
        let before_close = (8 * 86_400_000 + 21 * 3_600_000 + 59 * 60_000) / crate::TICK_MS;
        store
            .record("EURUSD", before_close, 1, 108_500_000, 108_520_000)
            .unwrap();
        let saturday = (9 * 86_400_000 + 12 * 3_600_000) / crate::TICK_MS;
        // A quote that somehow arrived on Saturday is recorded but never
        // served as live: the session says closed, so the last open tick wins.
        store
            .record("EURUSD", saturday, 1, 109_000_000, 109_020_000)
            .unwrap();
        let quote = store.quote_at(eurusd(), saturday + 100).unwrap();
        assert!(!quote.session_open());
        assert_eq!(quote.bid().raw(), 108_500_000);
        let live = store.quote_at(eurusd(), before_close).unwrap();
        assert!(live.session_open());
        assert_eq!(live.tick(), before_close);
    }

    #[test]
    fn candles_come_from_recorded_mids_only() {
        let mut store = FeedStore::new();
        let one_minute = interval("1m").unwrap();
        let base = OPEN - OPEN % one_minute.ticks;
        // Two minutes of quotes, then a gap, then one more.
        for i in 0..480u64 {
            let mid = 108_000_000 + i128::from(i) * 1_000;
            store
                .record("EURUSD", base + i, 1, mid - 10_000, mid + 10_000)
                .unwrap();
        }
        store
            .record("EURUSD", base + 1_000, 1, 110_000_000, 110_020_000)
            .unwrap();
        let built = store
            .candles(eurusd(), one_minute, base + 1_100, 10)
            .unwrap();
        // Windows with no quotes produce no candle: minutes 0, 1 and 4 only.
        assert_eq!(built.len(), 3);
        assert_eq!(built[0].open, 108_000_000);
        assert_eq!(built[0].close, 108_000_000 + 239_000);
        assert_eq!(built[1].open, 108_000_000 + 240_000);
        assert_eq!(built[2].open, 110_010_000);
        assert!(built[0].high >= built[0].low);
        assert!(store.candles(eurusd(), one_minute, base, 0).is_err());
        assert!(FeedStore::new()
            .candles(eurusd(), one_minute, base, 5)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn pruning_bounds_memory_without_rewriting_history() {
        let mut store = FeedStore::new();
        for i in 0..100u64 {
            store
                .record("BTCUSD", OPEN + i, 1, 6_820_000_000_000, 6_820_100_000_000)
                .unwrap();
        }
        let hash = store.state_hash();
        assert_eq!(store.prune_before(OPEN + 90), 90);
        assert_eq!(store.len_of("BTCUSD"), 10);
        assert_eq!(store.state_hash(), hash);
        assert_eq!(store.len(), 100, "the count is of everything ever accepted");
        assert_eq!(store.symbols(), vec!["BTCUSD"]);
    }

    #[test]
    fn decimal_prices_parse_exactly_or_not_at_all() {
        assert_eq!(parse_price_raw("1.08500"), Some(108_500_000));
        assert_eq!(parse_price_raw("2350"), Some(235_000_000_000));
        assert_eq!(parse_price_raw("68200.12345678"), Some(6_820_012_345_678));
        assert_eq!(parse_price_raw(".5"), Some(50_000_000));
        assert_eq!(parse_price_raw("1.123456789"), None, "nine places");
        assert_eq!(parse_price_raw("-1.0"), None);
        assert_eq!(parse_price_raw("1e5"), None);
        assert_eq!(parse_price_raw(""), None);
        assert_eq!(parse_price_raw("."), None);
    }
}

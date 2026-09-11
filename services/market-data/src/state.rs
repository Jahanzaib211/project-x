//! The feed as this service holds it: the record, the modes, the log.
//!
//! ## Two ways to price, one answer per tick
//!
//! Every instrument is at any tick in exactly one **mode**:
//!
//! - **synthetic** — the pure function of the tick in `market-core`. Free
//!   history, exact replay, no provider. What a fresh install runs on.
//! - **recorded** — quotes that arrived from a provider through the feed
//!   gateway and were validated into the [`FeedStore`].
//!
//! Mode changes are effects and are logged with the tick they took effect at,
//! so the mode *at any past tick* is a lookup, not a guess. That is what keeps
//! INV-052 true once real prices exist: "the quote for EURUSD at tick T" is
//! answered the same way tomorrow as it is now.
//!
//! ## The log
//!
//! Same discipline as the ledger's journal: effects are appended, `fsync`ed,
//! and folded back in on restart. A torn last line is discarded. Three record
//! types — `tick`, `mode`, `config` — and nothing else.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use market_core::candle::Interval;
use market_core::feed::{parse_price_raw, FeedStore, Recorded};
use market_core::instrument::{find, Instrument, INSTRUMENTS};
use market_core::{quote_at, Candle, MarketError, Quote, TICK_MS};
use service_kit::json::{escape, Value};

/// Where an instrument's prices come from at a tick.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The pure function of the tick.
    Synthetic,
    /// The recorded feed, from the named provider.
    Recorded(String),
}

impl Mode {
    fn name(&self) -> &str {
        match self {
            Self::Synthetic => "synthetic",
            Self::Recorded(_) => "recorded",
        }
    }

    fn source(&self) -> &str {
        match self {
            Self::Synthetic => "synthetic",
            Self::Recorded(source) => source,
        }
    }
}

/// One provider as the gateway last described it.
#[derive(Clone, Debug, Default)]
pub struct AdapterHealth {
    /// `connected`, `connecting`, `disconnected`, `unconfigured`, `open`…
    pub state: String,
    /// Epoch ms of the last tick it produced, if any.
    pub last_tick_ms: Option<u64>,
    /// Ticks per second over its recent window.
    pub ticks_per_second: String,
    /// Consecutive errors.
    pub errors: u64,
    /// Human detail.
    pub detail: String,
    /// Epoch ms this report was received.
    pub reported_ms: u64,
}

/// How long a recorded feed may be silent before the mode falls back.
pub const RECORDED_STALE_MS: u64 = 15_000;

/// A tick may arrive this far in the future before it is refused as a
/// clock problem rather than a price.
const MAX_FUTURE_MS: u64 = 5_000;

/// A tick may arrive this far in the past (backfill) before it is refused.
const MAX_BACKFILL_MS: u64 = 14 * 24 * 3_600_000;

/// How much of the record is kept in memory, in ticks. Older quotes are
/// pruned from memory; they stay in the log.
pub const RETENTION_TICKS: u64 = 7 * 24 * 3_600_000 / TICK_MS;

/// Why an ingest was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IngestError {
    /// A field was missing or malformed.
    Bad(String),
    /// The log could not be written; nothing was recorded.
    NotDurable(String),
}

impl core::fmt::Display for IngestError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Bad(detail) => f.write_str(detail),
            Self::NotDurable(detail) => write!(f, "not durable: {detail}"),
        }
    }
}

/// The outcome of one ingested batch.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IngestReport {
    /// Recorded in order.
    pub accepted: u64,
    /// Recorded, but earlier than something already held.
    pub out_of_order: u64,
    /// Already held.
    pub duplicates: u64,
    /// Refused, with the reason of the first refusal.
    pub refused: u64,
    /// The first refusal, if any.
    pub first_refusal: Option<String>,
}

/// The whole feed state.
pub struct FeedState {
    store: FeedStore,
    /// Class name → ordered sources, the last of which may be `synthetic`.
    config: BTreeMap<String, Vec<String>>,
    /// Symbol → mode transitions, in tick order.
    modes: BTreeMap<&'static str, Vec<(u64, Mode)>>,
    adapters: BTreeMap<String, AdapterHealth>,
    log_path: Option<PathBuf>,
    log: Option<File>,
    refused: u64,
}

/// The default source order per class: real feeds first, the pure function
/// last — so a fresh install prices synthetically and switches the moment a
/// provider speaks.
fn default_config() -> BTreeMap<String, Vec<String>> {
    let mut config = BTreeMap::new();
    for (class, sources) in [
        (
            "FX major",
            vec!["mt5", "twelvedata", "finnhub", "synthetic"],
        ),
        ("Metal", vec!["mt5", "twelvedata", "finnhub", "synthetic"]),
        ("Crypto", vec!["binance", "mt5", "synthetic"]),
    ] {
        config.insert(
            class.to_owned(),
            sources.into_iter().map(str::to_owned).collect(),
        );
    }
    config
}

impl FeedState {
    /// An empty state with no durable log. Used by tests.
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            store: FeedStore::new(),
            config: default_config(),
            modes: BTreeMap::new(),
            adapters: BTreeMap::new(),
            log_path: None,
            log: None,
            refused: 0,
        }
    }

    /// Open the state at `path`, replaying whatever is there.
    ///
    /// # Errors
    /// The log could not be read or opened for appending.
    pub fn open(path: &Path, now_tick: u64) -> Result<Self, String> {
        let mut state = Self::in_memory();
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
                let Ok(record) = service_kit::json::parse(&line) else {
                    break;
                };
                state.replay(&record)?;
            }
        }
        // Working memory is bounded; the log is the record.
        let keep_from = now_tick.saturating_sub(RETENTION_TICKS);
        state.store.prune_before(keep_from);

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|err| err.to_string())?;
        state.log_path = Some(path.to_path_buf());
        state.log = Some(file);
        Ok(state)
    }

    fn append_log(&mut self, line: &str) -> Result<(), String> {
        self.write_log(line)?;
        self.sync_log()
    }

    /// Write one record without forcing it to disk. Paired with
    /// [`FeedState::sync_log`]: a batch of ticks is one durability unit, and
    /// one `fsync` per batch is what keeps a thousand-tick backfill from
    /// holding the lock for a thousand disk round trips.
    fn write_log(&mut self, line: &str) -> Result<(), String> {
        let Some(file) = self.log.as_mut() else {
            return Ok(());
        };
        writeln!(file, "{line}").map_err(|err| err.to_string())
    }

    fn sync_log(&mut self) -> Result<(), String> {
        let Some(file) = self.log.as_mut() else {
            return Ok(());
        };
        file.sync_all().map_err(|err| err.to_string())
    }

    fn replay(&mut self, record: &Value) -> Result<(), String> {
        match record.str_field("type") {
            Some("tick") => {
                let symbol = record.str_field("symbol").ok_or("tick without symbol")?;
                let tick = record
                    .get("tick")
                    .and_then(Value::as_u64)
                    .ok_or("tick without tick")?;
                let seq = record.get("seq").and_then(Value::as_u64).unwrap_or(0);
                let bid = record
                    .str_field("bid")
                    .and_then(parse_price_raw)
                    .ok_or("tick without bid")?;
                let ask = record
                    .str_field("ask")
                    .and_then(parse_price_raw)
                    .ok_or("tick without ask")?;
                // Replayed as written. A record that was valid when accepted
                // is valid now; a record that is not is a corrupted log, and
                // that is worth stopping for.
                self.store
                    .record(symbol, tick, seq, bid, ask)
                    .map(|_| ())
                    .map_err(|err| format!("corrupt tick record: {err}"))
            }
            Some("mode") => {
                let symbol = record.str_field("symbol").ok_or("mode without symbol")?;
                let instrument = find(symbol).ok_or("mode for an unknown symbol")?;
                let tick = record
                    .get("tick")
                    .and_then(Value::as_u64)
                    .ok_or("mode without tick")?;
                let mode = match record.str_field("mode") {
                    Some("synthetic") => Mode::Synthetic,
                    Some("recorded") => {
                        Mode::Recorded(record.str_field("source").unwrap_or("unknown").to_owned())
                    }
                    _ => return Err("malformed mode record".to_owned()),
                };
                self.modes
                    .entry(instrument.symbol)
                    .or_default()
                    .push((tick, mode));
                Ok(())
            }
            Some("config") => {
                let Some(Value::Object(classes)) = record.get("classes") else {
                    return Err("malformed config record".to_owned());
                };
                for (class, sources) in classes {
                    let Value::Array(items) = sources else {
                        continue;
                    };
                    let list: Vec<String> = items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect();
                    self.config.insert(class.clone(), list);
                }
                Ok(())
            }
            _ => Err("unknown record type".to_owned()),
        }
    }

    /// The mode in effect for `symbol` at `tick`.
    #[must_use]
    pub fn mode_at(&self, symbol: &str, tick: u64) -> Mode {
        self.modes
            .get(symbol)
            .and_then(|transitions| {
                let end = transitions.partition_point(|(at, _)| *at <= tick);
                end.checked_sub(1)
                    .and_then(|i| transitions.get(i))
                    .map(|(_, mode)| mode.clone())
            })
            .unwrap_or(Mode::Synthetic)
    }

    /// The ordered sources configured for an instrument's class.
    #[must_use]
    pub fn sources_for(&self, instrument: &Instrument) -> Vec<String> {
        self.config
            .get(instrument.class)
            .cloned()
            .unwrap_or_else(|| vec!["synthetic".to_owned()])
    }

    /// Whether the class may fall back to the pure function.
    fn synthetic_allowed(&self, instrument: &Instrument) -> bool {
        self.sources_for(instrument)
            .iter()
            .any(|source| source == "synthetic")
    }

    /// The configuration, class → sources.
    #[must_use]
    pub fn config(&self) -> &BTreeMap<String, Vec<String>> {
        &self.config
    }

    /// Replace the source order for one class. Logged, so replay sees it.
    ///
    /// # Errors
    /// An unknown class or source, or a log write failure.
    pub fn set_sources(&mut self, class: &str, sources: Vec<String>) -> Result<(), String> {
        if !INSTRUMENTS.iter().any(|i| i.class == class) {
            return Err(format!("no instrument class {class}"));
        }
        for source in &sources {
            if !KNOWN_SOURCES.contains(&source.as_str()) {
                return Err(format!("unknown source {source}"));
            }
        }
        if sources.is_empty() {
            return Err("at least one source is required".to_owned());
        }
        let mut next = self.config.clone();
        next.insert(class.to_owned(), sources);
        self.append_log(&config_record(&next))?;
        self.config = next;
        Ok(())
    }

    fn set_mode(&mut self, instrument: &Instrument, tick: u64, mode: Mode) -> Result<(), String> {
        if self.mode_at(instrument.symbol, tick) == mode {
            return Ok(());
        }
        self.append_log(&mode_record(instrument.symbol, tick, &mode))?;
        self.modes
            .entry(instrument.symbol)
            .or_default()
            .push((tick, mode));
        Ok(())
    }

    /// Ingest one batch of ticks from `source`.
    ///
    /// Each tick is validated (INV-050), recorded, logged, and — if the source
    /// is one the instrument's class is configured to use — switches the
    /// instrument to recorded mode from that tick.
    ///
    /// # Errors
    /// [`IngestError::Bad`] for a malformed batch; individual refusals are
    /// counted in the report rather than failing the batch.
    pub fn ingest(
        &mut self,
        source: &str,
        ticks: &[Value],
        now_tick: u64,
    ) -> Result<IngestReport, IngestError> {
        if !KNOWN_SOURCES.contains(&source) || source == "synthetic" {
            return Err(IngestError::Bad(format!("unknown source {source}")));
        }
        let mut report = IngestReport::default();
        let now_ms = market_core::epoch_ms_of(now_tick);

        for item in ticks {
            let Some(symbol) = item.str_field("symbol") else {
                refuse(&mut report, "tick without symbol");
                continue;
            };
            let Some(instrument) = find(symbol) else {
                refuse(&mut report, &format!("unknown instrument {symbol}"));
                continue;
            };
            let ms = item.get("ms").and_then(Value::as_u64).unwrap_or(now_ms);
            if ms > now_ms.saturating_add(MAX_FUTURE_MS) {
                refuse(&mut report, "tick timestamp is in the future");
                continue;
            }
            if ms.saturating_add(MAX_BACKFILL_MS) < now_ms {
                refuse(&mut report, "tick timestamp is too old to backfill");
                continue;
            }
            let tick = market_core::tick_of(ms);
            let seq = item.get("seq").and_then(Value::as_u64).unwrap_or(0);
            let (Some(bid), Some(ask)) = (
                item.str_field("bid").and_then(parse_price_raw),
                item.str_field("ask").and_then(parse_price_raw),
            ) else {
                refuse(&mut report, "bid and ask must be decimal strings");
                continue;
            };
            // Snap to the instrument's grid: a provider quoting more places
            // than the instrument has is quoting a price it cannot trade at.
            let bid = instrument.on_grid(bid);
            let ask = instrument.on_grid(ask);

            // Written now, forced to disk once for the whole batch below: the
            // batch is acknowledged as a unit, so it is made durable as one.
            let line = tick_record(instrument.symbol, tick, seq, instrument, bid, ask, source);
            match self.store.record(instrument.symbol, tick, seq, bid, ask) {
                Ok(Recorded::Duplicate) => {
                    report.duplicates = report.duplicates.saturating_add(1);
                    continue;
                }
                Ok(outcome) => {
                    if let Err(err) = self.write_log(&line) {
                        return Err(IngestError::NotDurable(err));
                    }
                    if outcome == Recorded::OutOfOrder {
                        report.out_of_order = report.out_of_order.saturating_add(1);
                    } else {
                        report.accepted = report.accepted.saturating_add(1);
                    }
                }
                Err(err) => {
                    self.refused = self.refused.saturating_add(1);
                    refuse(&mut report, &err.to_string());
                    continue;
                }
            }

            // A configured source speaking puts the instrument on the record
            // from now — not from the tick's own time, which may be backfill.
            let configured = self.sources_for(instrument).iter().any(|s| s == source);
            if configured && tick.saturating_add(RECORDED_STALE_MS / TICK_MS) >= now_tick {
                let mode = Mode::Recorded(source.to_owned());
                if self.mode_at(instrument.symbol, now_tick) != mode {
                    self.set_mode(instrument, now_tick, mode)
                        .map_err(IngestError::NotDurable)?;
                }
            }
        }
        // One sync for the batch. Nothing above was acknowledged yet.
        self.sync_log().map_err(IngestError::NotDurable)?;
        Ok(report)
    }

    /// The watchdog: an instrument on a recorded feed that has gone silent
    /// falls back to the pure function, if its class allows that. Called
    /// once a second by the service.
    ///
    /// # Errors
    /// A log write failure.
    pub fn watchdog(&mut self, now_tick: u64) -> Result<Vec<&'static str>, String> {
        let mut fell_back = Vec::new();
        for instrument in INSTRUMENTS {
            let Mode::Recorded(_) = self.mode_at(instrument.symbol, now_tick) else {
                continue;
            };
            // A closed market is silent by definition; that is not staleness.
            if !market_core::session::is_open(instrument.session, now_tick) {
                continue;
            }
            let silent_ticks = self
                .store
                .last_tick(instrument.symbol)
                .map_or(u64::MAX, |last| now_tick.saturating_sub(last));
            if silent_ticks.saturating_mul(TICK_MS) > RECORDED_STALE_MS
                && self.synthetic_allowed(instrument)
            {
                self.set_mode(instrument, now_tick, Mode::Synthetic)?;
                fell_back.push(instrument.symbol);
            }
        }
        Ok(fell_back)
    }

    /// The canonical quote for `instrument` at `tick`.
    ///
    /// # Errors
    /// [`MarketError::Stale`] when the instrument is on a recorded feed that
    /// holds nothing usable at `tick` and the class may not fall back.
    pub fn quote(&self, instrument: &Instrument, tick: u64) -> Result<Quote, MarketError> {
        match self.mode_at(instrument.symbol, tick) {
            Mode::Synthetic => quote_at(instrument, tick),
            Mode::Recorded(_) => match self.store.quote_at(instrument, tick) {
                Some(quote) => Ok(quote),
                None if self.synthetic_allowed(instrument) => quote_at(instrument, tick),
                None => Err(MarketError::Stale {
                    age_ms: u64::MAX,
                    max_age_ms: RECORDED_STALE_MS,
                }),
            },
        }
    }

    /// Candles for `instrument`, from whichever feed is in effect now.
    ///
    /// # Errors
    /// As [`market_core::candle::candles`].
    pub fn candles(
        &self,
        instrument: &Instrument,
        interval: &Interval,
        latest_tick: u64,
        count: usize,
    ) -> Result<Vec<Candle>, MarketError> {
        match self.mode_at(instrument.symbol, latest_tick) {
            Mode::Synthetic => {
                market_core::candle::candles(instrument, interval, latest_tick, count)
            }
            Mode::Recorded(_) => {
                let recorded = self
                    .store
                    .candles(instrument, interval, latest_tick, count)?;
                if recorded.is_empty() && self.synthetic_allowed(instrument) {
                    return market_core::candle::candles(instrument, interval, latest_tick, count);
                }
                Ok(recorded)
            }
        }
    }

    /// Record what the gateway says about a provider.
    pub fn report_adapter(&mut self, name: &str, health: AdapterHealth) {
        self.adapters.insert(name.to_owned(), health);
    }

    /// The store, for status views.
    #[must_use]
    pub const fn store(&self) -> &FeedStore {
        &self.store
    }

    /// Every adapter report held.
    #[must_use]
    pub const fn adapters(&self) -> &BTreeMap<String, AdapterHealth> {
        &self.adapters
    }

    /// How many quotes were refused at the door, ever (this process).
    #[must_use]
    pub const fn refused(&self) -> u64 {
        self.refused
    }

    /// The current source of `instrument`'s prices, as a status line.
    #[must_use]
    pub fn status_of(&self, instrument: &Instrument, now_tick: u64) -> String {
        let mode = self.mode_at(instrument.symbol, now_tick);
        let last = self.store.last_tick(instrument.symbol);
        let age_ms = last.map(|t| now_tick.saturating_sub(t).saturating_mul(TICK_MS));
        format!(
            r#"{{"symbol":"{}","class":"{}","mode":"{}","source":"{}","recordedQuotes":{},"lastRecordedMs":{},"recordedAgeMs":{},"sources":[{}],"session":{}}}"#,
            escape(instrument.symbol),
            escape(instrument.class),
            mode.name(),
            escape(mode.source()),
            self.store.len_of(instrument.symbol),
            last.map_or_else(
                || "null".to_owned(),
                |t| market_core::epoch_ms_of(t).to_string()
            ),
            age_ms.map_or_else(|| "null".to_owned(), |a| a.to_string()),
            self.sources_for(instrument)
                .iter()
                .map(|s| format!("\"{}\"", escape(s)))
                .collect::<Vec<_>>()
                .join(","),
            market_core::session::state_json(instrument.session, now_tick),
        )
    }
}

/// Every source the gateway may name. `synthetic` is not a gateway source;
/// it is what the service does itself.
pub const KNOWN_SOURCES: &[&str] = &[
    "synthetic",
    "binance",
    "twelvedata",
    "finnhub",
    "mt5",
    "sim-lp",
];

fn refuse(report: &mut IngestReport, why: &str) {
    report.refused = report.refused.saturating_add(1);
    if report.first_refusal.is_none() {
        report.first_refusal = Some(why.to_owned());
    }
}

fn tick_record(
    symbol: &str,
    tick: u64,
    seq: u64,
    instrument: &Instrument,
    bid: i128,
    ask: i128,
    source: &str,
) -> String {
    // Prices are logged as the decimal strings they are served as, at full
    // raw precision, so the log reads as a quote tape and replays exactly.
    format!(
        r#"{{"type":"tick","symbol":"{}","tick":{tick},"seq":{seq},"bid":"{}","ask":"{}","source":"{}"}}"#,
        escape(symbol),
        raw_to_decimal(bid, instrument),
        raw_to_decimal(ask, instrument),
        escape(source)
    )
}

/// A raw price as a decimal string at the instrument's precision.
fn raw_to_decimal(raw: i128, instrument: &Instrument) -> String {
    instrument.format_price(raw)
}

fn mode_record(symbol: &str, tick: u64, mode: &Mode) -> String {
    format!(
        r#"{{"type":"mode","symbol":"{}","tick":{tick},"mode":"{}","source":"{}"}}"#,
        escape(symbol),
        mode.name(),
        escape(mode.source())
    )
}

fn config_record(config: &BTreeMap<String, Vec<String>>) -> String {
    format!(r#"{{"type":"config","classes":{}}}"#, config_json(config))
}

/// The configuration as JSON, for the gateway and the console.
#[must_use]
pub fn config_json(config: &BTreeMap<String, Vec<String>>) -> String {
    let classes = config
        .iter()
        .map(|(class, sources)| {
            format!(
                r#""{}":[{}]"#,
                escape(class),
                sources
                    .iter()
                    .map(|s| format!("\"{}\"", escape(s)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{classes}}}")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use std::io::Read;

    // 1970-01-05 10:00 UTC, a Monday.
    const OPEN: u64 = 1_526_400;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "projectx-feed-test-{name}-{}.log",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&path);
            Self(path)
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

    fn ticks(json: &str) -> Vec<Value> {
        match service_kit::json::parse(json).unwrap() {
            Value::Array(items) => items,
            _ => panic!("not an array"),
        }
    }

    fn btc() -> &'static Instrument {
        find("BTCUSD").unwrap()
    }

    /// A fresh state is synthetic everywhere and prices exactly as the pure
    /// function does.
    #[test]
    fn a_fresh_state_is_synthetic_and_identical_to_the_pure_function() {
        let state = FeedState::in_memory();
        for instrument in INSTRUMENTS {
            assert_eq!(state.mode_at(instrument.symbol, OPEN), Mode::Synthetic);
            assert_eq!(state.quote(instrument, OPEN), quote_at(instrument, OPEN));
        }
    }

    /// INV-050 at the service door: a bad tick is refused and counted, a good
    /// one recorded, and a configured source switches the mode from *now*.
    #[test]
    fn inv_050_ingest_validates_records_and_switches_mode() {
        let mut state = FeedState::in_memory();
        let now_ms = market_core::epoch_ms_of(OPEN);
        let report = state
            .ingest(
                "binance",
                &ticks(&format!(
                    r#"[{{"symbol":"BTCUSD","ms":{now_ms},"seq":1,"bid":"68200.10","ask":"68201.30"}},
                        {{"symbol":"BTCUSD","ms":{now_ms},"seq":1,"bid":"68200.10","ask":"68201.30"}},
                        {{"symbol":"BTCUSD","ms":{now_ms},"seq":2,"bid":"68300.00","ask":"68200.00"}},
                        {{"symbol":"NOPE","ms":{now_ms},"seq":1,"bid":"1","ask":"2"}},
                        {{"symbol":"BTCUSD","ms":{},"seq":3,"bid":"1","ask":"2"}}]"#,
                    now_ms + 60_000
                )),
                OPEN,
            )
            .unwrap();
        assert_eq!(report.accepted, 1);
        assert_eq!(report.duplicates, 1);
        assert_eq!(report.refused, 3, "{report:?}");
        assert_eq!(
            state.mode_at("BTCUSD", OPEN),
            Mode::Recorded("binance".to_owned())
        );
        assert_eq!(
            state.mode_at("BTCUSD", OPEN - 1),
            Mode::Synthetic,
            "the past is unchanged"
        );
        let quote = state.quote(btc(), OPEN).unwrap();
        assert_eq!(quote.bid().raw(), 6_820_010_000_000);
        // A source the class is not configured for is recorded but does not
        // take over.
        state
            .ingest(
                "finnhub",
                &ticks(&format!(
                    r#"[{{"symbol":"BTCUSD","ms":{now_ms},"seq":9,"bid":"1.00","ask":"1.01"}}]"#
                )),
                OPEN,
            )
            .unwrap();
        assert_eq!(
            state.mode_at("BTCUSD", OPEN),
            Mode::Recorded("binance".to_owned())
        );
        assert!(state.ingest("synthetic", &[], OPEN).is_err());
        assert!(state.ingest("nonsense", &[], OPEN).is_err());
    }

    /// The watchdog falls back to the pure function when a recorded feed goes
    /// quiet on an open market — and only if the class allows it.
    #[test]
    fn a_silent_recorded_feed_falls_back_when_allowed() {
        let mut state = FeedState::in_memory();
        let now_ms = market_core::epoch_ms_of(OPEN);
        state
            .ingest("binance", &ticks(&format!(r#"[{{"symbol":"BTCUSD","ms":{now_ms},"seq":1,"bid":"68200.10","ask":"68201.30"}}]"#)), OPEN)
            .unwrap();
        assert!(
            state.watchdog(OPEN + 4).unwrap().is_empty(),
            "a second of silence is fine"
        );
        let later = OPEN + RECORDED_STALE_MS / TICK_MS + 1;
        assert_eq!(state.watchdog(later).unwrap(), vec!["BTCUSD"]);
        assert_eq!(state.mode_at("BTCUSD", later), Mode::Synthetic);
        assert_eq!(
            state.mode_at("BTCUSD", OPEN + 4),
            Mode::Recorded("binance".to_owned())
        );

        // Configured without a synthetic fallback: it stays recorded, and a
        // quote far ahead is served as the stale one it is.
        state
            .set_sources("Crypto", vec!["binance".to_owned()])
            .unwrap();
        state
            .ingest(
                "binance",
                &ticks(&format!(
                    r#"[{{"symbol":"BTCUSD","ms":{},"seq":2,"bid":"68200.10","ask":"68201.30"}}]"#,
                    market_core::epoch_ms_of(later)
                )),
                later,
            )
            .unwrap();
        let much_later = later + 1_000;
        assert!(state.watchdog(much_later).unwrap().is_empty());
        let stale = state.quote(btc(), much_later).unwrap();
        assert_eq!(stale.tick(), later, "the quote carries its real age");
        assert!(stale.age_ms(much_later) > RECORDED_STALE_MS);
        assert!(state.set_sources("Crypto", vec![]).is_err());
        assert!(state
            .set_sources("Crypto", vec!["nasa".to_owned()])
            .is_err());
        assert!(state.set_sources("Bonds", vec!["mt5".to_owned()]).is_err());
    }

    /// INV-054 — a state reopened from its log holds exactly what was written:
    /// the same store hash, the same modes at the same ticks, the same config.
    #[test]
    fn inv_054_the_state_replays_from_its_log_identically() {
        let scratch = Scratch::new("replay");
        let now_ms = market_core::epoch_ms_of(OPEN);
        let (hash, count) = {
            let mut state = FeedState::open(&scratch.0, OPEN).unwrap();
            state
                .set_sources("Crypto", vec!["binance".to_owned(), "synthetic".to_owned()])
                .unwrap();
            state
                .ingest("binance", &ticks(&format!(
                    r#"[{{"symbol":"BTCUSD","ms":{now_ms},"seq":1,"bid":"68200.10","ask":"68201.30"}},
                        {{"symbol":"BTCUSD","ms":{},"seq":1,"bid":"68210.10","ask":"68211.30"}}]"#,
                    now_ms + 250
                )), OPEN + 1)
                .unwrap();
            state.watchdog(OPEN + 100_000).unwrap();
            (state.store().state_hash(), state.store().len())
        };
        let text = scratch.text();
        assert_eq!(text.matches(r#""type":"tick""#).count(), 2);
        assert_eq!(text.matches(r#""type":"mode""#).count(), 2);
        assert_eq!(text.matches(r#""type":"config""#).count(), 1);

        let reopened = FeedState::open(&scratch.0, OPEN + 100_000).unwrap();
        assert_eq!(reopened.store().state_hash(), hash);
        assert_eq!(reopened.store().len(), count);
        assert_eq!(
            reopened.mode_at("BTCUSD", OPEN + 1),
            Mode::Recorded("binance".to_owned())
        );
        assert_eq!(reopened.mode_at("BTCUSD", OPEN + 100_000), Mode::Synthetic);
        assert_eq!(reopened.config()["Crypto"], vec!["binance", "synthetic"]);
        assert_eq!(
            reopened.quote(btc(), OPEN + 1).unwrap().bid().raw(),
            6_821_010_000_000
        );

        // A torn final line is discarded, not fatal.
        {
            let mut file = OpenOptions::new().append(true).open(&scratch.0).unwrap();
            write!(
                file,
                r#"{{"type":"tick","symbol":"BTCUSD","tick":1,"seq":1,"bid":"1"#
            )
            .unwrap();
        }
        let torn = FeedState::open(&scratch.0, OPEN + 100_000).unwrap();
        assert_eq!(torn.store().state_hash(), hash);
    }

    #[test]
    fn candles_follow_the_mode_and_fall_back_when_the_record_is_empty() {
        let mut state = FeedState::in_memory();
        let one_minute = market_core::candle::interval("1m").unwrap();
        let synthetic = state.candles(btc(), one_minute, OPEN, 5).unwrap();
        assert_eq!(synthetic.len(), 5);
        let now_ms = market_core::epoch_ms_of(OPEN);
        state
            .ingest("binance", &ticks(&format!(r#"[{{"symbol":"BTCUSD","ms":{now_ms},"seq":1,"bid":"68200.10","ask":"68201.30"}}]"#)), OPEN)
            .unwrap();
        let recorded = state.candles(btc(), one_minute, OPEN, 5).unwrap();
        assert_eq!(recorded.len(), 1, "only what was recorded");
        assert_eq!(recorded[0].close, 6_820_070_000_000);
        let status = state.status_of(btc(), OPEN);
        assert!(status.contains(r#""mode":"recorded""#));
        assert!(status.contains(r#""source":"binance""#));
        let json = config_json(state.config());
        assert!(json.starts_with('{') && json.ends_with("]}"), "{json}");
        assert!(service_kit::json::parse(&json).is_ok());
    }
}

//! Market state as the ledger receives it.
//!
//! The ledger does not compute a price. It is handed the canonical state for
//! the tick it is deciding on — every instrument's quote, from `06-market-data`
//! — and values, checks and fills against that. `QuoteSet` is that handoff.
//!
//! In the service, a set is fetched over HTTP per request, *before* the core
//! lock is taken, so a slow feed never holds the ledger. In tests, a set is
//! built from the pure synthetic function so nothing needs a socket.

use std::collections::BTreeMap;
use std::time::Duration;

use domain_kernel::{Price, Usd};
use market_core::feed::parse_price_raw;
use market_core::instrument::{find, Instrument};
use market_core::Quote;
use pnl_margin::Marks;
use service_kit::json::Value;

/// Every instrument's quote at one tick.
#[derive(Clone, Debug, Default)]
pub struct QuoteSet {
    quotes: BTreeMap<&'static str, Quote>,
}

impl QuoteSet {
    /// An empty set: nothing is priced, so nothing can be valued or filled.
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    /// The pure synthetic state at `tick`, for tests and for the gate suite.
    #[must_use]
    pub fn synthetic(tick: u64) -> Self {
        let mut quotes = BTreeMap::new();
        for instrument in market_core::instrument::INSTRUMENTS {
            if let Ok(quote) = market_core::quote_at(instrument, tick) {
                quotes.insert(instrument.symbol, quote);
            }
        }
        Self { quotes }
    }

    /// The set described by market-data's `/v1/quotes` body.
    ///
    /// Only the fields the ledger acts on are read: prices, the tick the state
    /// belongs to, and whether the session is open. A quote that fails to
    /// parse is left out rather than guessed, and the instrument is then
    /// simply not priced (fail closed, P7).
    #[must_use]
    pub fn from_json(body: &Value) -> Self {
        let mut quotes = BTreeMap::new();
        let Some(Value::Array(rows)) = body.get("quotes") else {
            return Self { quotes };
        };
        for row in rows {
            let Some(instrument) = row.str_field("symbol").and_then(find) else {
                continue;
            };
            let (Some(bid), Some(ask), Some(tick)) = (
                row.str_field("bid").and_then(parse_price_raw),
                row.str_field("ask").and_then(parse_price_raw),
                row.get("tick").and_then(Value::as_u64),
            ) else {
                continue;
            };
            let Ok(quote) = Quote::validated(
                instrument.symbol,
                tick,
                Price::from_raw(bid),
                Price::from_raw(ask),
            ) else {
                continue;
            };
            let session = row.get("session");
            let open = session
                .and_then(|s| s.get("open"))
                .is_none_or(|v| !matches!(v, Value::Bool(false)));
            let priced = session
                .and_then(|s| s.get("pricedTick"))
                .and_then(Value::as_u64)
                .unwrap_or(tick);
            quotes.insert(
                instrument.symbol,
                if open {
                    quote
                } else {
                    quote.frozen_since(priced)
                },
            );
        }
        Self { quotes }
    }

    /// The quote for `symbol`, if the set holds one.
    #[must_use]
    pub fn get(&self, symbol: &str) -> Option<&Quote> {
        self.quotes.get(symbol)
    }

    /// How many instruments are priced.
    #[must_use]
    pub fn len(&self) -> usize {
        self.quotes.len()
    }

    /// Whether nothing is priced.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.quotes.is_empty()
    }
}

impl Marks for QuoteSet {
    fn mark(&self, symbol: &str) -> Option<Price<Usd>> {
        // Positions are marked at the mid, not at the side they would close on.
        // Marking at the closing side would show a client a loss equal to the
        // spread the instant a position opens, which is true of the exit but not
        // of the holding — and the two are different questions.
        self.quotes.get(symbol).map(Quote::mid)
    }

    fn instrument(&self, symbol: &str) -> Option<&'static Instrument> {
        find(symbol)
    }
}

/// Where the service gets its market state.
pub trait QuoteSource: Send + Sync {
    /// Every instrument's quote at `tick`.
    ///
    /// # Errors
    /// A human-readable reason the state could not be read. The caller fails
    /// closed on it: no state, no valuation, no fill.
    fn quotes_at(&self, tick: u64) -> Result<QuoteSet, String>;
}

/// The pure function, for tests and the in-memory gate runs.
pub struct SyntheticSource;

impl QuoteSource for SyntheticSource {
    fn quotes_at(&self, tick: u64) -> Result<QuoteSet, String> {
        Ok(QuoteSet::synthetic(tick))
    }
}

/// `06-market-data` over HTTP.
pub struct RemoteSource {
    base: String,
}

impl RemoteSource {
    /// A source at `base`, e.g. `http://market-data:8000`.
    #[must_use]
    pub fn new(base: String) -> Self {
        Self { base }
    }
}

impl QuoteSource for RemoteSource {
    fn quotes_at(&self, tick: u64) -> Result<QuoteSet, String> {
        let url = format!("{}/v1/quotes?tick={tick}", self.base);
        let response = service_kit::http::get(&url, Duration::from_millis(1_500))
            .map_err(|err| format!("market-data unreachable: {err}"))?;
        if !response.is_success() {
            return Err(format!("market-data returned {}", response.status));
        }
        let body = response
            .json()
            .map_err(|err| format!("market-data sent malformed JSON: {err}"))?;
        Ok(QuoteSet::from_json(&body))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use market_core::instrument::INSTRUMENTS;

    const OPEN: u64 = 1_526_400;

    /// The set parsed from market-data's wire shape is the set the pure
    /// function produces, tick for tick (INV-052 across a process boundary).
    #[test]
    fn inv_052_a_wire_set_round_trips_the_pure_function() {
        let synthetic = QuoteSet::synthetic(OPEN);
        let rows = INSTRUMENTS
            .iter()
            .map(|instrument| {
                let q = synthetic.get(instrument.symbol).unwrap();
                format!(
                    r#"{{"symbol":"{}","bid":"{}","ask":"{}","tick":{},"session":{{"open":true,"pricedTick":{}}}}}"#,
                    instrument.symbol,
                    instrument.format_price(q.bid().raw()),
                    instrument.format_price(q.ask().raw()),
                    q.tick(),
                    q.tick()
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let body =
            service_kit::json::parse(&format!(r#"{{"tick":{OPEN},"quotes":[{rows}]}}"#)).unwrap();
        let parsed = QuoteSet::from_json(&body);
        assert_eq!(parsed.len(), INSTRUMENTS.len());
        for instrument in INSTRUMENTS {
            assert_eq!(
                parsed.get(instrument.symbol),
                synthetic.get(instrument.symbol)
            );
            assert_eq!(
                parsed.mark(instrument.symbol),
                synthetic.mark(instrument.symbol)
            );
        }
    }

    #[test]
    fn a_frozen_or_malformed_row_is_handled_rather_than_guessed() {
        let body = service_kit::json::parse(
            r#"{"quotes":[
                {"symbol":"XAUUSD","bid":"2350.00","ask":"2350.30","tick":100,"session":{"open":false,"pricedTick":90}},
                {"symbol":"EURUSD","bid":"oops","ask":"1.1","tick":100},
                {"symbol":"NOPE","bid":"1","ask":"2","tick":100},
                {"symbol":"BTCUSD","bid":"2","ask":"1","tick":100}
            ]}"#,
        )
        .unwrap();
        let set = QuoteSet::from_json(&body);
        assert_eq!(set.len(), 1);
        let gold = set.get("XAUUSD").unwrap();
        assert!(!gold.session_open());
        assert_eq!(gold.priced_tick(), 90);
        assert!(set.get("EURUSD").is_none());
        assert!(QuoteSet::empty().is_empty());
        assert!(SyntheticSource.quotes_at(OPEN).unwrap().len() == INSTRUMENTS.len());
    }
}

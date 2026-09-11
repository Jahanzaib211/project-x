//! # 06-market-data
//!
//! Raw provider feeds turned into one canonical, validated, timestamped market
//! state. Everything price-dependent downstream reads this and nothing else.
//!
//! ## Where the non-determinism lives
//!
//! Exactly here, in one function: [`now_tick`] reads the clock. Everything else
//! — the price at a tick, the candles over a window, the spread — is a pure
//! function in `market-core` or a lookup in the recorded feed, so this service
//! is a thin shell around a library that can be tested without a clock, a
//! socket or a sleep.
//!
//! That boundary is the reason a fill can be re-derived from the journal months
//! later: the journal records the tick, and the tick is all you need.
//!
//! ## Two feeds, one state
//!
//! The synthetic series is what a fresh install prices on. The recorded feed
//! is what arrives from providers through the feed gateway (`13-lp-connectivity`)
//! and is validated into [`state::FeedState`], logged, and served from there.
//! Which one an instrument is on at any tick is itself recorded, so a quote
//! for a past tick is the same answer forever (INV-052). See `state.rs`.

mod state;

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use market_core::candle::{interval, INTERVALS, MAX_CANDLES};
use market_core::instrument::{find, INSTRUMENTS};
use market_core::{tick_of, Instrument, Quote, TICK_MS};
use service_kit::json::{escape, Value};
use service_kit::{log, port_from_env, Request, Response, Service, ServiceInfo};
use state::{config_json, AdapterHealth, FeedState, IngestError, KNOWN_SOURCES};

/// The current feed tick.
///
/// The single clock read in this module, and the only source of
/// non-determinism in the whole market-data path. It is annotated rather than
/// hidden: a reviewer looking for "where does time enter the system" should
/// find it in one place (P4, P6).
fn now_tick() -> u64 {
    // ALLOW-BANNED: this service *is* the boundary between the world's clock
    // and the system's tick index. Nothing downstream reads a clock; they all
    // read the tick this produces.
    let millis = SystemTime::now() // ALLOW-BANNED
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    tick_of(u64::try_from(millis).unwrap_or(0))
}

/// One quote, as JSON.
///
/// Prices are decimal strings at the instrument's own precision. They are never
/// JSON numbers: a consumer's parser would turn `1.08500` into a float and the
/// exactness would be gone before it reached anything that cared (P1).
fn quote_json(instrument: &Instrument, quote: &Quote, now: u64) -> String {
    format!(
        r#"{{"symbol":"{}","name":"{}","class":"{}","digits":{},"bid":"{}","ask":"{}","mid":"{}","spreadPoints":{},"tick":{},"timestampMs":{},"ageMs":{},"session":{}}}"#,
        escape(instrument.symbol),
        escape(instrument.name),
        escape(instrument.class),
        instrument.digits,
        instrument.format_price(quote.bid().raw()),
        instrument.format_price(quote.ask().raw()),
        instrument.format_price(quote.mid().raw()),
        instrument.spread_points,
        quote.tick(),
        market_core::epoch_ms_of(quote.tick()),
        quote.age_ms(now),
        // INV-053 — a frozen quote says so, and says when it was priced.
        market_core::session::state_json(instrument.session, quote.tick()),
    )
}

fn instrument_json(instrument: &Instrument) -> String {
    format!(
        r#"{{"symbol":"{}","name":"{}","class":"{}","digits":{},"contractSize":{},"maxLeverage":{},"minVolumeMilliLots":{},"maxVolumeMilliLots":{},"commissionPerLotMinor":{},"sessionKind":"{}","sessionHours":"{}"}}"#,
        escape(instrument.symbol),
        escape(instrument.name),
        escape(instrument.class),
        instrument.digits,
        instrument.contract_size,
        instrument.max_leverage,
        instrument.min_volume_milli_lots,
        instrument.max_volume_milli_lots,
        instrument.commission_per_lot_minor,
        escape(instrument.session.name()),
        escape(instrument.session.hours()),
    )
}

fn error(status: u16, code: &str, detail: &str) -> Response {
    Response::json(
        status,
        format!(
            r#"{{"error":"{}","detail":"{}"}}"#,
            escape(code),
            escape(detail)
        ),
    )
}

fn bad_request(detail: &str) -> Response {
    error(400, "bad_request", detail)
}

#[allow(clippy::too_many_lines)]
fn handle(state: &Mutex<FeedState>, request: &Request, max_staleness_ms: u64) -> Option<Response> {
    // A poisoned lock means a request panicked mid-way. Every mutation is
    // logged before it is applied, so the state is still consistent.
    let mut feed = match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match request.path.as_str() {
        "/v1/config" => Some(Response::json(
            200,
            format!(
                r#"{{"max_staleness_ms":{max_staleness_ms},"tick_ms":{TICK_MS},"policy":"reject_stale","invariants":["INV-050","INV-051","INV-052","INV-053","INV-054"]}}"#
            ),
        )),

        // ------------------------------------------------------ the feed
        "/v1/feed/ticks" if request.method == "POST" => {
            let body = match request.json() {
                Ok(body) => body,
                Err(err) => return Some(bad_request(&format!("body is not valid JSON: {err}"))),
            };
            let Some(source) = body.str_field("source") else {
                return Some(bad_request("\"source\" is required"));
            };
            let Some(Value::Array(ticks)) = body.get("ticks") else {
                return Some(bad_request("\"ticks\" must be an array"));
            };
            let now = now_tick();
            match feed.ingest(source, ticks, now) {
                Ok(report) => Some(Response::json(
                    if report.refused > 0 && report.accepted == 0 && report.out_of_order == 0 {
                        422
                    } else {
                        200
                    },
                    format!(
                        r#"{{"accepted":{},"outOfOrder":{},"duplicates":{},"refused":{},"firstRefusal":{},"tick":{now}}}"#,
                        report.accepted,
                        report.out_of_order,
                        report.duplicates,
                        report.refused,
                        report
                            .first_refusal
                            .map_or_else(|| "null".to_owned(), |r| format!("\"{}\"", escape(&r))),
                    ),
                )),
                Err(IngestError::Bad(detail)) => Some(bad_request(&detail)),
                Err(IngestError::NotDurable(detail)) => Some(error(503, "not_durable", &detail)),
            }
        }

        "/v1/feed/health" if request.method == "POST" => {
            // The gateway's view of its providers, kept for the console.
            let body = match request.json() {
                Ok(body) => body,
                Err(err) => return Some(bad_request(&format!("body is not valid JSON: {err}"))),
            };
            let Some(Value::Object(adapters)) = body.get("adapters") else {
                return Some(bad_request("\"adapters\" must be an object"));
            };
            let reported_ms = market_core::epoch_ms_of(now_tick());
            for (name, report) in adapters {
                if !KNOWN_SOURCES.contains(&name.as_str()) {
                    continue;
                }
                feed.report_adapter(
                    name,
                    AdapterHealth {
                        state: report.str_field("state").unwrap_or("unknown").to_owned(),
                        last_tick_ms: report.get("lastTickMs").and_then(Value::as_u64),
                        ticks_per_second: report
                            .str_field("ticksPerSecond")
                            .unwrap_or("0")
                            .to_owned(),
                        errors: report.get("errors").and_then(Value::as_u64).unwrap_or(0),
                        detail: report.str_field("detail").unwrap_or("").to_owned(),
                        reported_ms,
                    },
                );
            }
            Some(Response::json(200, r#"{"recorded":true}"#))
        }

        "/v1/feed/config" => Some(Response::json(
            200,
            format!(
                r#"{{"classes":{},"sources":[{}]}}"#,
                config_json(feed.config()),
                KNOWN_SOURCES
                    .iter()
                    .map(|s| format!("\"{s}\""))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        )),

        "/v1/feed/source" if request.method == "POST" => {
            let body = match request.json() {
                Ok(body) => body,
                Err(err) => return Some(bad_request(&format!("body is not valid JSON: {err}"))),
            };
            let Some(class) = body.str_field("class") else {
                return Some(bad_request("\"class\" is required"));
            };
            let Some(Value::Array(items)) = body.get("sources") else {
                return Some(bad_request("\"sources\" must be an array of source names"));
            };
            let sources: Vec<String> = items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            match feed.set_sources(class, sources) {
                Ok(()) => Some(Response::json(
                    200,
                    format!(r#"{{"classes":{}}}"#, config_json(feed.config())),
                )),
                Err(detail) => Some(bad_request(&detail)),
            }
        }

        "/v1/feed/status" => {
            let now = now_tick();
            let instruments = INSTRUMENTS
                .iter()
                .map(|instrument| feed.status_of(instrument, now))
                .collect::<Vec<_>>()
                .join(",");
            let adapters = feed
                .adapters()
                .iter()
                .map(|(name, health)| {
                    format!(
                        r#""{}":{{"state":"{}","lastTickMs":{},"ticksPerSecond":"{}","errors":{},"detail":"{}","reportedMs":{}}}"#,
                        escape(name),
                        escape(&health.state),
                        health
                            .last_tick_ms
                            .map_or_else(|| "null".to_owned(), |v| v.to_string()),
                        escape(&health.ticks_per_second),
                        health.errors,
                        escape(&health.detail),
                        health.reported_ms
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            Some(Response::json(
                200,
                format!(
                    r#"{{"tick":{now},"nowMs":{},"stateHash":"{:016x}","recorded":{},"outOfOrder":{},"refused":{},"classes":{},"instruments":[{instruments}],"adapters":{{{adapters}}}}}"#,
                    market_core::epoch_ms_of(now),
                    feed.store().state_hash(),
                    feed.store().len(),
                    feed.store().out_of_order(),
                    feed.refused(),
                    config_json(feed.config()),
                ),
            ))
        }

        "/v1/instruments" => {
            let now = now_tick();
            let body = INSTRUMENTS
                .iter()
                .map(|instrument| {
                    // The static description plus where its session stands now.
                    let base = instrument_json(instrument);
                    format!(
                        r#"{},"session":{}}}"#,
                        base.trim_end_matches('}'),
                        market_core::session::state_json(instrument.session, now)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            let intervals = INTERVALS
                .iter()
                .map(|i| format!(r#"{{"label":"{}","ticks":{}}}"#, escape(i.label), i.ticks))
                .collect::<Vec<_>>()
                .join(",");
            Some(Response::json(
                200,
                format!(r#"{{"instruments":[{body}],"intervals":[{intervals}]}}"#),
            ))
        }

        "/v1/sessions" => {
            // Every instrument's session at `tick` (default now), for an
            // interface that wants to say "gold opens in 31 hours" without
            // asking for a quote.
            let now = now_tick();
            let tick = request
                .param("tick")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(now);
            let rows = INSTRUMENTS
                .iter()
                .map(|instrument| {
                    format!(
                        r#"{{"symbol":"{}","session":{}}}"#,
                        escape(instrument.symbol),
                        market_core::session::state_json(instrument.session, tick)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            Some(Response::json(
                200,
                format!(r#"{{"tick":{tick},"sessions":[{rows}]}}"#),
            ))
        }

        "/v1/quotes" => {
            let now = now_tick();
            // A caller may pin the tick: the ledger values every position at
            // the tick it is deciding on (INV-052).
            let tick = request
                .param("tick")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(now);
            let quotes: Vec<String> = INSTRUMENTS
                .iter()
                .filter_map(|instrument| {
                    feed.quote(instrument, tick)
                        .ok()
                        .map(|quote| quote_json(instrument, &quote, now))
                })
                .collect();
            Some(Response::json(
                200,
                format!(r#"{{"tick":{tick},"quotes":[{}]}}"#, quotes.join(",")),
            ))
        }

        "/v1/quote" => {
            let symbol = request.param("symbol").unwrap_or_default();
            let Some(instrument) = find(symbol) else {
                return Some(error(404, "unknown_instrument", symbol));
            };
            // A caller may pin the tick — that is what makes a fill
            // reproducible from the journal (INV-052).
            let now = now_tick();
            let tick = request
                .param("tick")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(now);
            match feed.quote(instrument, tick) {
                Ok(quote) => Some(Response::json(200, quote_json(instrument, &quote, now))),
                Err(market_core::MarketError::Stale { .. }) => Some(error(
                    503,
                    "feed_unavailable",
                    "the recorded feed holds no usable quote for this tick and the class may not fall back",
                )),
                Err(err) => Some(error(500, "quote_unavailable", &err.to_string())),
            }
        }

        "/v1/candles" => {
            let symbol = request.param("symbol").unwrap_or_default();
            let Some(instrument) = find(symbol) else {
                return Some(error(404, "unknown_instrument", symbol));
            };
            let label = request.param("interval").unwrap_or("1m");
            let Some(chosen) = interval(label) else {
                return Some(error(404, "unknown_interval", label));
            };
            let count = request
                .param("limit")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(200)
                .clamp(1, MAX_CANDLES);
            let now = now_tick();
            let tick = request
                .param("tick")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(now);

            match feed.candles(instrument, chosen, tick, count) {
                Ok(built) => {
                    let rows: Vec<String> = built
                        .iter()
                        .map(|candle| {
                            format!(
                                r#"{{"openTick":{},"openMs":{},"open":"{}","high":"{}","low":"{}","close":"{}"}}"#,
                                candle.open_tick,
                                candle.open_ms,
                                instrument.format_price(candle.open),
                                instrument.format_price(candle.high),
                                instrument.format_price(candle.low),
                                instrument.format_price(candle.close),
                            )
                        })
                        .collect();
                    Some(Response::json(
                        200,
                        format!(
                            r#"{{"symbol":"{}","digits":{},"interval":"{}","intervalTicks":{},"tick":{},"source":"{}","candles":[{}]}}"#,
                            escape(instrument.symbol),
                            instrument.digits,
                            escape(chosen.label),
                            chosen.ticks,
                            tick,
                            escape(&match feed.mode_at(instrument.symbol, tick) {
                                state::Mode::Synthetic => "synthetic".to_owned(),
                                state::Mode::Recorded(source) => source,
                            }),
                            rows.join(",")
                        ),
                    ))
                }
                Err(err) => Some(error(400, "bad_window", &err.to_string())),
            }
        }

        _ => None,
    }
}

fn main() -> std::io::Result<()> {
    let info = ServiceInfo::from_env("market-data", "06-market-data", "T1");
    let mut service = Service::new(info.clone());

    // A quote that fails validation must never reach the canonical book
    // (INV-050), and consumers must be able to reject stale state (INV-051).
    let max_staleness_ms: u64 = std::env::var("MAX_QUOTE_STALENESS_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(500);

    let path =
        std::env::var("FEED_LOG_PATH").unwrap_or_else(|_| "/var/lib/projectx/feed.log".to_owned());
    let feed = match FeedState::open(std::path::Path::new(&path), now_tick()) {
        Ok(feed) => feed,
        Err(detail) => {
            // A feed that cannot prove what it recorded must not serve
            // recorded prices as if it could.
            log(
                &info,
                "error",
                &format!("cannot open feed log at {path}: {detail}"),
            );
            return Err(std::io::Error::other(detail));
        }
    };
    log(
        &info,
        "info",
        &format!(
            "feed log replayed from {path}: {} recorded quotes, state hash {:016x}",
            feed.store().len(),
            feed.store().state_hash()
        ),
    );
    let feed = Arc::new(Mutex::new(feed));

    // The watchdog: a recorded feed that goes silent on an open market falls
    // back to the pure function where the class allows it (see state.rs).
    let watched = Arc::clone(&feed);
    let watch_info = info.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let mut guard = match watched.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        match guard.watchdog(now_tick()) {
            Ok(fell_back) => {
                for symbol in fell_back {
                    log(
                        &watch_info,
                        "warn",
                        &format!("{symbol}: recorded feed silent, falling back to synthetic"),
                    );
                }
            }
            Err(detail) => log(
                &watch_info,
                "error",
                &format!("watchdog could not log a fallback: {detail}"),
            ),
        }
    });

    let routed = Arc::clone(&feed);
    service.route_request(Box::new(move |request| {
        handle(&routed, request, max_staleness_ms)
    }));

    log(
        &info,
        "info",
        &format!(
            "market-data starting — {} instruments, {TICK_MS}ms ticks, rejecting state older than {max_staleness_ms}ms",
            INSTRUMENTS.len()
        ),
    );
    service.serve(port_from_env())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    fn fresh() -> Mutex<FeedState> {
        Mutex::new(FeedState::in_memory())
    }

    fn body(target: &str) -> String {
        handle(&fresh(), &Request::get(target), 500).unwrap().body
    }

    fn post(state: &Mutex<FeedState>, target: &str, body: &str) -> Response {
        handle(state, &Request::post(target, body), 500).unwrap()
    }

    #[test]
    fn the_instrument_list_is_served_with_its_intervals() {
        let json = body("/v1/instruments");
        assert!(json.contains(r#""symbol":"EURUSD""#));
        assert!(json.contains(r#""symbol":"BTCUSD""#));
        assert!(json.contains(r#""label":"1m""#));
        assert!(json.contains(r#""contractSize":100000"#));
    }

    /// INV-052 — pinning the tick makes the quote reproducible, which is what
    /// lets a fill be re-derived from the journal.
    #[test]
    fn inv_052_a_pinned_tick_returns_the_same_quote_every_time() {
        let first = body("/v1/quote?symbol=EURUSD&tick=1000000");
        let second = body("/v1/quote?symbol=EURUSD&tick=1000000");
        assert_eq!(first, second);
        assert!(first.contains(r#""tick":1000000"#));
    }

    /// P1 — prices cross the wire as decimal strings, never as JSON numbers.
    #[test]
    fn prices_are_quoted_as_strings_at_the_instruments_precision() {
        let json = body("/v1/quote?symbol=EURUSD&tick=1000000");
        // Five decimal places for a major pair, and quoted.
        let bid = json
            .split(r#""bid":""#)
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        assert_eq!(bid.split('.').nth(1).unwrap().len(), 5);
        assert!(!json.contains(r#""bid":1"#), "a price must not be a number");
    }

    #[test]
    fn an_unknown_instrument_is_a_404_not_an_empty_quote() {
        let response = handle(&fresh(), &Request::get("/v1/quote?symbol=NOTREAL"), 500).unwrap();
        assert_eq!(response.status, 404);
        assert!(response.body.contains("unknown_instrument"));

        let missing = handle(&fresh(), &Request::get("/v1/quote"), 500).unwrap();
        assert_eq!(missing.status, 404);
    }

    #[test]
    fn candles_come_back_in_the_requested_shape() {
        let json = body("/v1/candles?symbol=EURUSD&interval=1m&limit=25");
        assert!(json.contains(r#""interval":"1m""#));
        assert_eq!(json.matches(r#""openTick""#).count(), 25);
    }

    /// An unbounded chart request is a way to spend a core, so the limit is
    /// clamped rather than honoured.
    #[test]
    fn an_absurd_candle_request_is_clamped_not_served() {
        let json = body("/v1/candles?symbol=EURUSD&interval=1m&limit=100000");
        assert_eq!(json.matches(r#""openTick""#).count(), MAX_CANDLES);

        let response = handle(
            &fresh(),
            &Request::get("/v1/candles?symbol=EURUSD&interval=1y"),
            500,
        )
        .unwrap();
        assert_eq!(response.status, 404);
        assert!(response.body.contains("unknown_interval"));
    }

    #[test]
    fn every_instrument_is_quotable_right_now() {
        let json = body("/v1/quotes");
        for instrument in INSTRUMENTS {
            assert!(
                json.contains(&format!(r#""symbol":"{}""#, instrument.symbol)),
                "{} is missing from the quote stream",
                instrument.symbol
            );
        }
    }

    #[test]
    fn the_config_endpoint_states_the_staleness_policy() {
        let json = body("/v1/config");
        assert!(json.contains(r#""max_staleness_ms":500"#));
        assert!(json.contains(r#""tick_ms":250"#));
        assert!(json.contains("INV-051"));
    }

    /// INV-053 — on a Saturday gold's quote is frozen at Friday's close and
    /// says so; bitcoin's is live.
    #[test]
    fn inv_053_a_closed_market_serves_a_frozen_quote_that_says_it_is_frozen() {
        // 2026-09-12 12:00 UTC, a Saturday.
        let saturday_noon = 1_789_214_400_000u64 / TICK_MS;
        let gold = body(&format!("/v1/quote?symbol=XAUUSD&tick={saturday_noon}"));
        assert!(gold.contains(r#""open":false"#), "{gold}");
        // Priced at the last tick before Friday 22:00 UTC.
        let friday_close_tick = 1_789_164_000_000u64 / TICK_MS - 1;
        assert!(
            gold.contains(&format!(r#""pricedTick":{friday_close_tick}"#)),
            "{gold}"
        );
        assert!(
            gold.contains(r#""nextTransitionMs":1789340400000"#),
            "{gold}"
        );
        // The price is the same one an hour later: nothing new was produced.
        let later = body(&format!(
            "/v1/quote?symbol=XAUUSD&tick={}",
            saturday_noon + 14_400
        ));
        let price = |json: &str| {
            json.split(r#""bid":""#)
                .nth(1)
                .unwrap()
                .split('"')
                .next()
                .unwrap()
                .to_owned()
        };
        assert_eq!(price(&gold), price(&later));

        let btc = body(&format!("/v1/quote?symbol=BTCUSD&tick={saturday_noon}"));
        assert!(btc.contains(r#""open":true"#));
        assert!(btc.contains(r#""nextTransitionMs":null"#));

        let sessions = body(&format!("/v1/sessions?tick={saturday_noon}"));
        assert_eq!(
            sessions.matches(r#""open":false"#).count(),
            INSTRUMENTS.len() - 1
        );
        let instruments = body("/v1/instruments");
        assert!(instruments.contains(r#""sessionKind":"metals""#));
    }

    #[test]
    fn an_unknown_path_is_left_for_the_default_handler() {
        assert!(handle(&fresh(), &Request::get("/nope"), 500).is_none());
    }

    /// INV-050 / INV-054 at the HTTP surface: a batch is validated, the
    /// accepted quotes are served, the status reports the switch, and the
    /// console can reconfigure the class.
    #[test]
    fn inv_050_the_ingest_endpoint_validates_and_the_status_reports_it() {
        let state = fresh();
        let now_ms = market_core::epoch_ms_of(now_tick());
        let response = post(
            &state,
            "/v1/feed/ticks",
            &format!(
                r#"{{"source":"binance","ticks":[{{"symbol":"BTCUSD","ms":{now_ms},"seq":1,"bid":"68200.10","ask":"68201.30"}},{{"symbol":"BTCUSD","ms":{now_ms},"seq":2,"bid":"9","ask":"1"}}]}}"#
            ),
        );
        assert_eq!(response.status, 200, "{}", response.body);
        assert!(response.body.contains(r#""accepted":1"#));
        assert!(response.body.contains(r#""refused":1"#));

        let quote = handle(&state, &Request::get("/v1/quote?symbol=BTCUSD"), 500).unwrap();
        assert!(quote.body.contains(r#""bid":"68200.10""#), "{}", quote.body);

        let status = handle(&state, &Request::get("/v1/feed/status"), 500).unwrap();
        assert!(
            status.body.contains(
                r#""symbol":"BTCUSD","class":"Crypto","mode":"recorded","source":"binance""#
            ),
            "{}",
            status.body
        );
        assert!(status.body.contains(r#""recorded":1"#));

        let all_bad = post(
            &state,
            "/v1/feed/ticks",
            &format!(
                r#"{{"source":"binance","ticks":[{{"symbol":"BTCUSD","ms":{now_ms},"seq":3,"bid":"9","ask":"1"}}]}}"#
            ),
        );
        assert_eq!(all_bad.status, 422);
        assert_eq!(
            post(&state, "/v1/feed/ticks", r#"{"source":"nasa","ticks":[]}"#).status,
            400
        );
        assert_eq!(post(&state, "/v1/feed/ticks", "nonsense").status, 400);

        let reconfigured = post(
            &state,
            "/v1/feed/source",
            r#"{"class":"Crypto","sources":["synthetic"]}"#,
        );
        assert_eq!(reconfigured.status, 200, "{}", reconfigured.body);
        assert!(reconfigured.body.contains(r#""Crypto":["synthetic"]"#));
        assert_eq!(
            post(
                &state,
                "/v1/feed/source",
                r#"{"class":"Crypto","sources":["nasa"]}"#
            )
            .status,
            400
        );
        let config = handle(&state, &Request::get("/v1/feed/config"), 500).unwrap();
        assert!(config.body.contains(r#""sources":["synthetic","binance""#));

        let health = post(
            &state,
            "/v1/feed/health",
            r#"{"adapters":{"binance":{"state":"connected","lastTickMs":1,"ticksPerSecond":"3.2","errors":0,"detail":"ok"},"nasa":{"state":"x"}}}"#,
        );
        assert_eq!(health.status, 200);
        let status = handle(&state, &Request::get("/v1/feed/status"), 500).unwrap();
        assert!(status.body.contains(r#""binance":{"state":"connected""#));
        assert!(!status.body.contains("nasa"));
    }
}

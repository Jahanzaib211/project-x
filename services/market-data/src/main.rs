//! # 06-market-data
//!
//! Raw provider feeds turned into one canonical, validated, timestamped market
//! state. Everything price-dependent downstream reads this and nothing else.
//!
//! ## Where the non-determinism lives
//!
//! Exactly here, in one function: [`now_tick`] reads the clock. Everything else
//! — the price at a tick, the candles over a window, the spread — is a pure
//! function in `market-core`, so this service is a thin shell around a library
//! that can be tested without a clock, a socket or a sleep.
//!
//! That boundary is the reason a fill can be re-derived from the journal months
//! later: the journal records the tick, and the tick is all you need.

use std::time::{SystemTime, UNIX_EPOCH};

use market_core::candle::{candles, interval, INTERVALS, MAX_CANDLES};
use market_core::instrument::{find, INSTRUMENTS};
use market_core::{quote_at, tick_of, Instrument, Quote, TICK_MS};
use service_kit::json::escape;
use service_kit::{log, port_from_env, Request, Response, Service, ServiceInfo};

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

fn handle(request: &Request, max_staleness_ms: u64) -> Option<Response> {
    match request.path.as_str() {
        "/v1/config" => Some(Response::json(
            200,
            format!(
                r#"{{"max_staleness_ms":{max_staleness_ms},"tick_ms":{TICK_MS},"policy":"reject_stale","invariants":["INV-050","INV-051","INV-052"]}}"#
            ),
        )),

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
            let quotes: Vec<String> = INSTRUMENTS
                .iter()
                .filter_map(|instrument| {
                    quote_at(instrument, now)
                        .ok()
                        .map(|quote| quote_json(instrument, &quote, now))
                })
                .collect();
            Some(Response::json(
                200,
                format!(r#"{{"tick":{now},"quotes":[{}]}}"#, quotes.join(",")),
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
            match quote_at(instrument, tick) {
                Ok(quote) => Some(Response::json(200, quote_json(instrument, &quote, now))),
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

            match candles(instrument, chosen, now, count) {
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
                            r#"{{"symbol":"{}","digits":{},"interval":"{}","intervalTicks":{},"tick":{},"candles":[{}]}}"#,
                            escape(instrument.symbol),
                            instrument.digits,
                            escape(chosen.label),
                            chosen.ticks,
                            now,
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

    service.route_request(Box::new(move |request| handle(request, max_staleness_ms)));

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

    fn body(target: &str) -> String {
        handle(&Request::get(target), 500).unwrap().body
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
        let response = handle(&Request::get("/v1/quote?symbol=NOTREAL"), 500).unwrap();
        assert_eq!(response.status, 404);
        assert!(response.body.contains("unknown_instrument"));

        let missing = handle(&Request::get("/v1/quote"), 500).unwrap();
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

        let response = handle(&Request::get("/v1/candles?symbol=EURUSD&interval=1y"), 500).unwrap();
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
        assert!(handle(&Request::get("/nope"), 500).is_none());
    }
}

//! # 07-pricing
//!
//! `(MarketState, config) -> ClientQuote`, as a pure function.
//!
//! No clock reads, no ambient state, no hidden I/O — that is what makes
//! INV-060 (identical input, identical output) provable, and what lets G11
//! shadow-diff a new version against the incumbent on identical input.
//!
//! ## What pricing adds to market data
//!
//! The venue's quote is what the market is. The **client** quote is what this
//! broker is willing to deal at: the venue mid, plus a markup, on the
//! instrument's own price grid. Keeping the two apart matters — a client
//! disputing a fill is asking about the client quote, and a dealer asking why
//! the book moved is asking about the venue quote. One number cannot answer
//! both questions.

use market_core::instrument::{find, INSTRUMENTS};
use market_core::{quote_at, tick_of, Instrument, MarketError, TICK_MS};
use service_kit::json::escape;
use service_kit::{log, port_from_env, Request, Response, Service, ServiceInfo};

/// The pricing configuration in force.
///
/// Versioned because every quote is only meaningful alongside the config that
/// produced it (INV-063). A markup changed without a version change is a quote
/// nobody can reproduce.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
struct PricingConfig {
    version: &'static str,
    /// Client markup applied around the venue mid, in basis points.
    markup_bps: i128,
    /// The oldest market state a quote may be derived from (INV-062).
    max_age_ms: u64,
}

const CONFIG: PricingConfig = PricingConfig {
    version: "pricing-v1",
    markup_bps: 20,
    max_age_ms: 500,
};

/// The client quote for `instrument` at `tick`, as raw price units.
///
/// Works on the raw price scale rather than on `Money`, because a price carries
/// more decimal places than a currency does and rounding it to cents first
/// would move the quote.
fn client_quote(
    instrument: &Instrument,
    tick: u64,
    config: &PricingConfig,
) -> Result<(i128, i128, i128), MarketError> {
    let venue = quote_at(instrument, tick)?;
    let mid = venue.mid().raw();
    // Half the markup either side, rounded up so the spread never narrows by
    // accident, then snapped to the instrument's quoted grid.
    let half = mid
        .saturating_mul(config.markup_bps)
        .saturating_add(19_999)
        .checked_div(20_000)
        .unwrap_or(0);
    let bid = instrument.on_grid(mid.saturating_sub(half));
    let ask = instrument.on_grid(mid.saturating_add(half));
    Ok((bid, mid, ask))
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

fn handle(request: &Request, now: u64) -> Option<Response> {
    match request.path.as_str() {
        "/v1/config" => Some(Response::json(
            200,
            format!(
                r#"{{"version":"{}","markupBps":{},"maxAgeMs":{},"tickMs":{TICK_MS},"invariants":["INV-060","INV-061","INV-062","INV-063"]}}"#,
                escape(CONFIG.version),
                CONFIG.markup_bps,
                CONFIG.max_age_ms
            ),
        )),

        "/v1/quote" => {
            // Default to EURUSD so the endpoint is usable bare, as it was
            // before instruments existed.
            let symbol = request.param("symbol").unwrap_or("EURUSD");
            let Some(instrument) = find(symbol) else {
                return Some(error(404, "unknown_instrument", symbol));
            };
            let tick = request
                .param("tick")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(now);

            // INV-062 — a quote derived from stale state is never emitted as
            // live. The caller is told the age rather than handed a price.
            let age_ms = now.saturating_sub(tick).saturating_mul(TICK_MS);
            if age_ms > CONFIG.max_age_ms {
                return Some(error(
                    409,
                    "stale_market_state",
                    &format!(
                        "market state is {age_ms}ms old, limit is {}ms",
                        CONFIG.max_age_ms
                    ),
                ));
            }

            match client_quote(instrument, tick, &CONFIG) {
                Ok((bid, mid, ask)) => {
                    // INV-061, asserted before emission rather than assumed.
                    if bid > ask {
                        return Some(error(500, "crossed_quote", "bid exceeded ask"));
                    }
                    Some(Response::json(
                        200,
                        format!(
                            r#"{{"symbol":"{}","digits":{},"bid":"{}","ask":"{}","mid":"{}","currency":"USD","tick":{tick},"ageMs":{age_ms},"session":{},"configVersion":"{}","pure":true,"invariants":["INV-053","INV-060","INV-061","INV-063"]}}"#,
                            escape(instrument.symbol),
                            instrument.digits,
                            escape(&instrument.format_price(bid)),
                            escape(&instrument.format_price(ask)),
                            escape(&instrument.format_price(mid)),
                            // INV-053 — a client is told the price is frozen
                            // rather than shown a still number with no reason.
                            market_core::session::state_json(instrument.session, tick),
                            escape(CONFIG.version),
                        ),
                    ))
                }
                Err(err) => Some(error(500, "arithmetic", &err.to_string())),
            }
        }

        _ => None,
    }
}

fn main() -> std::io::Result<()> {
    let info = ServiceInfo::from_env("pricing", "07-pricing", "T1");
    let mut service = Service::new(info.clone());

    service.route_request(Box::new(|request| {
        // ALLOW-BANNED: the tick a bare quote defaults to. Pricing itself is
        // pure — every function above takes the tick as an argument — and this
        // is the one place the current one is read.
        let millis = std::time::SystemTime::now() // ALLOW-BANNED
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis());
        handle(request, tick_of(u64::try_from(millis).unwrap_or(0)))
    }));

    log(
        &info,
        "info",
        &format!(
            "pricing starting — pure function, no clock reads, {} instruments at {}bps",
            INSTRUMENTS.len(),
            CONFIG.markup_bps
        ),
    );
    service.serve(port_from_env())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    fn quote(target: &str, now: u64) -> Response {
        handle(&Request::get(target), now).unwrap()
    }

    /// INV-060 — identical input yields byte-identical output.
    #[test]
    fn inv_060_pricing_is_deterministic() {
        let first = quote("/v1/quote?symbol=EURUSD&tick=4000000", 4_000_000);
        let second = quote("/v1/quote?symbol=EURUSD&tick=4000000", 4_000_000);
        assert_eq!(
            first.body, second.body,
            "the same request answered differently"
        );

        // And at the level below the endpoint, across the whole instrument set.
        for instrument in INSTRUMENTS {
            for tick in [0u64, 1, 4_000_000, 900_000_000] {
                assert_eq!(
                    client_quote(instrument, tick, &CONFIG),
                    client_quote(instrument, tick, &CONFIG)
                );
            }
        }
    }

    /// INV-061 — bid <= ask on every emitted quote.
    #[test]
    fn inv_061_bid_never_exceeds_ask() {
        // Including at a zero markup, where bid and ask meet but must not cross.
        for markup_bps in [0i128, 1, 20, 500, 10_000] {
            let config = PricingConfig {
                markup_bps,
                ..CONFIG
            };
            for instrument in INSTRUMENTS {
                for tick in (0..20_000u64).step_by(499) {
                    let (bid, mid, ask) = client_quote(instrument, tick, &config).unwrap();
                    assert!(
                        bid <= mid && mid <= ask,
                        "{} crossed at {markup_bps}bps, tick {tick}",
                        instrument.symbol
                    );
                }
            }
        }
        for instrument in INSTRUMENTS {
            for tick in (0..200_000u64).step_by(997) {
                let (bid, _, ask) = client_quote(instrument, tick, &CONFIG).unwrap();
                assert!(bid <= ask, "{} crossed at tick {tick}", instrument.symbol);
            }
        }
    }

    /// INV-062 — a quote from stale state is refused, not emitted as live.
    #[test]
    fn inv_062_a_stale_quote_is_refused_rather_than_served() {
        // Two ticks back is 500ms, exactly the limit: still live.
        assert_eq!(
            quote("/v1/quote?symbol=EURUSD&tick=3999998", 4_000_000).status,
            200
        );
        // Three ticks back is 750ms: refused.
        let stale = quote("/v1/quote?symbol=EURUSD&tick=3999997", 4_000_000);
        assert_eq!(stale.status, 409);
        assert!(stale.body.contains("stale_market_state"));
    }

    /// INV-063 — every quote names the config that produced it.
    #[test]
    fn inv_063_a_quote_is_attributable_to_its_config_and_market_state() {
        let body = quote("/v1/quote?symbol=EURUSD&tick=4000000", 4_000_000).body;
        assert!(body.contains(r#""configVersion":"pricing-v1""#));
        assert!(body.contains(r#""tick":4000000"#));
    }

    /// The client quote is wider than the venue's: the markup is applied
    /// outward on both sides, never inward.
    #[test]
    fn the_client_quote_is_never_tighter_than_the_venue_quote() {
        for instrument in INSTRUMENTS {
            for tick in (0..50_000u64).step_by(311) {
                let venue = quote_at(instrument, tick).unwrap();
                let (bid, _, ask) = client_quote(instrument, tick, &CONFIG).unwrap();
                assert!(
                    bid <= venue.bid().raw() && ask >= venue.ask().raw(),
                    "{} client quote is inside the venue quote at tick {tick}",
                    instrument.symbol
                );
            }
        }
    }

    #[test]
    fn a_quote_lands_on_the_instruments_quoted_grid() {
        for instrument in INSTRUMENTS {
            let (bid, _, ask) = client_quote(instrument, 12_345, &CONFIG).unwrap();
            assert_eq!(bid.checked_rem(instrument.point()), Some(0));
            assert_eq!(ask.checked_rem(instrument.point()), Some(0));
        }
    }

    #[test]
    fn an_unknown_instrument_is_a_404() {
        assert_eq!(quote("/v1/quote?symbol=NOTREAL", 1).status, 404);
    }

    #[test]
    fn the_bare_endpoint_still_answers() {
        let response = quote("/v1/quote", 4_000_000);
        assert_eq!(response.status, 200);
        assert!(response.body.contains(r#""symbol":"EURUSD""#));
    }

    #[test]
    fn the_config_is_published() {
        let body = quote("/v1/config", 1).body;
        assert!(body.contains(r#""version":"pricing-v1""#));
        assert!(body.contains(r#""markupBps":20"#));
    }
}

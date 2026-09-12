//! Pricing as a library (`07-pricing`).
//!
//! `(venue quote, config) -> client quote`, pure. The service in `main.rs`
//! fetches the venue quote from `06-market-data` and serves the result; the
//! property suite in `tests/invariants` drives this function directly over
//! generated venue quotes, which is the only way INV-060/061/063 are proven
//! for inputs nobody wrote down.

#![forbid(unsafe_code)]

use market_core::{Instrument, MarketError, Quote};

/// The pricing configuration in force.
///
/// Versioned because every quote is only meaningful alongside the config that
/// produced it (INV-063). A markup changed without a version change is a quote
/// nobody can reproduce.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct PricingConfig {
    /// The version stamped on every quote.
    pub version: &'static str,
    /// Client markup applied around the venue mid, in basis points.
    pub markup_bps: i128,
    /// The oldest market state a quote may be derived from (INV-062).
    pub max_age_ms: u64,
}

/// The configuration this build ships with.
pub const CONFIG: PricingConfig = PricingConfig {
    version: "pricing-v1",
    markup_bps: 20,
    // The default; the service reads MAX_QUOTE_STALENESS_MS at startup. Two
    // seconds matches what risk will accept (`risk_core::MAX_MARKET_AGE_MS`):
    // a real feed delivers on its own cadence, and a quote a second old is
    // the market, not a fault. Stale is still refused, just at the same
    // line the rest of the system draws.
    max_age_ms: 2_000,
};

/// The client quote derived from a venue quote, as raw price units.
///
/// Works on the raw price scale rather than on `Money`, because a price carries
/// more decimal places than a currency does and rounding it to cents first
/// would move the quote.
///
/// The markup is applied around the mid **and never inside the venue's own
/// sides** (INV-063): on a wide market — news, a thin hour — the venue's
/// spread can exceed the markup, and a client quote inside it would be a
/// price the broker cannot hedge at. The bid is floored to the grid and the
/// ask ceiled, so snapping never moves a side inward either.
///
/// # Errors
/// Never, today: the arithmetic saturates. The signature keeps the door
/// open for a policy that can refuse.
pub fn client_quote(
    venue: &Quote,
    instrument: &Instrument,
    config: &PricingConfig,
) -> Result<(i128, i128, i128), MarketError> {
    let mid = venue.mid().raw();
    // Half the markup either side, rounded up so the spread never narrows by
    // accident.
    let half = mid
        .saturating_mul(config.markup_bps)
        .saturating_add(19_999)
        .checked_div(20_000)
        .unwrap_or(0);
    let bid = floor_to_grid(mid.saturating_sub(half).min(venue.bid().raw()), instrument);
    let ask = ceil_to_grid(mid.saturating_add(half).max(venue.ask().raw()), instrument);
    Ok((bid, mid, ask))
}

/// The largest grid price at or below `raw`.
fn floor_to_grid(raw: i128, instrument: &Instrument) -> i128 {
    let point = instrument.point().max(1);
    raw.div_euclid(point).saturating_mul(point)
}

/// The smallest grid price at or above `raw`.
fn ceil_to_grid(raw: i128, instrument: &Instrument) -> i128 {
    let point = instrument.point().max(1);
    let floored = raw.div_euclid(point).saturating_mul(point);
    if floored == raw {
        raw
    } else {
        floored.saturating_add(point)
    }
}

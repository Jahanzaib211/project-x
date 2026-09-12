//! G3/G4 — pricing (`07-pricing`) over generated venue quotes and markups.
//!
//! INV-060: identical input, identical output. INV-061: bid <= ask on every
//! emitted quote, at every markup including zero. INV-063: the client quote
//! is never inside the venue quote (the markup is outward) and lands on the
//! instrument's own grid, so it is attributable to its inputs exactly.

#![allow(
    clippy::unwrap_used,
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing
)]

use domain_kernel::Price;
use invariants::{for_all, Gen};
use market_core::instrument::INSTRUMENTS;
use market_core::{quote_at, Quote};
use pricing::{client_quote, PricingConfig, CONFIG};

/// A venue quote: the synthetic one at a random tick, or an arbitrary
/// valid one around the reference — wide, tight, or zero spread.
fn venue(g: &mut Gen, index: usize) -> Quote {
    let instrument = &INSTRUMENTS[index];
    if g.in_range(0, 2) == 0 {
        return quote_at(instrument, g.in_range(0, 4_000_000_000) as u64).unwrap();
    }
    let mid = instrument.reference_raw
        + g.in_range(
            -instrument.reference_raw / 20,
            instrument.reference_raw / 20,
        );
    let half = g.in_range(0, instrument.reference_raw / 500);
    Quote::validated(
        instrument.symbol,
        1,
        Price::from_raw(mid - half),
        Price::from_raw(mid + half),
    )
    .unwrap()
}

#[test]
fn inv_060_061_063_client_quotes_are_deterministic_uncrossed_outward_and_on_grid() {
    for_all("pricing laws", 20_000, 0x0760, |g| {
        let index = g.in_range(0, INSTRUMENTS.len() as i128 - 1) as usize;
        let instrument = &INSTRUMENTS[index];
        let venue_quote = venue(g, index);
        let config = PricingConfig {
            markup_bps: g.in_range(0, 10_000),
            ..CONFIG
        };
        let (bid, mid, ask) = client_quote(&venue_quote, instrument, &config).unwrap();
        // INV-060
        if client_quote(&venue_quote, instrument, &config).unwrap() != (bid, mid, ask) {
            return Err("the same inputs priced differently".into());
        }
        // INV-061
        if bid > ask {
            return Err(format!(
                "{} crossed at {}bps: {bid} > {ask}",
                instrument.symbol, config.markup_bps
            ));
        }
        if !(bid <= mid && mid <= ask) {
            return Err("the mid is outside the client quote".into());
        }
        // INV-063 — outward, never inside the venue.
        if bid > venue_quote.bid().raw() || ask < venue_quote.ask().raw() {
            return Err(format!(
                "client {bid}/{ask} is inside venue {}/{}",
                venue_quote.bid().raw(),
                venue_quote.ask().raw()
            ));
        }
        // On the grid, and the venue's own mid is the mid reported.
        let point = instrument.point();
        if bid % point != 0 || ask % point != 0 {
            return Err("a client price is off the instrument's grid".into());
        }
        if mid != venue_quote.mid().raw() {
            return Err("the reported mid is not the venue mid".into());
        }
        // A larger markup never tightens the quote.
        let wider = PricingConfig {
            markup_bps: config.markup_bps + g.in_range(1, 500),
            ..config
        };
        let (wb, _, wa) = client_quote(&venue_quote, instrument, &wider).unwrap();
        if wb > bid || wa < ask {
            return Err("a larger markup produced a tighter quote".into());
        }
        Ok(())
    });
}

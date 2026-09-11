//! The price series: a pure integer function of `(instrument, tick)`.
//!
//! ## Why not a random walk
//!
//! The obvious way to synthesise a feed is to hold a price in a field and nudge
//! it each tick. That is a *stateful* generator, and it has two properties this
//! system cannot accept: the price at tick *n* costs *n* steps to obtain, and
//! it depends on when the process started. Replaying a fill from the journal
//! would then be impossible, because the state that produced it is gone.
//!
//! So the series is **value noise** instead: several layers of hashed random
//! values at decreasing wavelengths, interpolated and summed. Every layer is
//! addressable — layer *k* at tick *t* depends only on `hash(seed_k, t / λ_k)`
//! — so the whole series is O(1) at any point, for all time, on any machine.
//! Long wavelengths give the trend, short ones give the chop.
//!
//! ## Why integers
//!
//! Everything here is `i128`. The usual formulation of value noise uses floats
//! and a smoothstep curve; floats are banned on this path (P1, INV-001), so
//! interpolation is done in fixed point at [`FRACTION`] and the smoothing curve
//! is the integer cubic `3u² − 2u³`, evaluated with the same scale. The result
//! is not merely "close enough" — it is exactly reproducible, which is the
//! property that matters.

use crate::instrument::Instrument;

/// Fixed-point denominator for interpolation weights. A power of two so the
/// divisions are exact and the algebra below stays whole.
const FRACTION: i128 = 1 << 20;

/// Amplitude scale for one noise layer: values land in `[-UNIT, UNIT]`.
const UNIT: i128 = 1 << 20;

/// One layer of the series: how long its wave is, in ticks, and how much of
/// the instrument's volatility budget it accounts for, in parts of 100.
///
/// The wavelengths are coprime-ish and span three orders of magnitude, so the
/// layers do not re-align into a visibly repeating pattern at chart scale.
const LAYERS: &[(u64, i128)] = &[
    (9_973, 46), // slow drift — the trend a chart shows over an hour
    (1_511, 27), // swings — the moves a position is opened into
    (233, 17),   // chop
    (37, 10),    // tick noise
];

/// A 64-bit mixing function (`splitmix64`'s finaliser).
///
/// Deliberately not a `HashMap` hasher or anything the standard library may
/// change: the values it produces are part of the observable behaviour of the
/// system, so they are pinned here where a change to them is a change to a
/// reviewed file.
const fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// A pseudo-random value in `[-UNIT, UNIT]`, addressed by seed and index.
const fn value_at(seed: u64, index: u64) -> i128 {
    let hashed = mix(seed ^ mix(index));
    // Take the low 21 bits to land in [0, 2*UNIT), then centre on zero.
    let magnitude = (hashed & 0x1F_FFFF) as i128;
    magnitude.wrapping_sub(UNIT)
}

/// The integer smoothstep `3u² − 2u³`, for `u` scaled by [`FRACTION`].
///
/// Without it the interpolation is linear and the series has a visible corner
/// at every lattice point — which looks synthetic on a candle chart, and, worse,
/// puts a discontinuity in the first derivative exactly where a lot of ticks
/// land.
fn smoothstep(u: i128) -> i128 {
    let u2 = u.saturating_mul(u).saturating_div(FRACTION);
    let u3 = u2.saturating_mul(u).saturating_div(FRACTION);
    u2.saturating_mul(3).saturating_sub(u3.saturating_mul(2))
}

/// One interpolated noise layer at `tick`.
fn layer(seed: u64, tick: u64, wavelength: u64) -> i128 {
    let index = tick.checked_div(wavelength).unwrap_or(0);
    let next = index.saturating_add(1);
    let offset = tick.checked_rem(wavelength).unwrap_or(0);

    // Position within the current wave, as a fraction scaled by FRACTION.
    let u = i128::from(offset)
        .saturating_mul(FRACTION)
        .checked_div(i128::from(wavelength))
        .unwrap_or(0);
    let weight = smoothstep(u);

    let a = value_at(seed, index);
    let b = value_at(seed, next);
    let span = b.saturating_sub(a);
    a.saturating_add(
        span.saturating_mul(weight)
            .checked_div(FRACTION)
            .unwrap_or(0),
    )
}

/// A stable seed for one instrument's layer, derived from its symbol.
///
/// Symbol-derived rather than positional, so adding an instrument to the table
/// does not re-roll every other instrument's history.
fn seed_for(symbol: &str, layer_index: u64) -> u64 {
    let symbol_seed = symbol
        .bytes()
        .fold(0xC0FF_EE00_u64, |acc, byte| mix(acc ^ u64::from(byte)));
    mix(symbol_seed ^ mix(layer_index))
}

/// The canonical mid price for `instrument` at `tick`, in raw `UNIT_SCALE`
/// units, on the instrument's quoted grid.
///
/// Pure and total: every tick from 0 to `u64::MAX` has an answer, and the
/// answer never changes.
#[must_use]
pub fn mid_raw(instrument: &Instrument, tick: u64) -> i128 {
    // The full swing available to all layers together, in raw price units.
    let budget = instrument
        .reference_raw
        .saturating_mul(instrument.volatility_bps)
        .checked_div(10_000)
        .unwrap_or(0);

    let displacement =
        LAYERS
            .iter()
            .enumerate()
            .fold(0i128, |total, (index, &(wavelength, share))| {
                let seed = seed_for(instrument.symbol, index as u64);
                let amplitude = budget.saturating_mul(share).checked_div(100).unwrap_or(0);
                let contribution = layer(seed, tick, wavelength)
                    .saturating_mul(amplitude)
                    .checked_div(UNIT)
                    .unwrap_or(0);
                total.saturating_add(contribution)
            });

    // A price can move a long way and must never reach zero: the floor is a
    // tenth of the reference, which no plausible sum of the layers can breach,
    // and is here so that a future change to the layer table cannot produce a
    // negative price without this line being reconsidered.
    let floor = instrument.reference_raw.checked_div(10).unwrap_or(1);
    let raw = instrument
        .reference_raw
        .saturating_add(displacement)
        .max(floor);
    instrument.on_grid(raw)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use crate::instrument::{find, INSTRUMENTS};

    /// INV-060 — identical input, identical output. The property the whole
    /// design exists to provide.
    #[test]
    fn inv_060_the_series_is_a_pure_function_of_the_tick() {
        let eurusd = find("EURUSD").unwrap();
        for tick in [0u64, 1, 999, 1_000_000, 41_209_011, u64::MAX] {
            assert_eq!(mid_raw(eurusd, tick), mid_raw(eurusd, tick));
        }
    }

    /// The point of value noise over a random walk: any tick costs the same to
    /// evaluate, and evaluating it does not require having evaluated the ones
    /// before it. This asserts the *observable* consequence — that a far-future
    /// tick is reachable at all, from a cold start.
    #[test]
    fn any_tick_is_reachable_without_computing_the_ones_before_it() {
        let eurusd = find("EURUSD").unwrap();
        let far = mid_raw(eurusd, 900_000_000_000);
        assert!(far > 0);
        assert_eq!(far, mid_raw(eurusd, 900_000_000_000));
    }

    #[test]
    fn prices_stay_positive_and_on_the_grid_across_a_long_run() {
        for instrument in INSTRUMENTS {
            for tick in (0..2_000_000u64).step_by(977) {
                let raw = mid_raw(instrument, tick);
                assert!(raw > 0, "{} went non-positive at {tick}", instrument.symbol);
                assert_eq!(
                    raw.checked_rem(instrument.point()),
                    Some(0),
                    "{} left the quoted grid at tick {tick}",
                    instrument.symbol
                );
            }
        }
    }

    #[test]
    fn prices_stay_within_the_declared_volatility_band() {
        for instrument in INSTRUMENTS {
            let budget = instrument
                .reference_raw
                .saturating_mul(instrument.volatility_bps)
                .checked_div(10_000)
                .unwrap();
            for tick in (0..1_000_000u64).step_by(311) {
                let deviation = mid_raw(instrument, tick)
                    .saturating_sub(instrument.reference_raw)
                    .abs();
                assert!(
                    deviation <= budget.saturating_add(instrument.point()),
                    "{} moved {deviation} at tick {tick}, budget {budget}",
                    instrument.symbol
                );
            }
        }
    }

    /// Two instruments must not share a series. They did, once, when the seed
    /// was derived from the layer index alone — every chart moved together and
    /// it looked exactly as wrong as it was.
    #[test]
    fn instruments_do_not_move_in_lockstep() {
        let eurusd = find("EURUSD").unwrap();
        let gbpusd = find("GBPUSD").unwrap();
        let identical = (0..500u64)
            .filter(|tick| {
                let a = mid_raw(eurusd, *tick).saturating_sub(eurusd.reference_raw);
                let b = mid_raw(gbpusd, *tick).saturating_sub(gbpusd.reference_raw);
                a == b
            })
            .count();
        assert!(
            identical < 5,
            "series are correlated: {identical}/500 equal"
        );
    }

    /// A chart of a series that does not move is not a chart. Over a window a
    /// user actually looks at, the price must visibly change.
    #[test]
    fn the_series_actually_moves_over_a_chart_window() {
        for instrument in INSTRUMENTS {
            // 2 400 ticks is ten minutes at 250ms.
            let prices: Vec<i128> = (0..2_400u64).map(|t| mid_raw(instrument, t)).collect();
            let low = prices.iter().min().copied().unwrap();
            let high = prices.iter().max().copied().unwrap();
            assert!(
                high.saturating_sub(low) > instrument.point().saturating_mul(4),
                "{} barely moved over ten minutes",
                instrument.symbol
            );
        }
    }

    /// Adjacent ticks must not jump: a fill happens at one tick and is marked
    /// at the next, and a discontinuity between them is a gap a client would
    /// experience as slippage that nobody applied.
    #[test]
    fn adjacent_ticks_are_continuous() {
        for instrument in INSTRUMENTS {
            let budget = instrument
                .reference_raw
                .saturating_mul(instrument.volatility_bps)
                .checked_div(10_000)
                .unwrap();
            // No single tick may move more than a hundredth of the full band,
            // plus the one point that snapping onto the quoted grid can add.
            let limit = budget
                .checked_div(100)
                .unwrap()
                .saturating_add(instrument.point());
            for tick in 0..20_000u64 {
                let step = mid_raw(instrument, tick.saturating_add(1))
                    .saturating_sub(mid_raw(instrument, tick))
                    .abs();
                assert!(
                    step <= limit,
                    "{} jumped {step} between ticks {tick} and {}, limit {limit}",
                    instrument.symbol,
                    tick.saturating_add(1)
                );
            }
        }
    }

    #[test]
    fn smoothstep_pins_both_ends_and_the_middle() {
        assert_eq!(smoothstep(0), 0);
        assert_eq!(smoothstep(FRACTION), FRACTION);
        assert_eq!(smoothstep(FRACTION / 2), FRACTION / 2);
    }
}

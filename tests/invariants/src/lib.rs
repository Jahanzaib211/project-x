//! Test support for G3 (property tests) and G4 (domain invariants).
//!
//! Deliberately dependency-free. A property-testing framework is a large
//! supply-chain surface to attach to the crate that proves your money is
//! correct, and the part we actually need — reproducible pseudo-random input
//! with a recorded seed — is about forty lines.
//!
//! ## Reproducibility
//!
//! Every failure prints its seed. Re-running with `PROPTEST_SEED=<seed>`
//! reproduces the exact case. A counterexample that cannot be reproduced cannot
//! be fixed with confidence, and a fix that cannot be verified is a guess.

#![forbid(unsafe_code)]

/// A deterministic pseudo-random generator (SplitMix64).
///
/// Chosen because it is small, has no state beyond a `u64`, and produces the
/// same sequence on every platform and in every build — which matters, because
/// a property test that generates different cases on CI than on a developer
/// machine is a test that fails in only one of those places.
pub struct Gen {
    state: u64,
    seed: u64,
}

impl Gen {
    /// Create a generator from an explicit seed.
    #[must_use]
    pub fn from_seed(seed: u64) -> Self {
        Self { state: seed, seed }
    }

    /// Create a generator, honouring `PROPTEST_SEED` when set so a reported
    /// failure can be replayed exactly.
    #[must_use]
    pub fn new(default_seed: u64) -> Self {
        let seed = std::env::var("PROPTEST_SEED")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default_seed);
        Self::from_seed(seed)
    }

    /// The seed this generator was created with. Print it on failure.
    #[must_use]
    pub fn seed(&self) -> u64 {
        self.seed
    }

    /// Next raw value.
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A value in `min..=max`.
    pub fn in_range(&mut self, min: i128, max: i128) -> i128 {
        if max <= min {
            return min;
        }
        let span = max.wrapping_sub(min).unsigned_abs().saturating_add(1);
        let draw = u128::from(self.next_u64());
        // `span` is non-zero by construction above; use checked_rem anyway —
        // the harness that proves the arithmetic is correct should not itself
        // contain unchecked arithmetic.
        min.wrapping_add(draw.checked_rem(span).unwrap_or(0) as i128)
    }

    /// A money amount biased toward the values that break things: zero, one
    /// minor unit, boundaries, and the occasional very large number.
    ///
    /// Uniform random input mostly generates unremarkable numbers. Bugs live at
    /// the edges, so the generator goes there on purpose.
    pub fn money_minor(&mut self) -> i128 {
        match self.next_u64() % 10 {
            0 => 0,
            1 => 1,
            2 => -1,
            3 => self.in_range(-100, 100),
            4 => i128::from(i64::MAX),
            5 => i128::from(i64::MIN),
            6 => self.in_range(-1_000_000, 1_000_000),
            _ => self.in_range(-1_000_000_000_000, 1_000_000_000_000),
        }
    }

    /// A small count, for splits and iteration counts.
    pub fn small_count(&mut self) -> u32 {
        (self.next_u64().checked_rem(12).unwrap_or(0) as u32).saturating_add(1)
    }
}

/// Run a property over `cases` generated inputs, reporting the seed on failure.
///
/// # Panics
/// Panics with the seed and case index when the property does not hold, so the
/// failure can be replayed with `PROPTEST_SEED`.
pub fn for_all<F>(name: &str, cases: u32, default_seed: u64, mut property: F)
where
    F: FnMut(&mut Gen) -> Result<(), String>,
{
    let mut generator = Gen::new(default_seed);
    let seed = generator.seed();
    for case in 0..cases {
        if let Err(reason) = property(&mut generator) {
            panic!(
                "\nPROPERTY FAILED: {name}\n  case:   {case}\n  seed:   {seed}\n  reason: {reason}\n\n  \
                 Reproduce with:  PROPTEST_SEED={seed} cargo test -p invariants\n  \
                 Then commit the shrunk case as a regression test.\n"
            );
        }
    }
}

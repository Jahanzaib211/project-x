//! # 01-domain-kernel
//!
//! The vocabulary of the business, expressed as types that make illegal states
//! unrepresentable.
//!
//! This is the most important crate in the system. Every financial error
//! downstream is either an error here, or an error this crate failed to make
//! impossible.
//!
//! ## The rules this crate enforces
//!
//! - **INV-001** — no IEEE-754 floating point. Money is an exact integer of
//!   minor units with an explicit per-currency scale.
//! - **INV-002** — `a + b == b + a`.
//! - **INV-003** — `(a + b) - b == a`, exactly.
//! - **INV-004** — money of different currencies cannot be added. This is a
//!   *compile-time* error, not a runtime check, because a runtime check is a
//!   branch someone can forget to write.
//! - **INV-005** — every rounding operation names its policy and its scale.
//!
//! ## Why currency is a type parameter
//!
//! ```compile_fail
//! # use domain_kernel::{Money, Usd, Eur};
//! let a: Money<Usd> = Money::from_minor(100);
//! let b: Money<Eur> = Money::from_minor(100);
//! let _ = a.add(b); // does not compile: expected Money<Usd>, found Money<Eur>
//! ```
//!
//! The alternative — a `currency` field checked at runtime — pushes the error
//! from compile time to production, which is exactly the wrong direction.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod money;
pub mod quantity;
pub mod rounding;

pub use money::{AnyMoney, Money, MoneyError};
pub use quantity::{Price, Quantity};
pub use rounding::Rounding;

/// A currency, with the scale at which it is exactly representable.
///
/// Scale is the number of decimal places in the currency's minor unit: 2 for
/// USD (cents), 0 for JPY (yen), 8 for BTC (satoshi). It is a property of the
/// currency, not a formatting preference, and it never varies at runtime.
pub trait Currency: Copy + Clone + core::fmt::Debug + PartialEq + Eq + 'static {
    /// ISO 4217 code (or the accepted symbol for non-ISO assets).
    const CODE: &'static str;
    /// Decimal places in the minor unit.
    const SCALE: u32;
}

/// Declare a currency type.
#[macro_export]
macro_rules! currency {
    ($(#[$meta:meta])* $name:ident, $code:literal, $scale:literal) => {
        $(#[$meta])*
        #[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
        pub struct $name;
        impl $crate::Currency for $name {
            const CODE: &'static str = $code;
            const SCALE: u32 = $scale;
        }
    };
}

currency!(/// United States dollar. Minor unit: cent.
    Usd, "USD", 2);
currency!(/// Euro. Minor unit: cent.
    Eur, "EUR", 2);
currency!(/// Pound sterling. Minor unit: penny.
    Gbp, "GBP", 2);
currency!(/// Japanese yen. No minor unit.
    Jpy, "JPY", 0);
currency!(/// Swiss franc. Minor unit: rappen.
    Chf, "CHF", 2);
currency!(/// Gold, troy ounce. Scale 4 — commonly quoted to more places than a fiat currency.
    Xau, "XAU", 4);
currency!(/// Bitcoin. Minor unit: satoshi.
    Btc, "BTC", 8);

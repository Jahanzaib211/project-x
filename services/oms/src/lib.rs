//! The order lifecycle as a library (`10-oms`).
//!
//! The state machine — which transitions are legal, which states are
//! terminal, that every order ends in exactly one terminal state — is pure,
//! and the replay and property suites in `tests/` drive it directly. The
//! binary is the HTTP shell that turns a client's submission into a walk
//! through it.

#![forbid(unsafe_code)]

pub mod lifecycle;

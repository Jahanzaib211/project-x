//! G3/G4 — the order lifecycle (`10-oms`) over generated walks.
//!
//! INV-090: every order ends in exactly one terminal state, and never leaves
//! it. INV-092: only the declared transitions are legal, and the history
//! records each one. INV-093: an order whose outcome cannot be known ends
//! UNKNOWN, which is terminal too — never a guess at FILLED or REJECTED.

#![allow(
    clippy::unwrap_used,
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing
)]

use invariants::{for_all, Gen};
use oms::lifecycle::{Lifecycle, OrderState};

fn any_state(g: &mut Gen) -> OrderState {
    OrderState::ALL[g.in_range(0, OrderState::ALL.len() as i128 - 1) as usize]
}

/// INV-090/092 — a random walk of attempted transitions: every accepted step
/// is a declared edge, the history is exactly the accepted steps, a terminal
/// state accepts nothing, and no walk ever holds two terminal states.
#[test]
fn inv_090_a_walk_ends_in_one_terminal_state_and_stays_there() {
    for_all("lifecycle walks", 5_000, 0x0900, |g| {
        let mut life = Lifecycle::new();
        let mut accepted = vec![life.current()];
        for _ in 0..g.small_count() + 3 {
            let from = life.current();
            let next = any_state(g);
            let legal = from.can_transition_to(next);
            match life.advance(next) {
                Ok(now) => {
                    if !legal {
                        return Err(format!(
                            "INV-092 {from:?} -> {next:?} was accepted but is not declared legal"
                        ));
                    }
                    if now != next {
                        return Err("advance returned a state other than the one asked for".into());
                    }
                    if from.is_terminal() {
                        return Err(format!("INV-090 left terminal state {from:?}"));
                    }
                    accepted.push(now);
                }
                Err(err) => {
                    if legal {
                        return Err(format!(
                            "INV-092 declared-legal {from:?} -> {next:?} was refused: {err:?}"
                        ));
                    }
                    if err.from != from || err.to != next {
                        return Err("the refusal names the wrong transition".into());
                    }
                }
            }
        }
        if life.history() != accepted.as_slice() {
            return Err("INV-092 the history is not the accepted steps".into());
        }
        let terminals = life.history().iter().filter(|s| s.is_terminal()).count();
        if terminals > 1 {
            return Err(format!(
                "INV-090 {terminals} terminal states in one history"
            ));
        }
        if let Some(last) = life.history().last() {
            if terminals == 1 && !last.is_terminal() {
                return Err("INV-090 a terminal state was followed by another".into());
            }
        }
        Ok(())
    });
}

/// INV-093 — an order whose outcome is not known is UNKNOWN, never a guess:
/// only an order that was *executing* can become UNKNOWN (before that there is
/// nothing to be unsure of), and UNKNOWN leaves only on a known outcome —
/// FILLED or REJECTED, learned from the core — never on anything else.
#[test]
fn inv_093_unknown_arises_only_from_executing_and_resolves_only_to_a_known_outcome() {
    for state in OrderState::ALL {
        let may = state.can_transition_to(OrderState::Unknown);
        assert_eq!(
            may,
            *state == OrderState::Executing,
            "{state:?} -> UNKNOWN should be {}",
            *state == OrderState::Executing
        );
    }
    for next in OrderState::ALL {
        let may = OrderState::Unknown.can_transition_to(*next);
        let known = matches!(next, OrderState::Filled | OrderState::Rejected);
        assert_eq!(may, known, "UNKNOWN -> {next:?} should be {known}");
    }
    assert!(
        !OrderState::Unknown.is_terminal(),
        "UNKNOWN is pending resolution, not a verdict"
    );
    for state in OrderState::ALL.iter().filter(|s| s.is_terminal()) {
        for next in OrderState::ALL {
            assert!(
                !state.can_transition_to(*next),
                "terminal {state:?} moved to {next:?}"
            );
        }
    }
}

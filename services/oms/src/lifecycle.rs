//! The order state machine.
//!
//! Every order has exactly one lifecycle, every transition is legal and
//! recorded, and no transition can be skipped (INV-090).

/// The order lifecycle. Exhaustive by construction — there is no catch-all arm
/// anywhere that matches on it, so adding a state is a compile error until
/// every transition has been considered.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum OrderState {
    /// Received, nothing done yet.
    New,
    /// Being checked for well-formedness.
    Validating,
    /// With the risk engine.
    RiskCheck,
    /// Risk said yes; not yet sent.
    Accepted,
    /// Sent for execution, outcome not yet known.
    Executing,
    /// Some quantity filled.
    PartiallyFilled,
    /// Fully filled.
    Filled,
    /// The position has been updated for this fill.
    PositionUpdated,
    /// Settled in the ledger.
    Settled,
    /// Refused.
    Rejected,
    /// Cancelled before execution.
    Cancelled,
    /// Expired before execution.
    Expired,
    /// Sent, and the outcome is genuinely unknown (INV-093).
    ///
    /// Not a synonym for rejected and not a synonym for filled. An order here
    /// requires reconciliation against the core before anything may be assumed
    /// about it — which is the only honest thing to do, and the reason this
    /// state exists rather than a boolean somewhere.
    Unknown,
}

impl OrderState {
    /// Whether a transition is legal. INV-090: every transition is legal and
    /// recorded.
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        use OrderState::{
            Accepted, Cancelled, Executing, Expired, Filled, New, PartiallyFilled, PositionUpdated,
            Rejected, RiskCheck, Settled, Unknown, Validating,
        };
        matches!(
            (self, next),
            (New, Validating)
                | (Validating, RiskCheck)
                | (Validating, Rejected)
                | (RiskCheck, Accepted)
                | (RiskCheck, Rejected)
                | (Accepted, Executing)
                | (Accepted, Cancelled)
                | (Accepted, Expired)
                | (Executing, PartiallyFilled)
                | (Executing, Filled)
                | (Executing, Rejected)
                | (Executing, Unknown)
                | (PartiallyFilled, PartiallyFilled)
                | (PartiallyFilled, Filled)
                | (PartiallyFilled, Cancelled)
                | (Filled, PositionUpdated)
                | (PositionUpdated, Settled)
                // An unknown outcome is resolved by reconciliation, never by
                // assumption — and it resolves to exactly one of these.
                | (Unknown, Filled)
                | (Unknown, Rejected)
        )
    }

    /// Terminal states admit no further transition.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Settled | Self::Rejected | Self::Cancelled | Self::Expired
        )
    }

    /// Name, for logs and the API.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::New => "NEW",
            Self::Validating => "VALIDATING",
            Self::RiskCheck => "RISK_CHECK",
            Self::Accepted => "ACCEPTED",
            Self::Executing => "EXECUTING",
            Self::PartiallyFilled => "PARTIALLY_FILLED",
            Self::Filled => "FILLED",
            Self::PositionUpdated => "POSITION_UPDATED",
            Self::Settled => "SETTLED",
            Self::Rejected => "REJECTED",
            Self::Cancelled => "CANCELLED",
            Self::Expired => "EXPIRED",
            Self::Unknown => "UNKNOWN",
        }
    }

    /// Every state, for exhaustive tests and for the API's state list.
    pub const ALL: &'static [Self] = &[
        Self::New,
        Self::Validating,
        Self::RiskCheck,
        Self::Accepted,
        Self::Executing,
        Self::PartiallyFilled,
        Self::Filled,
        Self::PositionUpdated,
        Self::Settled,
        Self::Rejected,
        Self::Cancelled,
        Self::Expired,
        Self::Unknown,
    ];
}

/// An order's recorded path through the machine.
///
/// The history is kept, not just the current state: "how did this order get
/// here" is the first question asked about any order that went wrong, and a
/// single current-state field cannot answer it (INV-090).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lifecycle {
    states: Vec<OrderState>,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl Lifecycle {
    /// A new order, in [`OrderState::New`].
    #[must_use]
    pub fn new() -> Self {
        Self {
            states: vec![OrderState::New],
        }
    }

    /// The state the order is in now.
    #[must_use]
    pub fn current(&self) -> OrderState {
        self.states.last().copied().unwrap_or(OrderState::New)
    }

    /// Every state it has been in, in order.
    #[must_use]
    pub fn history(&self) -> &[OrderState] {
        &self.states
    }

    /// Advance the order.
    ///
    /// # Errors
    /// The transition is not legal from the current state. The order is left
    /// exactly where it was — an illegal transition changes nothing, rather
    /// than half-applying.
    pub fn advance(&mut self, next: OrderState) -> Result<OrderState, IllegalTransition> {
        let current = self.current();
        if !current.can_transition_to(next) {
            return Err(IllegalTransition {
                from: current,
                to: next,
            });
        }
        self.states.push(next);
        Ok(next)
    }
}

/// A transition that the machine does not permit.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct IllegalTransition {
    /// Where the order was.
    pub from: OrderState,
    /// Where something tried to put it.
    pub to: OrderState,
}

impl core::fmt::Display for IllegalTransition {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "an order cannot go from {} to {}",
            self.from.name(),
            self.to.name()
        )
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    /// INV-090 — the happy path is a sequence of legal transitions, and it is
    /// recorded in full.
    #[test]
    fn inv_090_an_order_walks_the_machine_one_legal_step_at_a_time() {
        let mut order = Lifecycle::new();
        for state in [
            OrderState::Validating,
            OrderState::RiskCheck,
            OrderState::Accepted,
            OrderState::Executing,
            OrderState::Filled,
            OrderState::PositionUpdated,
            OrderState::Settled,
        ] {
            order.advance(state).unwrap();
        }
        assert_eq!(order.current(), OrderState::Settled);
        assert!(order.current().is_terminal());
        assert_eq!(order.history().len(), 8);
        assert_eq!(order.history()[0], OrderState::New);
    }

    /// INV-090 — a state cannot be skipped, and a rejected transition leaves
    /// the order untouched.
    #[test]
    fn inv_090_a_state_cannot_be_skipped() {
        let mut order = Lifecycle::new();
        let skipped = order.advance(OrderState::Filled);
        assert_eq!(
            skipped,
            Err(IllegalTransition {
                from: OrderState::New,
                to: OrderState::Filled
            })
        );
        assert_eq!(order.current(), OrderState::New, "nothing may have moved");
        assert_eq!(order.history().len(), 1);
    }

    #[test]
    fn a_terminal_order_goes_nowhere() {
        for terminal in OrderState::ALL.iter().filter(|s| s.is_terminal()) {
            for next in OrderState::ALL {
                assert!(
                    !terminal.can_transition_to(*next),
                    "{} -> {} must not be legal",
                    terminal.name(),
                    next.name()
                );
            }
        }
    }

    /// INV-093 — an unknown outcome is its own state, and it resolves to
    /// exactly one thing, never to an assumption.
    #[test]
    fn inv_093_an_unknown_outcome_is_never_assumed_either_way() {
        let mut order = Lifecycle::new();
        for state in [
            OrderState::Validating,
            OrderState::RiskCheck,
            OrderState::Accepted,
            OrderState::Executing,
            OrderState::Unknown,
        ] {
            order.advance(state).unwrap();
        }
        assert_eq!(order.current(), OrderState::Unknown);
        assert!(!order.current().is_terminal(), "unknown needs resolving");

        // It may resolve either way, but only to a real outcome.
        assert!(OrderState::Unknown.can_transition_to(OrderState::Filled));
        assert!(OrderState::Unknown.can_transition_to(OrderState::Rejected));
        assert!(!OrderState::Unknown.can_transition_to(OrderState::Settled));
        assert!(!OrderState::Unknown.can_transition_to(OrderState::Cancelled));
    }

    /// INV-092 — an order that has filled cannot then be cancelled, and one
    /// that has been cancelled cannot then fill. The race has exactly one
    /// outcome because the machine admits exactly one.
    #[test]
    fn inv_092_a_cancel_racing_a_fill_resolves_to_one_outcome() {
        let mut filled = Lifecycle::new();
        for state in [
            OrderState::Validating,
            OrderState::RiskCheck,
            OrderState::Accepted,
            OrderState::Executing,
            OrderState::Filled,
        ] {
            filled.advance(state).unwrap();
        }
        assert!(filled.advance(OrderState::Cancelled).is_err());

        let mut cancelled = Lifecycle::new();
        for state in [
            OrderState::Validating,
            OrderState::RiskCheck,
            OrderState::Accepted,
            OrderState::Cancelled,
        ] {
            cancelled.advance(state).unwrap();
        }
        assert!(cancelled.advance(OrderState::Filled).is_err());
        assert!(cancelled.advance(OrderState::Executing).is_err());
    }

    /// The whole transition matrix, asserted rather than sampled: every pair of
    /// states is either explicitly legal or explicitly not.
    #[test]
    fn the_legal_transition_matrix_is_exactly_what_is_declared() {
        let legal: Vec<(OrderState, OrderState)> = OrderState::ALL
            .iter()
            .flat_map(|from| {
                OrderState::ALL
                    .iter()
                    .filter(move |to| from.can_transition_to(**to))
                    .map(move |to| (*from, *to))
            })
            .collect();
        assert_eq!(
            legal.len(),
            19,
            "the matrix changed; update the docs with it"
        );

        // No state may transition to itself except a partial fill, which
        // genuinely repeats.
        for (from, to) in legal {
            if from == to {
                assert_eq!(from, OrderState::PartiallyFilled);
            }
        }
    }

    #[test]
    fn every_state_has_a_distinct_name() {
        let mut names: Vec<&str> = OrderState::ALL.iter().map(|s| s.name()).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count);
    }
}

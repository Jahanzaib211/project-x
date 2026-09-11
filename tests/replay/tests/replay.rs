//! G6 — deterministic replay.
//!
//! The claim under test: **the entire state of the business is a pure function
//! of its recorded history.** If that holds, the log is genuinely the truth and
//! any state can be reconstructed or audited. If it does not, the log is a
//! suggestion and every other guarantee in the system is weaker than advertised.
//!
//! Each test prints `state_hash=<hex>`. CI runs this binary twice in separate
//! processes and diffs the hashes, which catches determinism bugs that a
//! single-process test cannot — most often address-dependent or
//! allocation-order-dependent behaviour.

// Test code performs ordinary arithmetic on ordinary integers — loop counters,
// case indices, expected values. The strict workspace lints exist to keep
// unchecked arithmetic out of PRODUCTION financial paths; applying them to the
// bodies of the tests that verify those paths adds noise, not safety.
#![allow(
    clippy::arithmetic_side_effects,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing
)]

use domain_kernel::{Money, Usd};
use event_kernel::{Event, Id, Payload, Stream};
use invariants::{for_all, Gen};

/// A miniature account projection — the shape of every real projection in the
/// system: derived by folding events, never written to directly.
#[derive(Debug, PartialEq, Eq, Default)]
struct AccountState {
    balance_minor: i128,
    deposits: u32,
    withdrawals: u32,
}

fn deposit(id: u128, sequence: u64, amount: &str) -> Event {
    Event {
        event_id: Id(id),
        event_type: "account.deposited".to_owned(),
        aggregate_type: "account".to_owned(),
        aggregate_id: "acc-1".to_owned(),
        sequence,
        correlation_id: Id(1),
        causation_id: None,
        schema_version: 1,
        payload: Payload::new()
            .with("amount", amount)
            .with("currency", "USD"),
        recorded_at_micros: 1_700_000_000_000_000,
    }
}

fn withdrawal(id: u128, sequence: u64, amount: &str) -> Event {
    let mut event = deposit(id, sequence, amount);
    event.event_type = "account.withdrawn".to_owned();
    event
}

/// Apply one event to a state. Pure: no clock read, no randomness, no I/O.
///
/// Taking a starting state rather than always starting from default is what
/// makes `snapshot + tail == full replay` expressible at all.
fn apply(mut state: AccountState, event: &Event) -> AccountState {
    let amount = event
        .payload
        .get("amount")
        .and_then(|raw| Money::<Usd>::from_decimal_str(raw).ok())
        .unwrap_or_else(Money::<Usd>::zero);

    match event.event_type.as_str() {
        "account.deposited" => {
            state.balance_minor = state.balance_minor.saturating_add(amount.minor());
            state.deposits = state.deposits.saturating_add(1);
        }
        "account.withdrawn" => {
            state.balance_minor = state.balance_minor.saturating_sub(amount.minor());
            state.withdrawals = state.withdrawals.saturating_add(1);
        }
        // An unknown event type must not silently change state. Forward
        // compatibility means ignoring what you cannot interpret — never
        // guessing at it.
        _ => {}
    }
    state
}

/// Fold a slice of events onto a starting state.
fn project_from(initial: AccountState, events: &[Event]) -> AccountState {
    events.iter().fold(initial, apply)
}

/// The full fold, from genesis. This is what "replay" means.
fn project(stream: &Stream) -> AccountState {
    stream.fold(AccountState::default(), apply)
}

/// INV-014 — replaying from genesis reproduces identical state.
#[test]
fn replay_from_genesis_is_identical() {
    let mut stream = Stream::new();
    for sequence in 1..=500u64 {
        let id = u128::from(sequence);
        let event = if sequence % 3 == 0 {
            withdrawal(id, sequence, "10.25")
        } else {
            deposit(id, sequence, "100.50")
        };
        stream.append(event).expect("append");
    }

    let first = project(&stream);
    let second = project(&stream);
    let third = project(&stream);

    assert_eq!(first, second, "replay diverged between run 1 and 2");
    assert_eq!(second, third, "replay diverged between run 2 and 3");
    println!("state_hash={:016x}", stream.content_hash());
}

/// INV-014 — a snapshot plus the remaining tail must equal a full replay.
///
/// If it does not, the snapshot is a second, competing truth — which is exactly
/// the failure snapshots are supposed to avoid.
#[test]
fn snapshot_plus_tail_equals_full_replay() {
    for_all("G6 snapshot equivalence", 500, 0x6001, |g: &mut Gen| {
        let total = 20 + (g.next_u64() % 60);
        let mut full = Stream::new();
        for i in 1..=total {
            let amount = format!("{}.{:02}", g.in_range(0, 500), g.in_range(0, 99));
            let event = if i % 4 == 0 {
                withdrawal(u128::from(i), i, &amount)
            } else {
                deposit(u128::from(i), i, &amount)
            };
            full.append(event).map_err(|e| format!("append: {e:?}"))?;
        }

        let complete = project(&full);

        // Take a snapshot halfway, then fold only the tail onto it.
        let events = full.events();
        let split_at = events.len() / 2;
        let snapshot = project_from(AccountState::default(), &events[..split_at]);
        let from_snapshot = project_from(snapshot, &events[split_at..]);

        if from_snapshot == complete {
            Ok(())
        } else {
            Err(format!(
                "snapshot+tail {from_snapshot:?} != full replay {complete:?} (split at {split_at} of {total})"
            ))
        }
    });
}

/// INV-013 — the stream hash depends on content, not on observation time.
///
/// The most common cause of a replay divergence in practice: a wall-clock read
/// that leaked into the recorded state.
#[test]
fn observation_time_does_not_affect_replayed_state() {
    let mut early = Stream::new();
    let mut late = Stream::new();
    for i in 1..=100u64 {
        let mut a = deposit(u128::from(i), i, "1.00");
        let mut b = deposit(u128::from(i), i, "1.00");
        a.recorded_at_micros = 1;
        b.recorded_at_micros = i64::MAX;
        early.append(a).expect("append");
        late.append(b).expect("append");
    }
    assert_eq!(project(&early), project(&late));
    assert_eq!(early.content_hash(), late.content_hash());
    println!("state_hash={:016x}", early.content_hash());
}

/// INV-010 — a duplicated delivery must not change the replayed result.
///
/// The network will redeliver. Replay must be indifferent to it.
#[test]
fn duplicate_delivery_does_not_change_replayed_state() {
    let mut clean = Stream::new();
    let mut noisy = Stream::new();
    for i in 1..=200u64 {
        let event = deposit(u128::from(i), i, "25.00");
        clean.append(event.clone()).expect("append");
        noisy.append(event.clone()).expect("append");
        // Deliver the same event two more times.
        noisy.append(event.clone()).expect("duplicate is a no-op");
        noisy.append(event).expect("duplicate is a no-op");
    }
    assert_eq!(project(&clean), project(&noisy));
    assert_eq!(clean.content_hash(), noisy.content_hash());
    println!("state_hash={:016x}", clean.content_hash());
}

/// Money is exact across a long replay. A rounding error here would compound
/// into a real, unexplainable balance difference.
#[test]
fn balances_are_exact_across_a_long_replay() {
    let mut stream = Stream::new();
    for i in 1..=10_000u64 {
        stream
            .append(deposit(u128::from(i), i, "0.10"))
            .expect("append");
    }
    let state = project(&stream);
    // 10,000 x 0.10 = 1,000.00 exactly. With floats this drifts.
    assert_eq!(state.balance_minor, 100_000);
    assert_eq!(
        Money::<Usd>::from_minor(state.balance_minor).to_decimal_string(),
        "1000.00"
    );
    println!("state_hash={:016x}", stream.content_hash());
}

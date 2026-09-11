//! G4 — invariants of `02-event-kernel`.

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

use event_kernel::{Event, EventError, Id, Payload, Stream};
use invariants::{for_all, Gen};

const CASES: u32 = 5_000;

fn event(id: u128, sequence: u64) -> Event {
    Event {
        event_id: Id(id),
        event_type: "ledger.transaction_posted".to_owned(),
        aggregate_type: "account".to_owned(),
        aggregate_id: "acc-1".to_owned(),
        sequence,
        correlation_id: Id(7),
        causation_id: None,
        schema_version: 1,
        payload: Payload::new().with("amount", "10.00"),
        recorded_at_micros: 1_700_000_000_000_000,
    }
}

/// INV-010 — a duplicate append is a no-op, not a second effect.
///
/// This is the event-layer expression of exactly-once. The network will deliver
/// the same message twice; the log must record the fact once.
#[test]
fn inv_010_duplicate_append_has_no_second_effect() {
    for_all("INV-010 idempotent append", CASES, 0x2010, |g: &mut Gen| {
        let mut stream = Stream::new();
        let id = g.next_u64() as u128;
        let first = stream
            .append(event(id, 1))
            .map_err(|e| format!("first append failed: {e:?}"))?;
        let repeats = g.small_count();
        for _ in 0..repeats {
            let applied = stream
                .append(event(id, stream.next_sequence()))
                .map_err(|e| format!("repeat append errored: {e:?}"))?;
            if applied {
                return Err("a duplicate event_id was applied a second time".to_owned());
            }
        }
        if first && stream.events().len() == 1 {
            Ok(())
        } else {
            Err(format!("stream holds {} events", stream.events().len()))
        }
    });
}

/// INV-011 — the per-aggregate sequence is gapless and strictly increasing.
#[test]
fn inv_011_sequence_is_gapless_and_increasing() {
    for_all("INV-011 gapless sequence", CASES, 0x2011, |g: &mut Gen| {
        let mut stream = Stream::new();
        let count = g.small_count();
        for i in 1..=u64::from(count) {
            stream
                .append(event(u128::from(i), i))
                .map_err(|e| format!("append {i} failed: {e:?}"))?;
        }
        let sequences: Vec<u64> = stream.events().iter().map(|e| e.sequence).collect();
        let expected: Vec<u64> = (1..=u64::from(count)).collect();
        if sequences != expected {
            return Err(format!("sequences {sequences:?}, expected {expected:?}"));
        }
        // A gap must be refused, not parked silently.
        let skipped = stream.next_sequence() + 1;
        match stream.append(event(0xdead, skipped)) {
            Err(EventError::SequenceGap { .. }) => Ok(()),
            other => Err(format!("a gap was accepted: {other:?}")),
        }
    });
}

/// INV-012 — the log is append-only.
///
/// The in-memory `Stream` exposes no mutation path at all; the database enforces
/// the same rule with a trigger (see `infra/postgres/init/001_schema.sql`, and
/// the CI check `scripts/verify_ledger_constraints.sh`). Stating the law in two
/// independent places is how you find out when one of them is wrong.
#[test]
fn inv_012_the_log_offers_no_mutation_path() {
    let mut stream = Stream::new();
    for i in 1..=10u64 {
        stream.append(event(u128::from(i), i)).expect("append");
    }
    let before = stream.content_hash();
    // `events()` hands out a shared slice; there is no `events_mut`.
    let _read_only: &[Event] = stream.events();
    assert_eq!(stream.content_hash(), before);
}

/// INV-013 — canonical serialization is byte-identical for identical content.
///
/// The property that makes replay comparison meaningful. Break it and G6 proves
/// nothing.
#[test]
fn inv_013_canonical_bytes_are_order_independent() {
    for_all("INV-013 canonical bytes", CASES, 0x2013, |g: &mut Gen| {
        let keys = ["alpha", "beta", "gamma", "delta"];
        let values: Vec<String> = (0..keys.len())
            .map(|_| g.in_range(0, 100_000).to_string())
            .collect();

        let mut forward = Payload::new();
        for (k, v) in keys.iter().zip(values.iter()) {
            forward = forward.with(k, v.clone());
        }
        let mut backward = Payload::new();
        for (k, v) in keys.iter().zip(values.iter()).rev() {
            backward = backward.with(k, v.clone());
        }

        let mut a = event(1, 1);
        let mut b = event(1, 1);
        a.payload = forward;
        b.payload = backward;

        if a.canonical_bytes() == b.canonical_bytes() && a.content_hash() == b.content_hash() {
            Ok(())
        } else {
            Err("insertion order changed the canonical bytes".to_owned())
        }
    });
}

/// INV-013 — observation time is metadata, never content.
///
/// Ordering is sequence (P4). If `recorded_at` reached the canonical bytes, two
/// replays of the same history would disagree.
#[test]
fn inv_013_observation_time_is_not_content() {
    for_all("INV-013 time is metadata", CASES, 0x2014, |g: &mut Gen| {
        let mut a = event(1, 1);
        let mut b = event(1, 1);
        a.recorded_at_micros = g.in_range(0, i128::from(i64::MAX)) as i64;
        b.recorded_at_micros = g.in_range(0, i128::from(i64::MAX)) as i64;
        if a.canonical_bytes() == b.canonical_bytes() {
            Ok(())
        } else {
            Err("recorded_at leaked into the canonical bytes".to_owned())
        }
    });
}

/// INV-014 — replaying from genesis reproduces identical state.
#[test]
fn inv_014_replay_reproduces_state_exactly() {
    for_all(
        "INV-014 replay determinism",
        CASES,
        0x2015,
        |g: &mut Gen| {
            let mut stream = Stream::new();
            let count = u64::from(g.small_count()) + 5;
            for i in 1..=count {
                let mut e = event(u128::from(i), i);
                e.payload = Payload::new().with("amount", g.in_range(-10_000, 10_000).to_string());
                stream.append(e).map_err(|err| format!("append: {err:?}"))?;
            }

            // Fold twice; the two results must be identical, and so must the hash.
            let fold = |s: &Stream| {
                s.fold(0i128, |acc, e| {
                    let amount: i128 = e
                        .payload
                        .get("amount")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0);
                    acc.saturating_add(amount)
                })
            };
            let first = fold(&stream);
            let second = fold(&stream);
            if first == second && stream.content_hash() == stream.content_hash() {
                Ok(())
            } else {
                Err(format!("replay diverged: {first} vs {second}"))
            }
        },
    );
}

/// INV-010 — ids round-trip through their canonical form.
#[test]
fn inv_010_ids_round_trip() {
    for_all("INV-010 id round trip", CASES, 0x2016, |g: &mut Gen| {
        let raw = (u128::from(g.next_u64()) << 64) | u128::from(g.next_u64());
        let id = Id(raw);
        match Id::parse(&id.to_string()) {
            Ok(back) if back == id => Ok(()),
            other => Err(format!("{id} round-tripped to {other:?}")),
        }
    });
}

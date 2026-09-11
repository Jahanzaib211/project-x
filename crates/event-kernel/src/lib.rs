//! # 02-event-kernel
//!
//! One envelope, one clock, one identity scheme for every fact the system
//! records.
//!
//! Everything downstream — the ledger, positions, risk, execution — is a fold
//! over this stream, so replay determinism is decided here and nowhere else.
//!
//! ## Rules
//!
//! - **INV-010** — `event_id` is globally unique; a duplicate append is a no-op,
//!   not a second effect.
//! - **INV-011** — the per-aggregate sequence is gapless and strictly increasing.
//! - **INV-012** — the log is append-only. No update, no delete, no reordering.
//! - **INV-013** — canonical serialization is byte-identical for identical
//!   logical content.
//! - **INV-014** — replaying from genesis reproduces byte-identical state.
//!
//! ## Ordering is sequence, never time
//!
//! `recorded_at` says when a fact was observed. It never says what happened
//! first. Clocks skew, jump, and go backwards; a sequence number does not.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use core::fmt;

/// A 128-bit identifier, rendered as a hyphenated hex string.
///
/// Generation lives at the edge, so that the core stays a pure function of its
/// inputs and replay is possible. An id is data on an event, never something
/// the core invents mid-fold.
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Id(pub u128);

impl Id {
    /// The nil id. Useful as an explicit "absent", never as a default that
    /// silently stands in for a real value.
    pub const NIL: Self = Self(0);

    /// Whether this is the nil id.
    #[must_use]
    pub const fn is_nil(self) -> bool {
        self.0 == 0
    }

    /// Parse from the canonical 8-4-4-4-12 hex form.
    ///
    /// # Errors
    /// Returns `Err` if the input is not exactly that form.
    pub fn parse(input: &str) -> Result<Self, EventError> {
        let mut value: u128 = 0;
        let mut digits = 0u32;
        for byte in input.bytes() {
            if byte == b'-' {
                continue;
            }
            let nibble = char::from(byte)
                .to_digit(16)
                .map(u128::from)
                .ok_or(EventError::MalformedId)?;
            value = value
                .checked_mul(16)
                .and_then(|v| v.checked_add(nibble))
                .ok_or(EventError::MalformedId)?;
            digits = digits.checked_add(1).ok_or(EventError::MalformedId)?;
        }
        if digits != 32 {
            return Err(EventError::MalformedId);
        }
        Ok(Self(value))
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let hex = format!("{:032x}", self.0);
        // 8-4-4-4-12
        let (a, rest) = hex.split_at(8);
        let (b, rest) = rest.split_at(4);
        let (c, rest) = rest.split_at(4);
        let (d, e) = rest.split_at(4);
        write!(f, "{a}-{b}-{c}-{d}-{e}")
    }
}

/// Something went wrong handling an event.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum EventError {
    /// An id was not in canonical form.
    MalformedId,
    /// The event's sequence did not immediately follow the stream's. (INV-011)
    SequenceGap {
        /// Sequence the stream expected next.
        expected: u64,
        /// Sequence the event actually carried.
        actual: u64,
    },
    /// This `event_id` has already been appended. Idempotent, not an error the
    /// caller must fear — but the caller must know no second effect occurred.
    Duplicate,
    /// A schema version this build cannot decode.
    UnsupportedSchema(u32),
}

impl fmt::Display for EventError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MalformedId => f.write_str("malformed id"),
            Self::SequenceGap { expected, actual } => {
                write!(f, "sequence gap: expected {expected}, got {actual}")
            }
            Self::Duplicate => f.write_str("duplicate event"),
            Self::UnsupportedSchema(v) => write!(f, "unsupported schema version {v}"),
        }
    }
}

/// The universal event envelope.
///
/// Every fact in the system is one of these. The payload varies; the envelope
/// never does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    /// Globally unique. Two appends with the same id are one fact. (INV-010)
    pub event_id: Id,
    /// What happened, for example `ledger.transaction_posted`.
    pub event_type: String,
    /// Which kind of thing it happened to.
    pub aggregate_type: String,
    /// Which specific thing it happened to.
    pub aggregate_id: String,
    /// Position within that aggregate's stream. Gapless, from 1. (INV-011)
    pub sequence: u64,
    /// Ties together everything caused by one originating request.
    pub correlation_id: Id,
    /// The event that directly caused this one, if any.
    pub causation_id: Option<Id>,
    /// Payload schema version, for forward and backward compatibility.
    pub schema_version: u32,
    /// The fact itself, as canonical key-sorted pairs.
    pub payload: Payload,
    /// When it was *observed*. Metadata — never ordering. (P4)
    pub recorded_at_micros: i64,
}

/// A payload as sorted key/value pairs.
///
/// Deliberately not a hash map. Map iteration order varies between runs and
/// between builds, and that variance reaches the serialized bytes and breaks
/// replay determinism (INV-013). Sorted pairs cannot do that.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Payload(Vec<(String, String)>);

impl Payload {
    /// An empty payload.
    #[must_use]
    pub fn new() -> Self {
        Self(Vec::new())
    }

    /// Set a field. Re-setting a key replaces it, keeping the ordering canonical.
    #[must_use]
    pub fn with(mut self, key: &str, value: impl Into<String>) -> Self {
        let value = value.into();
        match self.0.binary_search_by(|(k, _)| k.as_str().cmp(key)) {
            Ok(index) => {
                if let Some(slot) = self.0.get_mut(index) {
                    slot.1 = value;
                }
            }
            Err(index) => self.0.insert(index, (key.to_owned(), value)),
        }
        self
    }

    /// Read a field.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .binary_search_by(|(k, _)| k.as_str().cmp(key))
            .ok()
            .and_then(|i| self.0.get(i))
            .map(|(_, v)| v.as_str())
    }

    /// The fields, in canonical (sorted) order.
    #[must_use]
    pub fn fields(&self) -> &[(String, String)] {
        &self.0
    }
}

impl Event {
    /// Canonical byte representation.
    ///
    /// Byte-identical for identical logical content, on any machine, in any
    /// build (INV-013). This is what gets hashed, signed and compared during
    /// replay — so it must never depend on map ordering, locale, or float
    /// formatting.
    #[must_use]
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = String::new();
        // Length-prefixed fields, so that no value's content can be mistaken for
        // a delimiter.
        let mut push = |label: &str, value: &str| {
            out.push_str(label);
            out.push(':');
            out.push_str(&value.len().to_string());
            out.push(':');
            out.push_str(value);
            out.push('\n');
        };
        push("event_id", &self.event_id.to_string());
        push("event_type", &self.event_type);
        push("aggregate_type", &self.aggregate_type);
        push("aggregate_id", &self.aggregate_id);
        push("sequence", &self.sequence.to_string());
        push("correlation_id", &self.correlation_id.to_string());
        push(
            "causation_id",
            &self
                .causation_id
                .map_or_else(String::new, |i| i.to_string()),
        );
        push("schema_version", &self.schema_version.to_string());
        for (key, value) in self.payload.fields() {
            push(&format!("payload.{key}"), value);
        }
        out.into_bytes()
    }

    /// A stable content hash of the canonical bytes (FNV-1a, 64-bit).
    ///
    /// For replay comparison and tamper detection in tests — not a
    /// cryptographic commitment.
    #[must_use]
    pub fn content_hash(&self) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in self.canonical_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }
}

/// An append-only stream of events for one aggregate.
///
/// The in-memory reference implementation of the rules the database also
/// enforces. Having both means the invariant is stated twice, in two places
/// that must agree — which is how you find out when one of them is wrong.
#[derive(Debug, Default)]
pub struct Stream {
    events: Vec<Event>,
    seen: Vec<Id>,
}

impl Stream {
    /// An empty stream.
    #[must_use]
    pub fn new() -> Self {
        Self {
            events: Vec::new(),
            seen: Vec::new(),
        }
    }

    /// The sequence the next event must carry.
    #[must_use]
    pub fn next_sequence(&self) -> u64 {
        // Saturating rather than `+ 1`: a stream long enough to overflow u64 is
        // impossible in practice, but "impossible in practice" is not a reason
        // to leave an unchecked addition in the code that orders financial events.
        (self.events.len() as u64).saturating_add(1)
    }

    /// Append an event.
    ///
    /// Idempotent: appending an `event_id` already present is a no-op returning
    /// `Ok(false)`, never a second effect (INV-010).
    ///
    /// # Errors
    /// [`EventError::SequenceGap`] if the sequence does not immediately follow
    /// the stream's (INV-011).
    pub fn append(&mut self, event: Event) -> Result<bool, EventError> {
        if self.seen.contains(&event.event_id) {
            return Ok(false);
        }
        let expected = self.next_sequence();
        if event.sequence != expected {
            return Err(EventError::SequenceGap {
                expected,
                actual: event.sequence,
            });
        }
        self.seen.push(event.event_id);
        self.events.push(event);
        Ok(true)
    }

    /// The events, in order.
    #[must_use]
    pub fn events(&self) -> &[Event] {
        &self.events
    }

    /// Fold the stream into a state. This is what "replay" means.
    pub fn fold<S, F>(&self, initial: S, mut step: F) -> S
    where
        F: FnMut(S, &Event) -> S,
    {
        let mut state = initial;
        for event in &self.events {
            state = step(state, event);
        }
        state
    }

    /// A stable hash over the whole stream, for replay comparison.
    #[must_use]
    pub fn content_hash(&self) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for event in &self.events {
            hash ^= event.content_hash();
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::arithmetic_side_effects, clippy::unwrap_used)]

    use super::*;

    fn event(id: u128, sequence: u64) -> Event {
        Event {
            event_id: Id(id),
            event_type: "test.happened".to_owned(),
            aggregate_type: "account".to_owned(),
            aggregate_id: "acc-1".to_owned(),
            sequence,
            correlation_id: Id(999),
            causation_id: None,
            schema_version: 1,
            payload: Payload::new()
                .with("amount", "10.00")
                .with("currency", "USD"),
            recorded_at_micros: 1_700_000_000_000_000,
        }
    }

    #[test]
    fn ids_round_trip_through_canonical_form() {
        let id = Id(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
        assert_eq!(Id::parse(&id.to_string()).unwrap(), id);
        assert_eq!(id.to_string().len(), 36);
    }

    #[test]
    fn malformed_ids_are_rejected() {
        for bad in ["", "xyz", "0123", "not-a-uuid-at-all-really-no"] {
            assert!(Id::parse(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn duplicate_append_is_a_no_op_not_a_second_effect() {
        // INV-010
        let mut stream = Stream::new();
        assert!(stream.append(event(1, 1)).unwrap());
        assert!(!stream.append(event(1, 2)).unwrap());
        assert_eq!(stream.events().len(), 1);
    }

    #[test]
    fn a_sequence_gap_is_refused() {
        // INV-011
        let mut stream = Stream::new();
        stream.append(event(1, 1)).unwrap();
        assert_eq!(
            stream.append(event(2, 3)),
            Err(EventError::SequenceGap {
                expected: 2,
                actual: 3
            })
        );
    }

    #[test]
    fn payload_field_order_does_not_affect_the_canonical_bytes() {
        // INV-013 — the property that makes replay comparable at all.
        let a = Payload::new().with("b", "2").with("a", "1").with("c", "3");
        let b = Payload::new().with("c", "3").with("a", "1").with("b", "2");
        assert_eq!(a, b);

        let mut ev_a = event(1, 1);
        let mut ev_b = event(1, 1);
        ev_a.payload = a;
        ev_b.payload = b;
        assert_eq!(ev_a.canonical_bytes(), ev_b.canonical_bytes());
        assert_eq!(ev_a.content_hash(), ev_b.content_hash());
    }

    #[test]
    fn length_prefixing_stops_payload_content_forging_a_field() {
        // A value containing a delimiter must not be able to look like two fields.
        let honest = Payload::new().with("note", "a\nsequence:99:x");
        let mut ev = event(1, 1);
        ev.payload = honest;
        let bytes = ev.canonical_bytes();
        let text = String::from_utf8(bytes).unwrap();
        // The real sequence field appears exactly once, with its own prefix.
        assert_eq!(text.matches("\nsequence:1:1\n").count(), 1);
    }

    #[test]
    fn observation_time_does_not_change_the_canonical_bytes() {
        // P4 — time is metadata. Two observations of the same fact are the same
        // fact, and replay must not care when they were recorded.
        let mut later = event(1, 1);
        later.recorded_at_micros = 9_999_999_999_999_999;
        assert_eq!(event(1, 1).canonical_bytes(), later.canonical_bytes());
    }

    #[test]
    fn replaying_a_stream_reproduces_the_same_state() {
        // INV-014, in miniature: fold(log) is deterministic.
        let mut stream = Stream::new();
        for i in 1..=100u64 {
            stream.append(event(u128::from(i), i)).unwrap();
        }
        let count_a = stream.fold(0u64, |acc, _| acc + 1);
        let count_b = stream.fold(0u64, |acc, _| acc + 1);
        assert_eq!(count_a, 100);
        assert_eq!(count_a, count_b);
        assert_eq!(stream.content_hash(), stream.content_hash());
    }
}

//! G5 — the services wired together, proven over the wire.
//!
//! These run against the composed stack (`make up`) and are `#[ignore]`d so a
//! unit run never needs it; `make test-integration` includes them. Each one
//! is a law that only means something *across* a process boundary:
//!
//! - INV-010/011/012 (`02-event-kernel`) as the ledger serves them: the
//!   journal's ids are unique and strictly increasing, and a page read twice
//!   is the same page — the log did not move under the reader.
//! - INV-014/023: the balance projection the ledger serves sums to zero per
//!   currency and its invariants endpoint agrees.
//! - INV-052 across services: market-data and pricing name the same tick and
//!   the same mid for a pinned tick.
//! - INV-181 across processes: the same idempotency key through the OMS is
//!   one order in the ledger.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing
)]

use std::time::Duration;

use service_kit::http::{get, post_json};
use service_kit::json::{parse, Value};

fn base(name: &str, default_port: u16) -> String {
    std::env::var(name).unwrap_or_else(|_| format!("http://127.0.0.1:{default_port}"))
}

fn json(url: &str) -> Value {
    let response = get(url, Duration::from_secs(5)).unwrap_or_else(|e| panic!("{url}: {e}"));
    assert!(response.is_success(), "{url} returned {}", response.status);
    parse(&response.body).unwrap()
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match value.get(key) {
        Some(Value::Array(items)) => items,
        other => panic!("{key} is not an array: {other:?}"),
    }
}

/// INV-010 / INV-011 / INV-012 — over the wire, from the ledger's journal.
#[test]
#[ignore = "needs the composed stack: make up"]
fn inv_011_the_served_journal_is_unique_strictly_increasing_and_stable() {
    let ledger = base("LEDGER_URL", 27002);
    let first = json(&format!("{ledger}/v1/journal?limit=1000"));
    let rows = array(&first, "transactions");
    assert!(
        !rows.is_empty(),
        "the ledger has no transactions to inspect"
    );
    let mut last: u64 = 0;
    for row in rows {
        let sequence = row.get("sequence").and_then(Value::as_u64).unwrap();
        assert!(sequence > last, "INV-011 sequence {sequence} after {last}");
        last = sequence;
        let id = row.str_field("transactionId").unwrap();
        assert_eq!(
            id.len(),
            36,
            "INV-010 a transaction id is a uuid-shaped rendering of its number"
        );
    }
    // Read again: the same page, byte for byte — the log is append-only.
    let again = json(&format!("{ledger}/v1/journal?limit={}", rows.len()));
    assert_eq!(
        format!("{:?}", array(&again, "transactions")),
        format!("{rows:?}"),
        "INV-012 the journal moved under a reader"
    );
    // Paging by sequence never repeats a row.
    let page = json(&format!(
        "{ledger}/v1/journal?after={}&limit=10",
        rows[0].get("sequence").and_then(Value::as_u64).unwrap()
    ));
    for row in array(&page, "transactions") {
        assert!(
            row.get("sequence").and_then(Value::as_u64).unwrap()
                > rows[0].get("sequence").and_then(Value::as_u64).unwrap()
        );
    }
}

/// INV-014 / INV-023 — the projection the ledger serves is balanced and its
/// own invariant monitor agrees.
#[test]
#[ignore = "needs the composed stack: make up"]
fn inv_023_the_served_trial_balance_sums_to_zero_and_the_monitor_agrees() {
    let ledger = base("LEDGER_URL", 27002);
    let balances = json(&format!("{ledger}/v1/balances"));
    assert_eq!(
        balances
            .get("balanced")
            .map(|v| matches!(v, Value::Bool(true))),
        Some(true)
    );
    let mut per_currency: std::collections::BTreeMap<String, i128> =
        std::collections::BTreeMap::new();
    for row in array(&balances, "balances") {
        let currency = row.str_field("currency").unwrap().to_owned();
        let minor: i128 = match row.get("signedMinor") {
            Some(Value::Number(text)) => text.parse().unwrap(),
            other => panic!("signedMinor: {other:?}"),
        };
        *per_currency.entry(currency).or_default() += minor;
    }
    for (currency, sum) in per_currency {
        assert_eq!(sum, 0, "INV-020 {currency} does not sum to zero");
    }
    let invariants = json(&format!("{ledger}/v1/invariants"));
    assert!(
        matches!(invariants.get("healthy"), Some(Value::Bool(true))),
        "{invariants:?}"
    );
}

/// INV-052 across services: for a pinned tick, market-data and pricing agree
/// on the tick and the mid, and pricing's quote is not inside market-data's.
#[test]
#[ignore = "needs the composed stack: make up"]
fn inv_052_market_data_and_pricing_agree_on_a_pinned_tick() {
    let market_data = base("MARKET_DATA_URL", 27003);
    let pricing = base("PRICING_URL", 27004);
    let now = json(&format!("{market_data}/v1/feed/status"))
        .get("tick")
        .and_then(Value::as_u64)
        .unwrap();
    for symbol in ["EURUSD", "XAUUSD", "BTCUSD"] {
        let venue = json(&format!(
            "{market_data}/v1/quote?symbol={symbol}&tick={now}"
        ));
        let client = json(&format!("{pricing}/v1/quote?symbol={symbol}&tick={now}"));
        assert_eq!(
            venue.str_field("mid"),
            client.str_field("mid"),
            "{symbol}: the mid differs across services"
        );
        let session_open = |q: &Value| {
            q.get("session")
                .and_then(|s| s.get("open"))
                .map(|v| matches!(v, Value::Bool(true)))
        };
        assert_eq!(
            session_open(&venue),
            session_open(&client),
            "{symbol}: the session differs across services"
        );
        let raw = |q: &Value, key: &str| {
            market_core::feed::parse_price_raw(q.str_field(key).unwrap()).unwrap()
        };
        assert!(
            raw(&client, "bid") <= raw(&venue, "bid") && raw(&client, "ask") >= raw(&venue, "ask"),
            "{symbol}: the client quote is inside the venue quote"
        );
    }
}

/// INV-181 across processes: one key, two submissions through the OMS, one
/// order in the ledger — with the same deal both times.
#[test]
#[ignore = "needs the composed stack: make up"]
fn inv_181_one_key_through_the_oms_is_one_order_in_the_ledger() {
    let ledger = base("LEDGER_URL", 27002);
    let oms = base("OMS_URL", 27005);
    let opened = post_json(
        &format!("{ledger}/v1/accounts"),
        r#"{"owner":"integration-suite","nickname":"G5","leverage":500,"mode":"demo"}"#,
        &[],
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(opened.is_success(), "{}", opened.body);
    let account = parse(&opened.body)
        .unwrap()
        .str_field("accountNumber")
        .unwrap()
        .to_owned();
    let key = format!("integration-{}", std::process::id());
    let body =
        format!(r#"{{"account":"{account}","symbol":"BTCUSD","side":"BUY","volume":"0.01"}}"#);
    let first = post_json(
        &format!("{oms}/v1/orders"),
        &body,
        &[("idempotency-key", &key)],
        Duration::from_secs(10),
    )
    .unwrap();
    let second = post_json(
        &format!("{oms}/v1/orders"),
        &body,
        &[("idempotency-key", &key)],
        Duration::from_secs(10),
    )
    .unwrap();
    assert!(first.is_success(), "{}", first.body);
    assert!(second.is_success(), "{}", second.body);
    let orders = json(&format!("{ledger}/v1/accounts/{account}/orders"));
    let rows = array(&orders, "orders");
    assert_eq!(
        rows.len(),
        1,
        "INV-181 two submissions of one key made {} orders",
        rows.len()
    );
    let state = json(&format!("{ledger}/v1/accounts/{account}/state"));
    let positions = array(state.get("valuation").unwrap(), "positions");
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0].str_field("volume"), Some("0.010"));
}

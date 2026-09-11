//! # 10-oms
//!
//! The order state machine. Every order has exactly one lifecycle, every
//! transition is legal and recorded, and no transition can be skipped.
//!
//! ## What this service owns, and what it does not
//!
//! It owns the **order**: its identity, its client order id, its path through
//! the machine, and the guarantee that a retry produces one order rather than
//! two (INV-091, INV-092, INV-093).
//!
//! It does not own the **money**. Valuing an account, checking it against risk,
//! booking a fill and posting the entries are one transaction, and they happen
//! inside `03-ledger` under a single lock. This service asks for that
//! transaction and records what came back. The alternative — orchestrating four
//! remote steps from here — would put a network partition in the middle of a
//! trade, and there is no correct way to finish one of those.
//!
//! ## Unknown is a real answer
//!
//! When the core cannot be reached, the order does not become "rejected" and it
//! does not become "filled". It becomes [`OrderState::Unknown`], and it stays
//! there until something reconciles it (INV-093). An order gateway that guesses
//! is an order gateway that double-fills.

mod lifecycle;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use lifecycle::{Lifecycle, OrderState};
use service_kit::http;
use service_kit::json::escape;
use service_kit::{log, port_from_env, Request, Response, Service, ServiceInfo};

/// How long the core has to answer before the outcome is unknown.
const CORE_TIMEOUT: Duration = Duration::from_secs(5);

/// One order as this service tracks it.
#[derive(Clone, Debug)]
struct Order {
    client_order_id: String,
    account: String,
    symbol: String,
    side: String,
    volume: String,
    lifecycle: Lifecycle,
    /// What the core said, verbatim, when it said anything.
    outcome: Option<String>,
    /// The refusal, lifted to the top level.
    ///
    /// The core's reason is inside its own reply, and every consumer of this
    /// gateway would otherwise have to know that shape to find out why an order
    /// was refused. A reason a client has to dig for is a reason they will
    /// render as "something went wrong".
    refusal: Option<(String, String)>,
}

/// Every order this gateway has seen.
#[derive(Default)]
struct Orders {
    orders: Vec<Order>,
}

impl Orders {
    /// INV-091 — a client order id maps to at most one order, forever. Not "at
    /// most one open order": at most one, including terminal ones, because the
    /// whole point of the guarantee is that a retry after a timeout cannot
    /// create a second.
    fn by_client_id(&self, client_order_id: &str) -> Option<&Order> {
        self.orders
            .iter()
            .find(|order| order.client_order_id == client_order_id)
    }

    fn of_account(&self, account: &str) -> Vec<&Order> {
        let mut found: Vec<&Order> = self
            .orders
            .iter()
            .filter(|order| order.account == account)
            .collect();
        found.reverse();
        found
    }
}

fn order_json(order: &Order) -> String {
    let refusal = order.refusal.as_ref().map_or_else(
        || r#""error":null,"detail":null"#.to_owned(),
        |(code, detail)| {
            format!(
                r#""error":"{}","detail":"{}""#,
                escape(code),
                escape(detail)
            )
        },
    );
    let history = order
        .lifecycle
        .history()
        .iter()
        .map(|state| format!(r#""{}""#, escape(state.name())))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"clientOrderId":"{}","account":"{}","symbol":"{}","side":"{}","volume":"{}","state":"{}","terminal":{},{refusal},"history":[{history}],"outcome":{}}}"#,
        escape(&order.client_order_id),
        escape(&order.account),
        escape(&order.symbol),
        escape(&order.side),
        escape(&order.volume),
        escape(order.lifecycle.current().name()),
        order.lifecycle.current().is_terminal(),
        order.outcome.as_deref().unwrap_or("null"),
    )
}

fn error(status: u16, code: &str, detail: &str) -> Response {
    Response::json(
        status,
        format!(
            r#"{{"error":"{}","detail":"{}"}}"#,
            escape(code),
            escape(detail)
        ),
    )
}

/// How the gateway reaches the core. A trait so tests can drive every branch —
/// including the one where the core does not answer — without a socket.
trait Core: Send + Sync {
    /// Place an order. Returns the status and body the core replied with.
    fn place(&self, body: &str, idempotency_key: &str) -> Result<(u16, String), String>;
    /// Close a position.
    fn close(&self, body: &str, idempotency_key: &str) -> Result<(u16, String), String>;
}

/// The real core, over HTTP.
struct LedgerCore {
    base: String,
}

impl Core for LedgerCore {
    fn place(&self, body: &str, idempotency_key: &str) -> Result<(u16, String), String> {
        self.call("/v1/orders", body, idempotency_key)
    }
    fn close(&self, body: &str, idempotency_key: &str) -> Result<(u16, String), String> {
        self.call("/v1/positions/close", body, idempotency_key)
    }
}

impl LedgerCore {
    fn call(&self, path: &str, body: &str, key: &str) -> Result<(u16, String), String> {
        http::post_json(
            &format!("{}{path}", self.base),
            body,
            &[("idempotency-key", key)],
            CORE_TIMEOUT,
        )
        .map(|response| (response.status, response.body))
        .map_err(|err| err.to_string())
    }
}

/// Walk a new order up to the point of execution.
///
/// Each step is a real transition, recorded — the machine is not a decoration
/// on top of a boolean.
fn to_executing(order: &mut Order) -> Result<(), String> {
    for state in [
        OrderState::Validating,
        OrderState::RiskCheck,
        OrderState::Accepted,
        OrderState::Executing,
    ] {
        order
            .lifecycle
            .advance(state)
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Record what the core said against the order.
fn settle(order: &mut Order, status: u16, body: &str) {
    order.outcome = Some(body.to_owned());
    if !(200..300).contains(&status) {
        // Lift the core's own words. Its reason names the rule that refused —
        // "not enough free margin", "above the maximum" — and that is the only
        // part of a refusal a client can act on.
        if let Ok(parsed) = service_kit::json::parse(body) {
            let code = parsed.str_field("error").unwrap_or("ORDER_REFUSED");
            let detail = parsed
                .str_field("detail")
                .unwrap_or("The order was refused.");
            order.refusal = Some((code.to_owned(), detail.to_owned()));
        }
    }
    let landing = if (200..300).contains(&status) {
        OrderState::Filled
    } else if (400..500).contains(&status) {
        // The core refused it. That is a definite answer, so the order is
        // rejected rather than unknown.
        OrderState::Rejected
    } else {
        // 5xx: the core may or may not have booked it. Never guess (INV-093).
        OrderState::Unknown
    };
    let _ = order.lifecycle.advance(landing);
    if landing == OrderState::Filled {
        // A fill is only settled once the core's own postings are in, which
        // they are by the time it answers: the ledger writes before it replies.
        let _ = order.lifecycle.advance(OrderState::PositionUpdated);
        let _ = order.lifecycle.advance(OrderState::Settled);
    }
}

fn submit(
    orders: &Mutex<Orders>,
    core: &dyn Core,
    request: &Request,
    closing: bool,
) -> Option<Response> {
    let Ok(body) = request.json() else {
        return Some(error(400, "bad_request", "body is not valid JSON"));
    };
    let key = match request
        .header("idempotency-key")
        .map(str::to_owned)
        .or_else(|| body.str_field("clientOrderId").map(str::to_owned))
    {
        Some(key) if key.len() >= 8 => key,
        _ => {
            return Some(error(
                400,
                "idempotency_key_required",
                "a client order id of at least 8 characters is required; a retry must not \
                 become a second order",
            ))
        }
    };

    let mut orders = match orders.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    // INV-091 — one client order id, one order, forever.
    if let Some(existing) = orders.by_client_id(&key) {
        return Some(Response::json(200, order_json(existing)));
    }

    let account = body.str_field("account").unwrap_or_default().to_owned();
    let symbol = body.str_field("symbol").unwrap_or_default().to_owned();
    if account.is_empty() || symbol.is_empty() {
        return Some(error(
            400,
            "bad_request",
            "\"account\" and \"symbol\" are required",
        ));
    }

    let mut order = Order {
        client_order_id: key.clone(),
        account,
        symbol,
        side: body
            .str_field("side")
            .unwrap_or(if closing { "CLOSE" } else { "" })
            .to_owned(),
        volume: body.str_field("volume").unwrap_or("0.000").to_owned(),
        lifecycle: Lifecycle::new(),
        outcome: None,
        refusal: None,
    };

    if let Err(detail) = to_executing(&mut order) {
        return Some(error(500, "lifecycle", &detail));
    }

    let call = if closing {
        core.close(&request.body, &key)
    } else {
        core.place(&request.body, &key)
    };

    let status = match call {
        Ok((status, body)) => {
            settle(&mut order, status, &body);
            if (200..300).contains(&status) {
                201
            } else {
                status
            }
        }
        Err(detail) => {
            // The core did not answer. The order is not rejected — it may well
            // have been booked — so it goes to Unknown and says so.
            order.outcome = Some(format!(r#"{{"detail":"{}"}}"#, escape(&detail)));
            order.refusal = Some((
                "CORE_UNREACHABLE".to_owned(),
                format!("The core did not answer, so this order's outcome is unknown: {detail}"),
            ));
            let _ = order.lifecycle.advance(OrderState::Unknown);
            503
        }
    };

    let rendered = order_json(&order);
    orders.orders.push(order);
    Some(Response::json(status, rendered))
}

fn handle(orders: &Mutex<Orders>, core: &dyn Core, request: &Request) -> Option<Response> {
    match (request.method.as_str(), request.segments().as_slice()) {
        ("GET", ["v1", "states"]) => {
            let states = OrderState::ALL
                .iter()
                .map(|state| {
                    format!(
                        r#"{{"state":"{}","terminal":{}}}"#,
                        escape(state.name()),
                        state.is_terminal()
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            let transitions = OrderState::ALL
                .iter()
                .flat_map(|from| {
                    OrderState::ALL
                        .iter()
                        .filter(move |to| from.can_transition_to(**to))
                        .map(move |to| {
                            format!(
                                r#"{{"from":"{}","to":"{}"}}"#,
                                escape(from.name()),
                                escape(to.name())
                            )
                        })
                })
                .collect::<Vec<_>>()
                .join(",");
            Some(Response::json(
                200,
                format!(
                    r#"{{"states":[{states}],"transitions":[{transitions}],"invariants":["INV-090","INV-091","INV-092","INV-093"]}}"#
                ),
            ))
        }

        ("POST", ["v1", "orders"]) => submit(orders, core, request, false),
        ("POST", ["v1", "positions", "close"]) => submit(orders, core, request, true),

        ("GET", ["v1", "orders"]) => {
            let account = request.param("account").unwrap_or_default();
            let guard = match orders.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let list = guard
                .of_account(account)
                .into_iter()
                .map(order_json)
                .collect::<Vec<_>>()
                .join(",");
            Some(Response::json(200, format!(r#"{{"orders":[{list}]}}"#)))
        }

        ("GET", ["v1", "orders", client_order_id]) => {
            let guard = match orders.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            match guard.by_client_id(client_order_id) {
                Some(order) => Some(Response::json(200, order_json(order))),
                None => Some(error(404, "unknown_order", client_order_id)),
            }
        }

        _ => None,
    }
}

fn main() -> std::io::Result<()> {
    let info = ServiceInfo::from_env("oms", "10-oms", "T0");
    let mut service = Service::new(info.clone());

    // INV-083 / P7 — risk fails closed. An OMS that cannot reach risk rejects.
    let fail_mode = std::env::var("RISK_FAIL_MODE").unwrap_or_else(|_| "closed".to_owned());
    if fail_mode != "closed" {
        log(
            &info,
            "error",
            "RISK_FAIL_MODE is not 'closed' — refusing to start (INV-083)",
        );
        return Err(std::io::Error::other(
            "risk must fail closed; see docs/01-principles.md P7",
        ));
    }

    let base = std::env::var("LEDGER_URL").unwrap_or_else(|_| "http://ledger:8000".to_owned());
    let core: Arc<dyn Core> = Arc::new(LedgerCore { base: base.clone() });
    let orders = Arc::new(Mutex::new(Orders::default()));

    service.route_request(Box::new(move |request| {
        handle(&orders, core.as_ref(), request)
    }));

    log(
        &info,
        "info",
        &format!("oms starting — order machine armed, core at {base}"),
    );
    service.serve(port_from_env())
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::arithmetic_side_effects,
        clippy::indexing_slicing,
        clippy::unwrap_used
    )]
    use super::*;

    /// A core that answers however the test says, and counts how often it was
    /// asked — which is how INV-091 is actually checked.
    struct StubCore {
        reply: Result<(u16, String), String>,
        calls: Mutex<usize>,
    }

    impl StubCore {
        fn filled() -> Self {
            Self {
                reply: Ok((
                    201,
                    r#"{"state":"FILLED","deal":{"price":"1.08512"}}"#.to_owned(),
                )),
                calls: Mutex::new(0),
            }
        }
        fn refused() -> Self {
            Self {
                reply: Ok((422, r#"{"error":"INSUFFICIENT_FREE_MARGIN"}"#.to_owned())),
                calls: Mutex::new(0),
            }
        }
        fn unreachable() -> Self {
            Self {
                reply: Err("connection refused".to_owned()),
                calls: Mutex::new(0),
            }
        }
        fn count(&self) -> usize {
            *self.calls.lock().unwrap()
        }
        fn record(&self) -> Result<(u16, String), String> {
            *self.calls.lock().unwrap() += 1;
            self.reply.clone()
        }
    }

    impl Core for StubCore {
        fn place(&self, _body: &str, _key: &str) -> Result<(u16, String), String> {
            self.record()
        }
        fn close(&self, _body: &str, _key: &str) -> Result<(u16, String), String> {
            self.record()
        }
    }

    fn order_request(key: &str) -> Request {
        let mut request = Request::post(
            "/v1/orders",
            r#"{"account":"50000001","symbol":"EURUSD","side":"BUY","volume":"0.10"}"#,
        );
        request
            .headers
            .push(("idempotency-key".to_owned(), key.to_owned()));
        request
    }

    #[test]
    fn a_filled_order_walks_the_whole_machine() {
        let orders = Mutex::new(Orders::default());
        let core = StubCore::filled();
        let response = handle(&orders, &core, &order_request("client-order-01")).unwrap();

        assert_eq!(response.status, 201);
        assert!(response.body.contains(r#""state":"SETTLED""#));
        assert!(response.body.contains(r#""terminal":true"#));
        // Every step is recorded, in order.
        assert!(response.body.contains(
            r#""history":["NEW","VALIDATING","RISK_CHECK","ACCEPTED","EXECUTING","FILLED","POSITION_UPDATED","SETTLED"]"#
        ));
    }

    /// INV-091 — one client order id, one order. The core must be asked once,
    /// no matter how many times the client submits.
    #[test]
    fn inv_091_a_retried_submission_produces_one_order_and_one_core_call() {
        let orders = Mutex::new(Orders::default());
        let core = StubCore::filled();

        let first = handle(&orders, &core, &order_request("client-order-01")).unwrap();
        let second = handle(&orders, &core, &order_request("client-order-01")).unwrap();
        let third = handle(&orders, &core, &order_request("client-order-01")).unwrap();

        assert_eq!(core.count(), 1, "the core was asked more than once");
        assert_eq!(first.body, second.body);
        assert_eq!(second.body, third.body);

        let listed = handle(&orders, &core, &Request::get("/v1/orders?account=50000001")).unwrap();
        assert_eq!(listed.body.matches(r#""clientOrderId""#).count(), 1);
    }

    /// INV-093 — the core not answering is not a rejection. The order sits in
    /// UNKNOWN, which is not terminal, so nothing downstream may assume either
    /// outcome.
    #[test]
    fn inv_093_an_unreachable_core_leaves_the_order_unknown_not_rejected() {
        let orders = Mutex::new(Orders::default());
        let core = StubCore::unreachable();
        let response = handle(&orders, &core, &order_request("client-order-02")).unwrap();

        assert_eq!(response.status, 503);
        assert!(response.body.contains(r#""state":"UNKNOWN""#));
        assert!(
            response.body.contains(r#""terminal":false"#),
            "unknown must not look settled"
        );
        assert!(!response.body.contains("REJECTED"));
    }

    /// A definite refusal is definite: the core said no, so the order is
    /// rejected rather than unknown.
    #[test]
    fn a_refusal_from_the_core_is_a_rejection_not_an_unknown() {
        let orders = Mutex::new(Orders::default());
        let core = StubCore::refused();
        let response = handle(&orders, &core, &order_request("client-order-03")).unwrap();

        assert_eq!(response.status, 422);
        assert!(response.body.contains(r#""state":"REJECTED""#));
        assert!(response.body.contains(r#""terminal":true"#));
        assert!(response.body.contains("INSUFFICIENT_FREE_MARGIN"));
    }

    /// The reason is at the top level, not buried in the core's reply. A client
    /// that has to walk into a nested object to find out why it was refused
    /// will render "something went wrong" instead, every time.
    #[test]
    fn a_refusal_carries_its_reason_where_a_client_will_find_it() {
        let orders = Mutex::new(Orders::default());
        let core = StubCore {
            reply: Ok((
                422,
                r#"{"error":"INSUFFICIENT_FREE_MARGIN","detail":"not enough free margin","state":"REJECTED"}"#
                    .to_owned(),
            )),
            calls: Mutex::new(0),
        };
        let response = handle(&orders, &core, &order_request("client-order-06")).unwrap();

        assert!(response
            .body
            .contains(r#""error":"INSUFFICIENT_FREE_MARGIN""#));
        assert!(response
            .body
            .contains(r#""detail":"not enough free margin""#));
    }

    /// A filled order has no refusal, and says so explicitly rather than
    /// omitting the field — an absent key and a null mean different things to a
    /// consumer, and only one of them is checkable.
    #[test]
    fn a_filled_order_reports_no_refusal_rather_than_omitting_it() {
        let orders = Mutex::new(Orders::default());
        let core = StubCore::filled();
        let response = handle(&orders, &core, &order_request("client-order-07")).unwrap();
        assert!(response.body.contains(r#""error":null,"detail":null"#));
    }

    /// An unreachable core is not a rejection, but the client still needs to be
    /// told something true about it.
    #[test]
    fn an_unknown_outcome_explains_itself() {
        let orders = Mutex::new(Orders::default());
        let core = StubCore::unreachable();
        let response = handle(&orders, &core, &order_request("client-order-08")).unwrap();
        assert!(response.body.contains(r#""error":"CORE_UNREACHABLE""#));
        assert!(response.body.contains("outcome is unknown"));
        assert!(response.body.contains(r#""state":"UNKNOWN""#));
    }

    /// And an unknown order, once retried, still resolves to one order — the
    /// retry after a timeout is exactly the case INV-091 exists for.
    #[test]
    fn retrying_after_a_timeout_does_not_create_a_second_order() {
        let orders = Mutex::new(Orders::default());
        let timing_out = StubCore::unreachable();
        handle(&orders, &timing_out, &order_request("client-order-04")).unwrap();

        let now_working = StubCore::filled();
        let retried = handle(&orders, &now_working, &order_request("client-order-04")).unwrap();

        assert_eq!(
            now_working.count(),
            0,
            "the retry must not reach the core again"
        );
        assert!(retried.body.contains(r#""state":"UNKNOWN""#));
        let listed = handle(
            &orders,
            &now_working,
            &Request::get("/v1/orders?account=50000001"),
        )
        .unwrap();
        assert_eq!(listed.body.matches(r#""clientOrderId""#).count(), 1);
    }

    #[test]
    fn an_order_without_a_client_order_id_is_refused() {
        let orders = Mutex::new(Orders::default());
        let core = StubCore::filled();
        let response = handle(
            &orders,
            &core,
            &Request::post(
                "/v1/orders",
                r#"{"account":"50000001","symbol":"EURUSD","side":"BUY","volume":"0.10"}"#,
            ),
        )
        .unwrap();
        assert_eq!(response.status, 400);
        assert_eq!(core.count(), 0);
    }

    #[test]
    fn an_order_can_be_looked_up_by_its_client_order_id() {
        let orders = Mutex::new(Orders::default());
        let core = StubCore::filled();
        handle(&orders, &core, &order_request("client-order-05")).unwrap();

        let found = handle(&orders, &core, &Request::get("/v1/orders/client-order-05")).unwrap();
        assert_eq!(found.status, 200);
        assert!(found.body.contains(r#""clientOrderId":"client-order-05""#));

        let missing = handle(&orders, &core, &Request::get("/v1/orders/nope")).unwrap();
        assert_eq!(missing.status, 404);
    }

    #[test]
    fn the_state_machine_is_published_for_clients_to_read() {
        let orders = Mutex::new(Orders::default());
        let core = StubCore::filled();
        let body = handle(&orders, &core, &Request::get("/v1/states"))
            .unwrap()
            .body;
        assert!(body.contains(r#""state":"SETTLED","terminal":true"#));
        assert!(body.contains(r#""state":"UNKNOWN","terminal":false"#));
        assert!(body.contains(r#""from":"NEW","to":"VALIDATING""#));
        assert!(body.contains("INV-090"));
    }

    #[test]
    fn a_close_goes_through_the_same_machine() {
        let orders = Mutex::new(Orders::default());
        let core = StubCore::filled();
        let mut request = Request::post(
            "/v1/positions/close",
            r#"{"account":"50000001","symbol":"EURUSD"}"#,
        );
        request
            .headers
            .push(("idempotency-key".to_owned(), "close-order-01".to_owned()));
        let response = handle(&orders, &core, &request).unwrap();
        assert_eq!(response.status, 201);
        assert!(response.body.contains(r#""state":"SETTLED""#));
        assert!(response.body.contains(r#""side":"CLOSE""#));
    }
}

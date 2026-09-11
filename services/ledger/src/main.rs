//! # 03-ledger — the financial source of truth
//!
//! Every movement of value is a balanced double-entry transaction here, and
//! balances are projections over the journal, never columns.
//!
//! This process also hosts `04-account`, `05-position`, `08-pnl-margin`,
//! `09-risk` and `11-execution` as libraries. That is not scope creep: a trade
//! is one transaction — value the account, check it against risk, book the
//! fill, post the entries — and splitting one transaction across four network
//! boundaries buys nothing and costs atomicity. They are extracted when there
//! is a measured reason, and not before (docs/01-principles.md).
//!
//! Time enters in exactly one place, [`now_tick`], for the same reason it does
//! in `06-market-data`: everything else is a pure function of the tick.

mod quotes;
mod state;
mod volume;

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use domain_kernel::quantity::Side;
use market_core::instrument::find;
use market_core::tick_of;
use quotes::{QuoteSet, QuoteSource, RemoteSource};
use service_kit::json::{escape, Value};
use service_kit::{log, port_from_env, Request, Response, Service, ServiceInfo};
use state::{Core, CoreError, CreditRecord, OrderRecord};

/// The current feed tick. The only clock read in this service.
fn now_tick() -> u64 {
    // ALLOW-BANNED: the boundary between the world's clock and the tick index.
    // The core state machine in `state.rs` takes the tick as an argument and
    // reads no clock at all, which is what makes replay exact (INV-104).
    let millis = SystemTime::now() // ALLOW-BANNED
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    tick_of(u64::try_from(millis).unwrap_or(0))
}

fn error(err: &CoreError) -> Response {
    Response::json(
        err.status(),
        format!(
            r#"{{"error":"{}","detail":"{}"}}"#,
            escape(err.code()),
            escape(&err.to_string())
        ),
    )
}

fn bad_request(detail: &str) -> Response {
    error(&CoreError::BadRequest(detail.to_owned()))
}

/// The body, parsed, or a 400 that says why.
fn body_of(request: &Request) -> Result<Value, Response> {
    request
        .json()
        .map_err(|err| bad_request(&format!("body is not valid JSON: {err}")))
}

fn string_field(body: &Value, name: &str) -> Result<String, Response> {
    body.str_field(name)
        .map(str::to_owned)
        .ok_or_else(|| bad_request(&format!("\"{name}\" is required and must be a string")))
}

/* ------------------------------------------------------------ rendering */

fn account_json(account: &account_core::TradingAccount) -> String {
    format!(
        r#"{{"accountNumber":"{}","owner":"{}","nickname":"{}","mode":"{}","currency":"{}","leverage":{},"status":"{}","openedTick":{},"openedMs":{}}}"#,
        escape(&account.number),
        escape(&account.owner),
        escape(&account.nickname),
        escape(account.mode.name()),
        escape(account.currency),
        account.leverage,
        escape(account.status.name()),
        account.opened_tick,
        market_core::epoch_ms_of(account.opened_tick),
    )
}

/// Basis points rendered as a percentage string, e.g. `10000` -> `"100.00"`.
///
/// Integer arithmetic: the value is already scaled by 100, so this is a split,
/// not a division into a float.
fn percent(bp: i128) -> String {
    let whole = bp.checked_div(100).unwrap_or(0);
    let frac = bp.checked_rem(100).unwrap_or(0).abs();
    format!("{whole}.{frac:02}")
}

fn valuation_json(valuation: &pnl_margin::Valuation) -> String {
    let positions = valuation
        .positions
        .iter()
        .map(|valued| {
            let instrument = find(&valued.position.symbol);
            let digits = instrument.map_or(5, |i| i.digits);
            let format_price = |raw: i128| {
                instrument.map_or_else(|| raw.to_string(), |i| i.format_price(raw))
            };
            let volume = instrument.map_or_else(
                || "0.000".to_owned(),
                |i| volume::to_lots_text(valued.position.quantity, i),
            );
            format!(
                r#"{{"symbol":"{}","side":"{}","volume":"{}","digits":{},"openPrice":"{}","mark":"{}","unrealised":"{}","margin":"{}","openedTick":{},"openedMs":{}}}"#,
                escape(&valued.position.symbol),
                if valued.position.side == Side::Buy { "BUY" } else { "SELL" },
                escape(&volume),
                digits,
                escape(&format_price(valued.position.average_price.raw())),
                escape(&format_price(valued.mark.raw())),
                escape(&valued.unrealised.to_decimal_string()),
                escape(&valued.margin.to_decimal_string()),
                valued.position.opened_tick,
                market_core::epoch_ms_of(valued.position.opened_tick),
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    format!(
        r#"{{"balance":"{}","equity":"{}","unrealised":"{}","usedMargin":"{}","freeMargin":"{}","marginLevel":{},"policyVersion":"{}","positions":[{positions}]}}"#,
        escape(&valuation.balance.to_decimal_string()),
        escape(&valuation.equity.to_decimal_string()),
        escape(&valuation.unrealised.to_decimal_string()),
        escape(&valuation.used_margin.to_decimal_string()),
        escape(&valuation.free_margin.to_decimal_string()),
        // INV-072 / INV-183 — absent is `null`, never a substituted zero and
        // never a large number that reads as "safe".
        valuation
            .margin_level_bp
            .map_or_else(|| "null".to_owned(), |bp| format!("\"{}\"", percent(bp))),
        escape(valuation.policy_version),
    )
}

fn order_json(record: &OrderRecord) -> String {
    let instrument = find(&record.symbol);
    let volume = format!(
        "{}.{:03}",
        record.milli_lots.checked_div(1_000).unwrap_or(0),
        record.milli_lots.checked_rem(1_000).unwrap_or(0).abs()
    );
    let deal = record.deal.as_ref().map_or_else(
        || "null".to_owned(),
        |deal| {
            let price = instrument.map_or_else(
                || deal.price.raw().to_string(),
                |i| i.format_price(deal.price.raw()),
            );
            format!(
                r#"{{"dealId":"{}","price":"{}","commission":"{}","realised":"{}","closedVolume":"{}","reversed":{},"transactionId":"{}"}}"#,
                deal.ids.deal_id,
                escape(&price),
                escape(&deal.commission.to_decimal_string()),
                escape(&deal.realised.to_decimal_string()),
                escape(&instrument.map_or_else(
                    || "0.000".to_owned(),
                    |i| volume::to_lots_text(deal.closed_quantity, i)
                )),
                deal.reversed,
                deal.ids.transaction_id,
            )
        },
    );
    let rejection = record.rejection.map_or_else(
        || "null".to_owned(),
        |reason| {
            format!(
                r#"{{"code":"{}","detail":"{}"}}"#,
                escape(reason.code()),
                escape(&reason.to_string())
            )
        },
    );
    format!(
        r#"{{"orderId":"{}","state":"{}","account":"{}","symbol":"{}","side":"{}","volume":"{}","tick":{},"timestampMs":{},"deal":{deal},"rejection":{rejection}}}"#,
        record.order_id,
        escape(record.state()),
        escape(&record.account),
        escape(&record.symbol),
        if record.side == Side::Buy {
            "BUY"
        } else {
            "SELL"
        },
        escape(&volume),
        record.tick,
        market_core::epoch_ms_of(record.tick),
    )
}

fn transaction_json(transaction: &ledger_core::Transaction) -> String {
    let entries = transaction
        .entries()
        .iter()
        .map(|entry| {
            format!(
                r#"{{"account":"{}","amount":"{}","currency":"{}"}}"#,
                escape(entry.account.as_str()),
                escape(
                    &domain_kernel::Money::<domain_kernel::Usd>::from_minor(entry.amount.minor)
                        .to_decimal_string()
                ),
                escape(entry.amount.currency)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    // `sequence` is the id's ordinal, for paging; `transactionId` is its
    // rendered form, for display and cross-reference.
    format!(
        r#"{{"transactionId":"{}","sequence":{},"kind":"{}","subject":{},"entries":[{entries}]}}"#,
        transaction.id(),
        transaction.id().0,
        escape(transaction.kind().name()),
        transaction
            .subject()
            .map_or_else(|| "null".to_owned(), |s| format!("\"{}\"", escape(s)))
    )
}

fn credit_json(core: &Core, credit: &CreditRecord, replayed: bool) -> String {
    let balance = core.balance_of(&credit.account).map_or_else(
        || "null".to_owned(),
        |b| format!("\"{}\"", b.to_decimal_string()),
    );
    format!(
        r#"{{"account":"{}","replayed":{replayed},"balance":{balance},"transaction":{}}}"#,
        escape(&credit.account),
        credit
            .transaction
            .as_ref()
            .map_or_else(|| "null".to_owned(), transaction_json)
    )
}

/// A required idempotency key, from the header or the body.
fn idempotency_key(request: &Request, body: &Value) -> Result<String, Response> {
    match request
        .header("idempotency-key")
        .map(str::to_owned)
        .or_else(|| body.str_field("clientKey").map(str::to_owned))
    {
        Some(key) if key.len() >= 8 => Ok(key),
        _ => Err(bad_request(
            "an Idempotency-Key header of at least 8 characters is required; \
             retries must be safe because financial effects are not repeatable",
        )),
    }
}

/// A decimal amount in minor units, or a 400.
fn amount_minor(body: &Value) -> Result<i128, Response> {
    let text = string_field(body, "amount")?;
    domain_kernel::Money::<domain_kernel::Usd>::from_decimal_str(&text)
        .map(domain_kernel::Money::minor)
        .map_err(|err| bad_request(&format!("\"amount\" is not a valid decimal: {err}")))
}

/* -------------------------------------------------------------- routing */

/// Which requests need market state. Fetched before the lock is taken, so a
/// slow feed never holds the ledger, and only where a price is acted on.
fn needs_quotes(request: &Request, segments: &[&str]) -> bool {
    matches!(
        (request.method.as_str(), segments),
        ("GET", ["v1", "accounts", _, "state"])
            | ("POST", ["v1", "orders"])
            | ("POST", ["v1", "positions", "close"])
            | ("GET", ["v1", "quote"])
    )
}

#[allow(clippy::too_many_lines)]
fn handle(
    core: &Mutex<Core>,
    source: &dyn QuoteSource,
    request: &Request,
    tick: u64,
) -> Option<Response> {
    let segments = request.segments();
    // Market state for this tick, from `06-market-data`. No state, no fill
    // and no valuation: the answer is 503 with the reason, never a guess (P7).
    let quotes = if needs_quotes(request, &segments) {
        match source.quotes_at(tick) {
            Ok(quotes) => quotes,
            Err(detail) => return Some(error(&CoreError::Unavailable(detail))),
        }
    } else {
        QuoteSet::empty()
    };
    // A poisoned lock means a previous request panicked mid-transaction. The
    // state is still consistent — every mutation here is either complete or not
    // begun — so recovering is better than refusing every request thereafter.
    let mut core = match core.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    match (request.method.as_str(), segments.as_slice()) {
        ("GET", ["v1", "invariants"]) => {
            let imbalances = core.imbalanced_transactions();
            let drift = core.projection_drift();
            let healthy = imbalances == 0 && drift == 0;
            Some(Response::json(
                if healthy { 200 } else { 503 },
                format!(
                    r#"{{"INV-020_imbalanced_transactions":{imbalances},"INV-023_projection_drift":{drift},"version":{},"healthy":{healthy}}}"#,
                    core.version()
                ),
            ))
        }

        ("POST", ["v1", "accounts"]) => {
            let body = match body_of(request) {
                Ok(body) => body,
                Err(response) => return Some(response),
            };
            let owner = match string_field(&body, "owner") {
                Ok(owner) => owner,
                Err(response) => return Some(response),
            };
            let nickname = body.str_field("nickname").unwrap_or("Demo account");
            let leverage = body
                .get("leverage")
                .and_then(Value::as_i64)
                .map_or(500, i128::from);
            let mode = match body.str_field("mode").unwrap_or("demo") {
                "demo" => account_core::Mode::Demo,
                "real" => account_core::Mode::Real,
                _ => return Some(bad_request("\"mode\" must be \"demo\" or \"real\"")),
            };

            match core.open_account(&owner, nickname, leverage, mode, tick) {
                Ok(account) => Some(Response::json(201, account_json(&account))),
                Err(err) => Some(error(&err)),
            }
        }

        ("GET", ["v1", "accounts"]) => {
            // Without an owner this is the operator's view: every account.
            // The ledger sits behind the client API, which decides who may
            // ask that; here the answer is simply complete.
            let owner = request.param("owner");
            let mode = request.param("mode");
            let status = request.param("status");
            let list = core
                .all_accounts()
                .iter()
                .filter(|a| owner.is_none_or(|o| a.owner == o))
                .filter(|a| mode.is_none_or(|m| a.mode.name() == m))
                .filter(|a| status.is_none_or(|s| a.status.name() == s))
                .map(account_json)
                .collect::<Vec<_>>()
                .join(",");
            Some(Response::json(200, format!(r#"{{"accounts":[{list}]}}"#)))
        }

        ("POST", ["v1", "accounts", number, "status"]) => {
            let body = match body_of(request) {
                Ok(body) => body,
                Err(response) => return Some(response),
            };
            let Some(status) = body
                .str_field("status")
                .and_then(account_core::Status::parse)
            else {
                return Some(bad_request(
                    "\"status\" must be \"active\", \"frozen\" or \"closed\"",
                ));
            };
            match core.set_account_status(number, status) {
                Ok(account) => Some(Response::json(200, account_json(&account))),
                Err(err) => Some(error(&err)),
            }
        }

        ("POST", ["v1", "accounts", number, "demo-credit"]) => {
            let body = match body_of(request) {
                Ok(body) => body,
                Err(response) => return Some(response),
            };
            let key = match idempotency_key(request, &body) {
                Ok(key) => key,
                Err(response) => return Some(response),
            };
            let amount = match amount_minor(&body) {
                Ok(amount) => amount,
                Err(response) => return Some(response),
            };
            let replayed = core.credit_by_key(number, &key).is_some();
            match core.credit_demo(number, amount, &key) {
                Ok(credit) => Some(Response::json(
                    if replayed { 200 } else { 201 },
                    credit_json(&core, &credit, replayed),
                )),
                Err(err) => Some(error(&err)),
            }
        }

        ("POST", ["v1", "accounts", number, "demo-reset"]) => {
            let body = match body_of(request) {
                Ok(body) => body,
                Err(response) => return Some(response),
            };
            let key = match idempotency_key(request, &body) {
                Ok(key) => key,
                Err(response) => return Some(response),
            };
            let replayed = core.credit_by_key(number, &key).is_some();
            match core.reset_demo_account(number, &key) {
                Ok(credit) => Some(Response::json(
                    if replayed { 200 } else { 201 },
                    credit_json(&core, &credit, replayed),
                )),
                Err(err) => Some(error(&err)),
            }
        }

        ("GET", ["v1", "journal"]) => {
            // The whole ledger, oldest first, paged by transaction id so a
            // reader can walk it without ever seeing a row twice.
            let after = request
                .param("after")
                .and_then(|v| v.parse::<u128>().ok())
                .unwrap_or(0);
            let limit = request
                .param("limit")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(100)
                .clamp(1, 1_000);
            let kind = request.param("kind");
            let subject = request.param("subject");
            let rows: Vec<String> = core
                .journal()
                .transactions()
                .iter()
                .filter(|t| t.id().0 > after)
                .filter(|t| kind.is_none_or(|k| t.kind().name() == k))
                .filter(|t| subject.is_none_or(|s| t.subject() == Some(s)))
                .take(limit)
                .map(transaction_json)
                .collect();
            Some(Response::json(
                200,
                format!(
                    r#"{{"total":{},"transactions":[{}]}}"#,
                    core.version(),
                    rows.join(",")
                ),
            ))
        }

        ("GET", ["v1", "balances"]) => {
            // The trial balance: every ledger account with a signed balance.
            // Positive is a debit balance, negative a credit balance, and the
            // sum over a currency is zero or the ledger is broken (INV-020).
            let rows: Vec<String> = core
                .trial_balance()
                .into_iter()
                .map(|(account, currency, minor)| {
                    format!(
                        r#"{{"account":"{}","currency":"{}","signedMinor":{minor},"signed":"{}"}}"#,
                        escape(account),
                        escape(currency),
                        domain_kernel::Money::<domain_kernel::Usd>::from_minor(minor)
                            .to_decimal_string()
                    )
                })
                .collect();
            Some(Response::json(
                200,
                format!(
                    r#"{{"balanced":{},"version":{},"balances":[{}]}}"#,
                    core.imbalanced_transactions() == 0,
                    core.version(),
                    rows.join(",")
                ),
            ))
        }

        ("GET", ["v1", "orders"]) => {
            let limit = request
                .param("limit")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(200)
                .clamp(1, 2_000);
            let list = core
                .all_orders()
                .into_iter()
                .take(limit)
                .map(order_json)
                .collect::<Vec<_>>()
                .join(",");
            Some(Response::json(200, format!(r#"{{"orders":[{list}]}}"#)))
        }

        ("GET", ["v1", "accounts", number]) => match core.account(number) {
            Some(account) => Some(Response::json(200, account_json(account))),
            None => Some(error(&CoreError::UnknownAccount((*number).to_owned()))),
        },

        ("GET", ["v1", "accounts", number, "state"]) => match core.valuation(number, &quotes) {
            Ok(valuation) => Some(Response::json(
                200,
                format!(
                    r#"{{"accountNumber":"{}","tick":{tick},"version":{},"valuation":{}}}"#,
                    escape(number),
                    core.version(),
                    valuation_json(&valuation)
                ),
            )),
            Err(err) => Some(error(&err)),
        },

        ("GET", ["v1", "accounts", number, "orders"]) => {
            let list = core
                .orders_of(number)
                .into_iter()
                .map(order_json)
                .collect::<Vec<_>>()
                .join(",");
            Some(Response::json(200, format!(r#"{{"orders":[{list}]}}"#)))
        }

        ("GET", ["v1", "accounts", number, "statement"]) => {
            let list = core
                .statement(number)
                .into_iter()
                .map(transaction_json)
                .collect::<Vec<_>>()
                .join(",");
            Some(Response::json(
                200,
                format!(r#"{{"transactions":[{list}]}}"#),
            ))
        }

        ("POST", ["v1", "orders"]) => {
            let body = match body_of(request) {
                Ok(body) => body,
                Err(response) => return Some(response),
            };
            let (account, symbol, side_text, volume_text) = match (
                string_field(&body, "account"),
                string_field(&body, "symbol"),
                string_field(&body, "side"),
                string_field(&body, "volume"),
            ) {
                (Ok(a), Ok(s), Ok(d), Ok(v)) => (a, s, d, v),
                (Err(response), ..) | (_, Err(response), ..) => return Some(response),
                (.., Err(response), _) | (.., Err(response)) => return Some(response),
            };
            let side = match side_text.as_str() {
                "BUY" => Side::Buy,
                "SELL" => Side::Sell,
                _ => return Some(bad_request("\"side\" must be \"BUY\" or \"SELL\"")),
            };
            let milli_lots = match volume::milli_lots(&volume_text) {
                Ok(value) => value,
                Err(err) => return Some(bad_request(&err.to_string())),
            };
            // INV-181 — the key is the client's, and it is required. Without one
            // a retried submission is indistinguishable from a second order.
            let key = match request
                .header("idempotency-key")
                .map(str::to_owned)
                .or_else(|| body.str_field("clientKey").map(str::to_owned))
            {
                Some(key) if key.len() >= 8 => key,
                _ => {
                    return Some(bad_request(
                        "an Idempotency-Key header of at least 8 characters is required; \
                         retries must be safe because financial effects are not repeatable",
                    ))
                }
            };

            match core.place_order(&account, &symbol, side, milli_lots, tick, &quotes, &key) {
                Ok(record) => Some(Response::json(201, order_json(&record))),
                Err(CoreError::Refused(reason)) => {
                    // A refusal is a recorded decision, and the client gets the
                    // reason rather than a bare failure.
                    Some(Response::json(
                        422,
                        format!(
                            r#"{{"error":"{}","detail":"{}","state":"REJECTED"}}"#,
                            escape(reason.code()),
                            escape(&reason.to_string())
                        ),
                    ))
                }
                Err(err) => Some(error(&err)),
            }
        }

        ("POST", ["v1", "positions", "close"]) => {
            let body = match body_of(request) {
                Ok(body) => body,
                Err(response) => return Some(response),
            };
            let (account, symbol) = match (
                string_field(&body, "account"),
                string_field(&body, "symbol"),
            ) {
                (Ok(a), Ok(s)) => (a, s),
                (Err(response), _) | (_, Err(response)) => return Some(response),
            };
            let key = match request
                .header("idempotency-key")
                .map(str::to_owned)
                .or_else(|| body.str_field("clientKey").map(str::to_owned))
            {
                Some(key) if key.len() >= 8 => key,
                _ => return Some(bad_request("an Idempotency-Key header is required")),
            };

            match core.close_position(&account, &symbol, tick, &quotes, &key) {
                Ok(record) => Some(Response::json(201, order_json(&record))),
                Err(CoreError::Refused(reason)) => Some(Response::json(
                    422,
                    format!(
                        r#"{{"error":"{}","detail":"{}","state":"REJECTED"}}"#,
                        escape(reason.code()),
                        escape(&reason.to_string())
                    ),
                )),
                Err(err) => Some(error(&err)),
            }
        }

        ("GET", ["v1", "quote"]) => {
            // Served so a caller can see the exact price this process would
            // fill at, from the same state it fills on (INV-052).
            let symbol = request.param("symbol").unwrap_or_default();
            let Some(instrument) = find(symbol) else {
                return Some(error(&CoreError::UnknownInstrument(symbol.to_owned())));
            };
            match quotes.get(symbol) {
                Some(quote) => Some(Response::json(
                    200,
                    format!(
                        r#"{{"symbol":"{}","bid":"{}","ask":"{}","mid":"{}","tick":{},"sessionOpen":{},"ageMs":{}}}"#,
                        escape(instrument.symbol),
                        escape(&instrument.format_price(quote.bid().raw())),
                        escape(&instrument.format_price(quote.ask().raw())),
                        escape(&instrument.format_price(quote.mid().raw())),
                        quote.tick(),
                        quote.session_open(),
                        quote.age_ms(tick),
                    ),
                )),
                None => Some(error(&CoreError::Unavailable(format!(
                    "no market state for {symbol}"
                )))),
            }
        }

        _ => None,
    }
}

fn main() -> std::io::Result<()> {
    let info = ServiceInfo::from_env("ledger", "03-ledger", "T0");
    let mut service = Service::new(info.clone());
    let metrics = service.metrics();

    // Invariant monitors. Registered at startup rather than on first violation:
    // a missing series is indistinguishable from a healthy zero otherwise.
    for monitor in [
        "projectx_ledger_imbalanced_transactions",
        "projectx_ledger_projection_drift_total",
        "projectx_duplicate_financial_effect_total",
        "projectx_replay_divergence_total",
    ] {
        metrics
            .counter(monitor)
            .store(0, std::sync::atomic::Ordering::Relaxed);
    }

    let path = std::env::var("LEDGER_JOURNAL_PATH")
        .unwrap_or_else(|_| "/var/lib/projectx/journal.log".to_owned());
    let core = match Core::open(std::path::Path::new(&path)) {
        Ok(core) => core,
        Err(detail) => {
            // A core that cannot prove what it holds must not serve. Starting
            // empty on top of an unreadable journal is how a ledger silently
            // loses a day.
            log(
                &info,
                "error",
                &format!("cannot open journal at {path}: {detail}"),
            );
            return Err(std::io::Error::other(detail));
        }
    };
    log(
        &info,
        "info",
        &format!(
            "journal replayed from {path}: {} transactions, projection {}",
            core.version(),
            if core.projection_drift() == 0 {
                "clean"
            } else {
                "DRIFTED"
            }
        ),
    );

    let core = Arc::new(Mutex::new(core));
    let routed = Arc::clone(&core);
    // Market state comes from 06-market-data, never from a function here.
    let source: Arc<dyn QuoteSource> = Arc::new(RemoteSource::new(
        std::env::var("MARKET_DATA_URL").unwrap_or_else(|_| "http://market-data:8000".to_owned()),
    ));
    service.route_request(Box::new(move |request| {
        handle(&routed, source.as_ref(), request, now_tick())
    }));

    log(
        &info,
        "info",
        "ledger starting — INV-020, INV-023 monitors armed",
    );
    service.serve(port_from_env())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use account_core::Mode;

    /// A core with one funded demo account, at a fixed tick.
    fn funded() -> (Mutex<Core>, String) {
        let mut core = Core::in_memory();
        let account = core
            .open_account("dev-owner-0001", "Demo", 500, Mode::Demo, 1_526_000)
            .unwrap();
        (Mutex::new(core), account.number)
    }

    fn post(core: &Mutex<Core>, path: &str, body: &str, tick: u64) -> Response {
        let mut request = Request::post(path, body);
        request
            .headers
            .push(("idempotency-key".to_owned(), "test-key-00000001".to_owned()));
        handle(core, &quotes::SyntheticSource, &request, tick).unwrap()
    }

    fn get(core: &Mutex<Core>, path: &str, tick: u64) -> Response {
        handle(core, &quotes::SyntheticSource, &Request::get(path), tick).unwrap()
    }

    #[test]
    fn a_demo_account_opens_funded_and_flat() {
        let (core, number) = funded();
        let state = get(&core, &format!("/v1/accounts/{number}/state"), 1_526_000);
        assert_eq!(state.status, 200);
        assert!(state.body.contains(r#""balance":"10000.00""#));
        assert!(state.body.contains(r#""equity":"10000.00""#));
        assert!(state.body.contains(r#""usedMargin":"0.00""#));
        // INV-072 — no positions, so no margin level, expressed as null.
        assert!(state.body.contains(r#""marginLevel":null"#));
        assert!(state.body.contains(r#""positions":[]"#));
    }

    #[test]
    fn a_market_order_fills_and_appears_as_a_position() {
        let (core, number) = funded();
        let response = post(
            &core,
            "/v1/orders",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":"0.10"}}"#),
            1_526_000,
        );
        assert_eq!(response.status, 201);
        assert!(response.body.contains(r#""state":"FILLED""#));
        assert!(response.body.contains(r#""commission":"0.35""#));

        let state = get(&core, &format!("/v1/accounts/{number}/state"), 1_526_000);
        assert!(state.body.contains(r#""symbol":"EURUSD""#));
        assert!(state.body.contains(r#""side":"BUY""#));
        assert!(state.body.contains(r#""volume":"0.100""#));
        // Something is now open, so a margin level exists.
        assert!(!state.body.contains(r#""marginLevel":null"#));
    }

    /// INV-181 / INV-102 — the same key twice is one order, not two.
    #[test]
    fn a_retried_order_is_the_same_order() {
        let (core, number) = funded();
        let body =
            format!(r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":"0.10"}}"#);
        let first = post(&core, "/v1/orders", &body, 1_526_000);
        let second = post(&core, "/v1/orders", &body, 1_526_050);

        assert_eq!(first.body, second.body, "a retry must replay, not re-place");
        let orders = get(&core, &format!("/v1/accounts/{number}/orders"), 1_526_000);
        assert_eq!(orders.body.matches(r#""orderId""#).count(), 1);
    }

    #[test]
    fn an_order_without_an_idempotency_key_is_refused() {
        let (core, number) = funded();
        let response = handle(
            &core,
            &quotes::SyntheticSource,
            &Request::post(
                "/v1/orders",
                &format!(
                    r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":"0.10"}}"#
                ),
            ),
            1_526_000,
        )
        .unwrap();
        assert_eq!(response.status, 400);
        assert!(response.body.contains("Idempotency-Key"));
    }

    /// A round trip: open, close, and the ledger reflects exactly the profit or
    /// loss plus both commissions — no more, no less.
    #[test]
    fn opening_and_closing_leaves_the_ledger_balanced_and_the_book_flat() {
        let (core, number) = funded();
        post(
            &core,
            "/v1/orders",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":"1.00"}}"#),
            1_526_000,
        );

        let mut close = Request::post(
            "/v1/positions/close",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD"}}"#),
        );
        close
            .headers
            .push(("idempotency-key".to_owned(), "close-key-0001".to_owned()));
        let closed = handle(&core, &quotes::SyntheticSource, &close, 1_526_400).unwrap();
        assert_eq!(closed.status, 201);
        assert!(closed.body.contains(r#""side":"SELL""#));
        assert!(closed.body.contains(r#""closedVolume":"1.000""#));

        let state = get(&core, &format!("/v1/accounts/{number}/state"), 1_526_400);
        assert!(state.body.contains(r#""positions":[]"#), "INV-043");
        assert!(state.body.contains(r#""usedMargin":"0.00""#));

        // The book still balances after everything.
        let invariants = get(&core, "/v1/invariants", 1_526_400);
        assert_eq!(invariants.status, 200);
        assert!(invariants.body.contains(r#""healthy":true"#));
    }

    #[test]
    fn closing_nothing_says_so_rather_than_placing_an_order() {
        let (core, number) = funded();
        let mut close = Request::post(
            "/v1/positions/close",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD"}}"#),
        );
        close
            .headers
            .push(("idempotency-key".to_owned(), "close-key-0001".to_owned()));
        let response = handle(&core, &quotes::SyntheticSource, &close, 1_526_000).unwrap();
        assert_eq!(response.status, 422);
        assert!(response.body.contains("NOTHING_TO_CLOSE"));
    }

    /// An order too large for the account is refused with the *right* reason —
    /// the checks fire in their documented order, so a client fixing one
    /// problem meets the next rather than a different one each time.
    #[test]
    fn an_order_beyond_the_accounts_means_is_refused_with_the_right_reason() {
        let (core, number) = funded();

        // 500 lots trips the venue's size limit first, before the account is
        // even valued.
        let oversized = post(
            &core,
            "/v1/orders",
            &format!(
                r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":"500.00"}}"#
            ),
            1_526_000,
        );
        assert_eq!(oversized.status, 422);
        assert!(oversized.body.contains("VOLUME_ABOVE_MAXIMUM"));

        // 49 lots is within the size limit but needs about 10 633.00 of margin,
        // which a 10 000.00 account does not have.
        let mut request = Request::post(
            "/v1/orders",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":"49.00"}}"#),
        );
        request
            .headers
            .push(("idempotency-key".to_owned(), "too-big-00000001".to_owned()));
        let response = handle(&core, &quotes::SyntheticSource, &request, 1_526_000).unwrap();
        assert_eq!(response.status, 422);
        assert!(
            response.body.contains("INSUFFICIENT_FREE_MARGIN"),
            "got {}",
            response.body
        );
        assert!(response.body.contains(r#""state":"REJECTED""#));

        // Nothing was booked by either attempt.
        let state = get(&core, &format!("/v1/accounts/{number}/state"), 1_526_000);
        assert!(state.body.contains(r#""positions":[]"#));
        assert!(state.body.contains(r#""balance":"10000.00""#));
    }

    #[test]
    fn malformed_orders_are_refused_before_anything_is_valued() {
        let (core, number) = funded();
        for (body, expected) in [
            (
                r#"{"symbol":"EURUSD","side":"BUY","volume":"0.10"}"#,
                "account",
            ),
            (
                r#"{"account":"X","symbol":"EURUSD","side":"HOLD","volume":"0.10"}"#,
                "side",
            ),
            (
                r#"{"account":"X","symbol":"EURUSD","side":"BUY","volume":"0.0001"}"#,
                "decimal places",
            ),
            (
                r#"{"account":"X","symbol":"EURUSD","side":"BUY","volume":"lots"}"#,
                "decimal string",
            ),
        ] {
            let response = post(&core, "/v1/orders", body, 1_526_000);
            assert_eq!(response.status, 400, "{body}");
            assert!(
                response.body.contains(expected),
                "{body} -> {}",
                response.body
            );
        }
        // And a volume sent as a JSON number is not a volume.
        let numeric = post(
            &core,
            "/v1/orders",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":0.10}}"#),
            1_526_000,
        );
        assert_eq!(numeric.status, 400);
    }

    #[test]
    fn an_unknown_account_or_instrument_is_a_404() {
        let (core, number) = funded();
        let unknown_account = post(
            &core,
            "/v1/orders",
            r#"{"account":"99999999","symbol":"EURUSD","side":"BUY","volume":"0.10"}"#,
            1_526_000,
        );
        assert_eq!(unknown_account.status, 404);

        let unknown_symbol = post(
            &core,
            "/v1/orders",
            &format!(r#"{{"account":"{number}","symbol":"NOTREAL","side":"BUY","volume":"0.10"}}"#),
            1_526_000,
        );
        assert_eq!(unknown_symbol.status, 404);
    }

    #[test]
    fn the_statement_shows_the_funding_and_every_deal() {
        let (core, number) = funded();
        post(
            &core,
            "/v1/orders",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":"0.10"}}"#),
            1_526_000,
        );
        let statement = get(
            &core,
            &format!("/v1/accounts/{number}/statement"),
            1_526_000,
        );
        assert!(statement.body.contains("DEMO_CREDIT"));
        assert!(statement.body.contains("REALISED_PNL"));
        assert!(statement.body.contains("liability:client:"));
    }

    #[test]
    fn percentages_render_without_touching_a_float() {
        assert_eq!(percent(10_000), "100.00");
        assert_eq!(percent(462_962), "4629.62");
        assert_eq!(percent(5), "0.05");
        assert_eq!(percent(0), "0.00");
    }

    #[test]
    fn an_unrouted_path_falls_through() {
        let (core, _) = funded();
        assert!(handle(
            &core,
            &quotes::SyntheticSource,
            &Request::get("/v1/nope"),
            1
        )
        .is_none());
        assert!(handle(
            &core,
            &quotes::SyntheticSource,
            &Request::post("/v1/accounts/1", ""),
            1
        )
        .is_none());
    }

    fn post_keyed(core: &Mutex<Core>, path: &str, body: &str, key: &str, tick: u64) -> Response {
        let mut request = Request::post(path, body);
        request
            .headers
            .push(("idempotency-key".to_owned(), key.to_owned()));
        handle(core, &quotes::SyntheticSource, &request, tick).unwrap()
    }

    /// INV-033 — a real account opens through the same door as a demo one,
    /// with nothing in it and nothing posted, and is listed by mode.
    #[test]
    fn inv_033_a_real_account_opens_unfunded_through_the_same_endpoint() {
        let core = Mutex::new(Core::in_memory());
        let opened = post(
            &core,
            "/v1/accounts",
            r#"{"owner":"o1","nickname":"Real","leverage":100,"mode":"real"}"#,
            1_526_000,
        );
        assert_eq!(opened.status, 201);
        assert!(opened.body.contains(r#""mode":"real""#));
        let number = opened
            .body
            .split(r#""accountNumber":""#)
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_owned();

        let state = get(&core, &format!("/v1/accounts/{number}/state"), 1_526_000);
        assert!(state.body.contains(r#""balance":"0.00""#));
        assert_eq!(core.lock().unwrap().version(), 0, "nothing was posted");

        let real_only = get(&core, "/v1/accounts?owner=o1&mode=real", 1);
        assert!(real_only.body.contains(&number));
        let demo_only = get(&core, "/v1/accounts?owner=o1&mode=demo", 1);
        assert!(!demo_only.body.contains(&number));

        let bad = post(&core, "/v1/accounts", r#"{"owner":"o1","mode":"paper"}"#, 1);
        assert_eq!(bad.status, 400);

        // A real account has no margin, so an order is refused, not filled.
        let order = post(
            &core,
            "/v1/orders",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":"0.10"}}"#),
            1_526_000,
        );
        assert_eq!(order.status, 422);
    }

    /// INV-034 — a demo credit posts once per key, is refused on a real
    /// account, and never takes the account past the cap.
    #[test]
    fn inv_034_demo_credits_are_idempotent_bounded_and_demo_only() {
        let (core, number) = funded();
        let first = post_keyed(
            &core,
            &format!("/v1/accounts/{number}/demo-credit"),
            r#"{"amount":"2500.00"}"#,
            "credit-key-0001",
            1_526_000,
        );
        assert_eq!(first.status, 201, "{}", first.body);
        assert!(first.body.contains(r#""balance":"12500.00""#));
        assert!(first.body.contains(r#""replayed":false"#));

        let again = post_keyed(
            &core,
            &format!("/v1/accounts/{number}/demo-credit"),
            r#"{"amount":"2500.00"}"#,
            "credit-key-0001",
            1_526_001,
        );
        assert_eq!(again.status, 200);
        assert!(again.body.contains(r#""replayed":true"#));
        assert!(
            again.body.contains(r#""balance":"12500.00""#),
            "a retry posts nothing"
        );

        let too_much = post_keyed(
            &core,
            &format!("/v1/accounts/{number}/demo-credit"),
            r#"{"amount":"999999.00"}"#,
            "credit-key-0002",
            1_526_002,
        );
        assert_eq!(too_much.status, 422);
        assert!(too_much.body.contains("DEMO_CAP_EXCEEDED"));

        let real = post(
            &core,
            "/v1/accounts",
            r#"{"owner":"o2","nickname":"Real","leverage":100,"mode":"real"}"#,
            1,
        );
        let real_number = real
            .body
            .split(r#""accountNumber":""#)
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_owned();
        let refused = post_keyed(
            &core,
            &format!("/v1/accounts/{real_number}/demo-credit"),
            r#"{"amount":"10.00"}"#,
            "credit-key-0003",
            1,
        );
        assert_eq!(refused.status, 422);
        assert!(refused.body.contains("WRONG_MODE"));

        let unkeyed = handle(
            &core,
            &quotes::SyntheticSource,
            &Request::post(
                &format!("/v1/accounts/{number}/demo-credit"),
                r#"{"amount":"1.00"}"#,
            ),
            1,
        )
        .unwrap();
        assert_eq!(unkeyed.status, 400);

        // The demo pot reads as exactly the capital in circulation (INV-020).
        let balances = get(&core, "/v1/balances", 1);
        assert!(balances.body.contains(r#""balanced":true"#));
        assert!(
            balances.body.contains(r#""signedMinor":1250000"#),
            "{}",
            balances.body
        );
    }

    /// INV-035 — a reset corrects to the grant only when flat.
    #[test]
    fn inv_035_a_reset_returns_the_account_to_its_grant_only_when_flat() {
        let (core, number) = funded();
        post_keyed(
            &core,
            &format!("/v1/accounts/{number}/demo-credit"),
            r#"{"amount":"100.00"}"#,
            "credit-key-0010",
            1_526_000,
        );
        let order = post(
            &core,
            "/v1/orders",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":"0.10"}}"#),
            1_526_000,
        );
        assert_eq!(order.status, 201);

        let blocked = post_keyed(
            &core,
            &format!("/v1/accounts/{number}/demo-reset"),
            "{}",
            "reset-key-0001",
            1_526_001,
        );
        assert_eq!(blocked.status, 422);
        assert!(blocked.body.contains("POSITIONS_OPEN"));

        let closed = post_keyed(
            &core,
            "/v1/positions/close",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD"}}"#),
            "close-key-00001",
            1_526_002,
        );
        assert_eq!(closed.status, 201);

        let reset = post_keyed(
            &core,
            &format!("/v1/accounts/{number}/demo-reset"),
            "{}",
            "reset-key-0002",
            1_526_003,
        );
        assert_eq!(reset.status, 201, "{}", reset.body);
        assert!(reset.body.contains(r#""balance":"10000.00""#));
        assert!(reset.body.contains(r#""kind":"CORRECTION""#));

        let nothing = post_keyed(
            &core,
            &format!("/v1/accounts/{number}/demo-reset"),
            "{}",
            "reset-key-0003",
            1_526_004,
        );
        assert_eq!(nothing.status, 201);
        assert!(nothing.body.contains(r#""transaction":null"#));
    }

    /// INV-032 — a frozen account originates nothing; reactivated, it trades.
    #[test]
    fn inv_032_a_frozen_account_is_refused_until_reactivated() {
        let (core, number) = funded();
        let frozen = post(
            &core,
            &format!("/v1/accounts/{number}/status"),
            r#"{"status":"frozen"}"#,
            1,
        );
        assert_eq!(frozen.status, 200, "{}", frozen.body);
        assert!(frozen.body.contains(r#""status":"frozen""#));

        let order = post(
            &core,
            "/v1/orders",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":"0.10"}}"#),
            1_526_000,
        );
        assert_eq!(order.status, 422);

        let repeat = post(
            &core,
            &format!("/v1/accounts/{number}/status"),
            r#"{"status":"frozen"}"#,
            1,
        );
        assert_eq!(repeat.status, 422);
        assert!(repeat.body.contains("ILLEGAL_TRANSITION"));

        let active = post(
            &core,
            &format!("/v1/accounts/{number}/status"),
            r#"{"status":"active"}"#,
            1,
        );
        assert_eq!(active.status, 200);
        let listed = get(&core, "/v1/accounts?status=frozen", 1);
        assert!(!listed.body.contains(&number));

        let order = post_keyed(
            &core,
            "/v1/orders",
            &format!(r#"{{"account":"{number}","symbol":"EURUSD","side":"BUY","volume":"0.10"}}"#),
            "order-key-00002",
            1_526_000,
        );
        assert_eq!(order.status, 201);

        let bad = post(
            &core,
            &format!("/v1/accounts/{number}/status"),
            r#"{"status":"paused"}"#,
            1,
        );
        assert_eq!(bad.status, 400);
    }

    #[test]
    fn the_journal_is_pageable_by_transaction_id() {
        let (core, number) = funded();
        post_keyed(
            &core,
            &format!("/v1/accounts/{number}/demo-credit"),
            r#"{"amount":"1.00"}"#,
            "credit-key-0020",
            1,
        );
        let all = get(&core, "/v1/journal", 1);
        assert!(all.body.contains(r#""total":2"#));
        assert_eq!(all.body.matches(r#""transactionId""#).count(), 2);
        let credits = get(&core, "/v1/journal?kind=DEMO_CREDIT&limit=1", 1);
        assert_eq!(credits.body.matches(r#""transactionId""#).count(), 1);
        let first_id: u128 = all
            .body
            .split(r#""sequence":"#)
            .nth(1)
            .unwrap()
            .split(',')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let rest = get(&core, &format!("/v1/journal?after={first_id}"), 1);
        assert_eq!(rest.body.matches(r#""transactionId""#).count(), 1);
        let orders = get(&core, "/v1/orders", 1);
        assert!(orders.body.contains(r#""orders":[]"#));
    }
}

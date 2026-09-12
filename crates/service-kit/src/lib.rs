//! Shared scaffolding for every Rust service.
//!
//! Deliberately dependency-free, like the crates it sits alongside. A Tier 0
//! service should not pull a web framework and its transitive tree into the
//! process that moves money — not because frameworks are bad, but because the
//! surface here is a handful of endpoints and the supply chain is permanent.
//!
//! Provides:
//! - a small threaded HTTP server
//! - `/health`, `/ready`, `/metrics`, `/info`
//! - structured JSON logging with the module id on every line
//! - a metrics registry shaped for the invariant monitors in
//!   `infra/prometheus/rules/invariants.yml`
//! - a request type carrying method, path, query and body, and a
//!   dependency-free JSON reader for that body ([`json`])
//! - a minimal client ([`http`]) for one service calling another

#![forbid(unsafe_code)]

pub mod http;
pub mod json;

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// What a service says about itself.
#[derive(Clone, Debug)]
pub struct ServiceInfo {
    /// Service name, e.g. `ledger`.
    pub name: String,
    /// Registry module id, e.g. `03-ledger`. Present on every log line and
    /// metric so telemetry can be traced back to the module that owns it.
    pub module_id: String,
    /// Deployment tier, e.g. `T0`.
    pub tier: String,
    /// Build version.
    pub version: String,
}

impl ServiceInfo {
    /// Read the service identity from the environment, as set in compose.
    #[must_use]
    pub fn from_env(default_name: &str, default_module: &str, default_tier: &str) -> Self {
        let get =
            |key: &str, fallback: &str| std::env::var(key).unwrap_or_else(|_| fallback.to_owned());
        Self {
            name: get("SERVICE_NAME", default_name),
            module_id: get("MODULE_ID", default_module),
            tier: get("SERVICE_TIER", default_tier),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        }
    }
}

/// A counter registry rendered in Prometheus text format.
#[derive(Default)]
pub struct Metrics {
    counters: Mutex<BTreeMap<String, Arc<AtomicU64>>>,
}

impl Metrics {
    /// A new, empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Get or create a counter.
    pub fn counter(&self, name: &str) -> Arc<AtomicU64> {
        let mut guard = match self.counters.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        Arc::clone(
            guard
                .entry(name.to_owned())
                .or_insert_with(|| Arc::new(AtomicU64::new(0))),
        )
    }

    /// Increment a counter by one.
    pub fn incr(&self, name: &str) {
        self.counter(name).fetch_add(1, Ordering::Relaxed);
    }

    /// Render in Prometheus exposition format.
    pub fn render(&self, info: &ServiceInfo) -> String {
        let guard = match self.counters.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut out = String::new();
        for (name, value) in guard.iter() {
            out.push_str(&format!("# TYPE {name} counter\n"));
            out.push_str(&format!(
                "{name}{{service=\"{}\",module_id=\"{}\",tier=\"{}\"}} {}\n",
                info.name,
                info.module_id,
                info.tier,
                value.load(Ordering::Relaxed)
            ));
        }
        out
    }
}

/// Emit one structured JSON log line.
///
/// Never log a secret, a credential, or a full identity document. See
/// `docs/10-security.md`.
pub fn log(info: &ServiceInfo, level: &str, message: &str) {
    // ALLOW-BANNED: log timestamps are metadata, emitted outside the
    // determinism boundary. Ordering is sequence, never this value (P4).
    let now = SystemTime::now() // ALLOW-BANNED
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    println!(
        r#"{{"ts":{now},"level":"{level}","service":"{}","module_id":"{}","tier":"{}","message":"{}"}}"#,
        info.name,
        info.module_id,
        info.tier,
        message.replace('"', "'")
    );
}

/// A handler decides how to answer a request path.
///
/// Path-only. Use [`RequestHandler`] where the method, query or body matters —
/// which is to say, anywhere a request can change state.
pub type Handler = Box<dyn Fn(&str) -> Option<Response> + Send + Sync>;

/// A handler with the whole request in view.
pub type RequestHandler = Box<dyn Fn(&Request) -> Option<Response> + Send + Sync>;

/// One inbound HTTP request, already read.
///
/// Query parameters and headers are `Vec`s of pairs rather than maps: a request
/// carries a handful of each, lookup is not a bottleneck, and document order is
/// preserved so logging a request is deterministic (INV-013).
#[derive(Clone, Debug)]
pub struct Request {
    /// `GET`, `POST`, … uppercased.
    pub method: String,
    /// Path with the query string removed, e.g. `/v1/orders`.
    pub path: String,
    /// Decoded query parameters, in the order they appeared.
    pub query: Vec<(String, String)>,
    /// Header names lowercased, in the order they arrived.
    pub headers: Vec<(String, String)>,
    /// Request body, as received.
    pub body: String,
}

impl Request {
    /// A query parameter by name.
    #[must_use]
    pub fn param(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// A header by (lowercase) name.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// The body parsed as JSON.
    ///
    /// # Errors
    /// [`json::JsonError`] if the body is not one well-formed JSON value.
    pub fn json(&self) -> Result<json::Value, json::JsonError> {
        json::parse(&self.body)
    }

    /// A bare `GET` for `target`, which may carry a query string.
    ///
    /// Convenience for tests and for internal calls; the server builds requests
    /// from the socket, not from this.
    #[must_use]
    pub fn get(target: &str) -> Self {
        let (path, query) = split_query(target);
        Self {
            method: "GET".to_owned(),
            path,
            query,
            headers: Vec::new(),
            body: String::new(),
        }
    }

    /// A `POST` to `target` carrying `body`.
    #[must_use]
    pub fn post(target: &str, body: &str) -> Self {
        let (path, query) = split_query(target);
        Self {
            method: "POST".to_owned(),
            path,
            query,
            headers: Vec::new(),
            body: body.to_owned(),
        }
    }

    /// The path split on `/`, ignoring empty segments.
    ///
    /// `/v1/accounts/50000001/close` -> `["v1", "accounts", "50000001", "close"]`.
    #[must_use]
    pub fn segments(&self) -> Vec<&str> {
        self.path.split('/').filter(|s| !s.is_empty()).collect()
    }
}

/// Percent-decode a query component, turning `+` into a space.
///
/// Iterator-based: a malformed escape at the end of the input yields the
/// literal characters rather than reading past the end.
fn percent_decode(input: &str) -> String {
    let mut bytes = input.bytes().peekable();
    // Percent escapes encode bytes, so decoding collects bytes and validates
    // the result as UTF-8 once, at the end.
    let mut buffer: Vec<u8> = Vec::with_capacity(input.len());
    while let Some(byte) = bytes.next() {
        match byte {
            b'+' => buffer.push(b' '),
            b'%' => {
                let hi = bytes
                    .peek()
                    .copied()
                    .and_then(|b| char::from(b).to_digit(16));
                if let Some(hi) = hi {
                    let _ = bytes.next();
                    let lo = bytes
                        .peek()
                        .copied()
                        .and_then(|b| char::from(b).to_digit(16));
                    if let Some(lo) = lo {
                        let _ = bytes.next();
                        let value = hi.checked_mul(16).and_then(|h| h.checked_add(lo));
                        match value.and_then(|v| u8::try_from(v).ok()) {
                            Some(decoded) => buffer.push(decoded),
                            None => buffer.push(b'%'),
                        }
                        continue;
                    }
                }
                buffer.push(b'%');
            }
            other => buffer.push(other),
        }
    }
    // Invalid UTF-8 in a query string is not something to guess at: the
    // parameter comes back empty rather than lossily repaired into a value the
    // caller never sent.
    String::from_utf8(buffer).unwrap_or_default()
}

/// Split `path?a=1&b=2` into its path and decoded parameters.
#[must_use]
pub fn split_query(target: &str) -> (String, Vec<(String, String)>) {
    let (path, raw) = match target.split_once('?') {
        Some((path, raw)) => (path, raw),
        None => (target, ""),
    };
    let params = raw
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (percent_decode(key), percent_decode(value)),
            None => (percent_decode(pair), String::new()),
        })
        .collect();
    (path.to_owned(), params)
}

/// An HTTP response.
pub struct Response {
    /// Status code.
    pub status: u16,
    /// Content type.
    pub content_type: &'static str,
    /// Body.
    pub body: String,
}

impl Response {
    /// A JSON response.
    #[must_use]
    pub fn json(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: body.into(),
        }
    }

    /// A plain-text response.
    #[must_use]
    pub fn text(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "text/plain; version=0.0.4",
            body: body.into(),
        }
    }
}

/// A service: identity, metrics, and routes.
pub struct Service {
    info: ServiceInfo,
    metrics: Arc<Metrics>,
    routes: Vec<Handler>,
    request_routes: Vec<RequestHandler>,
    ready: Arc<AtomicU64>,
}

impl Service {
    /// Create a service.
    #[must_use]
    pub fn new(info: ServiceInfo) -> Self {
        Self {
            info,
            metrics: Arc::new(Metrics::new()),
            routes: Vec::new(),
            request_routes: Vec::new(),
            ready: Arc::new(AtomicU64::new(0)),
        }
    }

    /// This service's metrics registry.
    #[must_use]
    pub fn metrics(&self) -> Arc<Metrics> {
        Arc::clone(&self.metrics)
    }

    /// This service's identity.
    #[must_use]
    pub fn info(&self) -> &ServiceInfo {
        &self.info
    }

    /// Mark the service ready to receive traffic.
    ///
    /// Readiness is separate from liveness on purpose: a service can be alive
    /// (do not restart me) while not ready (do not send me orders). Conflating
    /// them is how a restarting service receives traffic it cannot serve.
    pub fn set_ready(&self, ready: bool) {
        self.ready.store(u64::from(ready), Ordering::SeqCst);
    }

    /// Add a path-only route handler. Handlers are tried in registration order.
    pub fn route(&mut self, handler: Handler) {
        self.routes.push(handler);
    }

    /// Add a route handler that sees the whole request.
    ///
    /// Tried before the path-only handlers, because a handler that inspects the
    /// method is by definition more specific than one that does not.
    pub fn route_request(&mut self, handler: RequestHandler) {
        self.request_routes.push(handler);
    }

    /// Serve until killed.
    ///
    /// # Errors
    /// Returns an error if the listener cannot bind.
    pub fn serve(self, port: u16) -> std::io::Result<()> {
        let listener = TcpListener::bind(("0.0.0.0", port))?;
        log(
            &self.info,
            "info",
            &format!("listening on 0.0.0.0:{port} ({})", self.info.module_id),
        );
        self.set_ready(true);

        let shared = Arc::new(self);
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let service = Arc::clone(&shared);
                    std::thread::spawn(move || {
                        if let Err(err) = service.handle(stream) {
                            log(&service.info, "warn", &format!("connection error: {err}"));
                        }
                    });
                }
                Err(err) => log(&shared.info, "warn", &format!("accept failed: {err}")),
            }
        }
        Ok(())
    }

    fn handle(&self, mut stream: TcpStream) -> std::io::Result<()> {
        let mut reader = BufReader::new(stream.try_clone()?);
        self.metrics.incr("projectx_http_requests_total");

        let response = match read_request(&mut reader) {
            Ok(request) => self.dispatch(&request),
            Err(RequestError::TooLarge) => {
                self.metrics.incr("projectx_http_rejected_total");
                // The client is still sending. Closing with unread bytes in
                // the socket makes the kernel reset the connection and the
                // 413 never arrives; drain a bounded amount first so the
                // refusal is actually delivered.
                drain_oversized(&mut reader);
                Response::json(413, r#"{"error":"request_too_large"}"#)
            }
            Err(RequestError::Malformed) => {
                self.metrics.incr("projectx_http_rejected_total");
                Response::json(400, r#"{"error":"malformed_request"}"#)
            }
            Err(RequestError::Io(err)) => return Err(err),
        };

        let status_text = status_text(response.status);
        let body = response.body.as_bytes();
        write!(
            stream,
            "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            response.status,
            status_text,
            response.content_type,
            body.len()
        )?;
        stream.write_all(body)?;
        stream.flush()
    }

    fn dispatch(&self, request: &Request) -> Response {
        match request.path.as_str() {
            "/health" => Response::json(
                200,
                format!(
                    r#"{{"status":"healthy","service":"{}","module_id":"{}","tier":"{}","version":"{}"}}"#,
                    self.info.name, self.info.module_id, self.info.tier, self.info.version
                ),
            ),
            "/ready" => {
                if self.ready.load(Ordering::SeqCst) == 1 {
                    Response::json(200, r#"{"status":"ready"}"#)
                } else {
                    Response::json(503, r#"{"status":"not_ready"}"#)
                }
            }
            "/metrics" => Response::text(200, self.metrics.render(&self.info)),
            "/info" => Response::json(
                200,
                format!(
                    r#"{{"service":"{}","module_id":"{}","tier":"{}","version":"{}","docs":"docs/modules/{}.md"}}"#,
                    self.info.name,
                    self.info.module_id,
                    self.info.tier,
                    self.info.version,
                    self.info.module_id
                ),
            ),
            other => {
                for handler in &self.request_routes {
                    if let Some(response) = handler(request) {
                        return response;
                    }
                }
                for handler in &self.routes {
                    if let Some(response) = handler(other) {
                        return response;
                    }
                }
                Response::json(404, r#"{"error":"not_found"}"#)
            }
        }
    }
}

/// Why a request could not be read.
enum RequestError {
    /// The body or headers exceeded [`MAX_BODY_BYTES`] / [`MAX_HEADERS`].
    TooLarge,
    /// The request line or a header was not well-formed.
    Malformed,
    /// The socket failed.
    Io(std::io::Error),
}

impl From<std::io::Error> for RequestError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

/// The largest body this server will read. An order is a few hundred bytes; a
/// megabyte of it is not a mistake, it is someone probing for a heap.
const MAX_BODY_BYTES: usize = 64 * 1024;
/// The most headers a request may carry.
const MAX_HEADERS: usize = 64;

/// The most of an oversized body that is read and discarded so the 413 can
/// be delivered; beyond this the connection is simply dropped.
const DRAIN_CAP_BYTES: usize = 1024 * 1024;
/// How long draining may wait on a client that stops sending.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Read and discard the rest of an oversized request, bounded in bytes and
/// time. Errors are irrelevant here: the response is a refusal either way.
fn drain_oversized(reader: &mut BufReader<TcpStream>) {
    let _ = reader.get_ref().set_read_timeout(Some(DRAIN_TIMEOUT));
    let mut discarded = 0usize;
    let mut chunk = [0u8; 8192];
    while discarded < DRAIN_CAP_BYTES {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => discarded = discarded.saturating_add(n),
        }
    }
}

/// Read one HTTP/1.1 request: request line, headers, and `Content-Length` body.
///
/// No chunked transfer encoding, no keep-alive, no pipelining. Every client of
/// these services is inside the compose network and sends a plain request; the
/// alternative is a protocol implementation nobody is going to review.
fn read_request(reader: &mut BufReader<TcpStream>) -> Result<Request, RequestError> {
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Err(RequestError::Malformed);
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or(RequestError::Malformed)?.to_uppercase();
    let target = parts.next().ok_or(RequestError::Malformed)?;
    let (path, query) = split_query(target);

    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if headers.len() >= MAX_HEADERS {
            return Err(RequestError::TooLarge);
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(RequestError::Malformed);
        };
        let name = name.trim().to_lowercase();
        let value = value.trim().to_owned();
        if name == "content-length" {
            content_length = value.parse().map_err(|_| RequestError::Malformed)?;
            if content_length > MAX_BODY_BYTES {
                return Err(RequestError::TooLarge);
            }
        }
        headers.push((name, value));
    }

    let mut body = String::new();
    if content_length > 0 {
        let mut buffer = vec![0u8; content_length];
        reader.read_exact(&mut buffer)?;
        body = String::from_utf8(buffer).map_err(|_| RequestError::Malformed)?;
    }

    Ok(Request {
        method,
        path,
        query,
        headers,
        body,
    })
}

/// The reason phrase for a status code. Every code this codebase emits is
/// listed; an unlisted one is a bug, and saying so is better than guessing.
const fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}

/// Read the listening port from `PORT`, defaulting to 8000.
#[must_use]
pub fn port_from_env() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8000)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn metrics_render_in_prometheus_format() {
        let info = ServiceInfo {
            name: "ledger".into(),
            module_id: "03-ledger".into(),
            tier: "T0".into(),
            version: "0.1.0".into(),
        };
        let metrics = Metrics::new();
        metrics.incr("projectx_test_total");
        metrics.incr("projectx_test_total");
        let rendered = metrics.render(&info);
        assert!(rendered.contains("# TYPE projectx_test_total counter"));
        assert!(rendered.contains(r#"module_id="03-ledger""#));
        assert!(rendered.trim().ends_with(" 2"));
    }

    #[test]
    fn readiness_is_separate_from_liveness() {
        let info = ServiceInfo {
            name: "t".into(),
            module_id: "m".into(),
            tier: "T0".into(),
            version: "0".into(),
        };
        let service = Service::new(info);
        // Alive but not ready: do not restart me, but do not send me traffic.
        assert_eq!(service.dispatch(&Request::get("/health")).status, 200);
        assert_eq!(service.dispatch(&Request::get("/ready")).status, 503);
        service.set_ready(true);
        assert_eq!(service.dispatch(&Request::get("/ready")).status, 200);
    }

    #[test]
    fn unknown_paths_are_404_not_a_panic() {
        let info = ServiceInfo {
            name: "t".into(),
            module_id: "m".into(),
            tier: "T0".into(),
            version: "0".into(),
        };
        let service = Service::new(info);
        assert_eq!(service.dispatch(&Request::get("/nope")).status, 404);
    }

    #[test]
    fn query_parameters_are_split_and_decoded() {
        let request = Request::get("/v1/candles?symbol=EUR%2FUSD&interval=1m&limit=200&flag");
        assert_eq!(request.path, "/v1/candles");
        assert_eq!(request.param("symbol"), Some("EUR/USD"));
        assert_eq!(request.param("interval"), Some("1m"));
        assert_eq!(request.param("limit"), Some("200"));
        assert_eq!(request.param("flag"), Some(""));
        assert_eq!(request.param("absent"), None);
    }

    #[test]
    fn a_plus_is_a_space_and_a_stray_percent_survives() {
        let request = Request::get("/x?a=one+two&b=100%25&c=%zz");
        assert_eq!(request.param("a"), Some("one two"));
        assert_eq!(request.param("b"), Some("100%"));
        assert_eq!(request.param("c"), Some("%zz"));
    }

    #[test]
    fn path_segments_ignore_empty_parts() {
        assert_eq!(
            Request::get("/v1/accounts/50000001/close").segments(),
            vec!["v1", "accounts", "50000001", "close"]
        );
        assert!(Request::get("/").segments().is_empty());
    }

    #[test]
    fn a_body_is_readable_as_json() {
        let request = Request::post("/v1/orders", r#"{"symbol":"EURUSD"}"#);
        let body = request.json().unwrap();
        assert_eq!(body.str_field("symbol"), Some("EURUSD"));
    }

    /// Request-aware handlers are tried before path-only ones, so a handler
    /// that distinguishes GET from POST cannot be shadowed by one that does not.
    #[test]
    fn request_handlers_run_before_path_handlers() {
        let info = ServiceInfo {
            name: "t".into(),
            module_id: "m".into(),
            tier: "T0".into(),
            version: "0".into(),
        };
        let mut service = Service::new(info);
        service.route(Box::new(|_path| {
            Some(Response::json(200, r#"{"from":"path"}"#))
        }));
        service.route_request(Box::new(|request| {
            (request.method == "POST").then(|| Response::json(201, r#"{"from":"request"}"#))
        }));
        assert_eq!(
            service.dispatch(&Request::get("/x")).body,
            r#"{"from":"path"}"#
        );
        assert_eq!(service.dispatch(&Request::post("/x", "")).status, 201);
    }
}

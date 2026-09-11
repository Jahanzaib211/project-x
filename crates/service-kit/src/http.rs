//! A minimal HTTP client, for one service calling another.
//!
//! Same reasoning as the server in [`crate`]: the calls these services make are
//! a handful of GETs and POSTs to known addresses on a private network, and a
//! full client library is a permanent supply chain for a temporary convenience.
//!
//! What it deliberately does **not** do: redirects, keep-alive, chunked
//! transfer, TLS, or cookies. Every one of those is a behaviour that could
//! surprise a caller on a money path. A response that is not a plain
//! `Content-Length` body is an error, not something to be interpreted.
//!
//! Timeouts are mandatory arguments rather than optional settings, because a
//! call with no timeout is how one slow service becomes an outage in five.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// Why a call failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HttpError {
    /// The URL was not one this client can dial.
    BadUrl(&'static str),
    /// The connection failed, timed out, or was reset.
    Transport(String),
    /// A header name or value contained a newline. Refused rather than
    /// sanitised: quietly rewriting a caller's input hides their bug, and this
    /// particular bug is request smuggling.
    BadHeader,
    /// The response was not something this client will interpret.
    BadResponse(&'static str),
}

impl core::fmt::Display for HttpError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::BadUrl(why) => write!(f, "bad url: {why}"),
            Self::Transport(why) => write!(f, "transport: {why}"),
            Self::BadHeader => f.write_str("a header name or value contains a newline"),
            Self::BadResponse(why) => write!(f, "bad response: {why}"),
        }
    }
}

/// A response: status and body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    /// Status code.
    pub status: u16,
    /// Body, as received.
    pub body: String,
}

impl HttpResponse {
    /// Whether the status is 2xx.
    #[must_use]
    pub const fn is_success(&self) -> bool {
        self.status >= 200 && self.status < 300
    }

    /// The body parsed as JSON.
    ///
    /// # Errors
    /// [`crate::json::JsonError`] if the body is not one well-formed value.
    pub fn json(&self) -> Result<crate::json::Value, crate::json::JsonError> {
        crate::json::parse(&self.body)
    }
}

/// The largest response body this client will read.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// `http://host:port/path` split into the parts needed to dial it.
fn split_url(url: &str) -> Result<(String, String), HttpError> {
    let rest = url
        .strip_prefix("http://")
        .ok_or(HttpError::BadUrl("only http:// is supported"))?;
    let (authority, path) = match rest.find('/') {
        Some(index) => {
            let (a, p) = rest.split_at(index);
            (a, p)
        }
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return Err(HttpError::BadUrl("no host"));
    }
    // A port is required. Guessing 80 would silently dial the wrong thing when
    // an environment variable is missing its port.
    if !authority.contains(':') {
        return Err(HttpError::BadUrl("the port must be explicit"));
    }
    Ok((authority.to_owned(), path.to_owned()))
}

/// Issue a GET.
///
/// # Errors
/// [`HttpError`] if the URL is unusable, the connection fails, or the response
/// is not a plain `Content-Length` body.
pub fn get(url: &str, timeout: Duration) -> Result<HttpResponse, HttpError> {
    request("GET", url, None, &[], timeout)
}

/// Issue a POST with a JSON body.
///
/// # Errors
/// As [`get`].
pub fn post_json(
    url: &str,
    body: &str,
    headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<HttpResponse, HttpError> {
    request("POST", url, Some(body), headers, timeout)
}

fn request(
    method: &str,
    url: &str,
    body: Option<&str>,
    headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<HttpResponse, HttpError> {
    let (authority, path) = split_url(url)?;
    // Validated before anything is dialled, so a malformed header is reported
    // as itself rather than as whatever the connection happens to do first.
    if headers
        .iter()
        .any(|(name, value)| name.contains(['\r', '\n']) || value.contains(['\r', '\n']))
    {
        return Err(HttpError::BadHeader);
    }

    let mut stream =
        TcpStream::connect(&authority).map_err(|err| HttpError::Transport(err.to_string()))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|err| HttpError::Transport(err.to_string()))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|err| HttpError::Transport(err.to_string()))?;

    let mut request =
        format!("{method} {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    match body {
        Some(body) => {
            request.push_str("Content-Type: application/json\r\n");
            request.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
            request.push_str(body);
        }
        None => request.push_str("\r\n"),
    }

    stream
        .write_all(request.as_bytes())
        .map_err(|err| HttpError::Transport(err.to_string()))?;
    stream
        .flush()
        .map_err(|err| HttpError::Transport(err.to_string()))?;

    read_response(&mut stream)
}

fn read_response(stream: &mut TcpStream) -> Result<HttpResponse, HttpError> {
    let mut reader = BufReader::new(stream);

    let mut status_line = String::new();
    reader
        .read_line(&mut status_line)
        .map_err(|err| HttpError::Transport(err.to_string()))?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or(HttpError::BadResponse("no status code"))?;

    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|err| HttpError::Transport(err.to_string()))?;
        if read == 0 {
            break;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_lowercase();
            let value = value.trim();
            if name == "content-length" {
                content_length = value.parse().ok();
            }
            if name == "transfer-encoding" && value.eq_ignore_ascii_case("chunked") {
                chunked = true;
            }
        }
    }

    if chunked {
        return Err(HttpError::BadResponse("chunked encoding is not supported"));
    }

    let body = match content_length {
        Some(length) => {
            if length > MAX_RESPONSE_BYTES {
                return Err(HttpError::BadResponse("response body too large"));
            }
            let mut buffer = vec![0u8; length];
            reader
                .read_exact(&mut buffer)
                .map_err(|err| HttpError::Transport(err.to_string()))?;
            String::from_utf8(buffer).map_err(|_| HttpError::BadResponse("body is not UTF-8"))?
        }
        // No length and no chunking means "read until close", which these
        // services never do. Treating it as an empty body would silently drop a
        // response, so it is refused.
        None => return Err(HttpError::BadResponse("no content-length")),
    };

    Ok(HttpResponse { status, body })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    #[test]
    fn urls_are_split_into_authority_and_path() {
        assert_eq!(
            split_url("http://ledger:8000/v1/state?account=1").unwrap(),
            ("ledger:8000".to_owned(), "/v1/state?account=1".to_owned())
        );
        assert_eq!(
            split_url("http://127.0.0.1:27002").unwrap(),
            ("127.0.0.1:27002".to_owned(), "/".to_owned())
        );
    }

    /// A missing port is a configuration error, not something to guess at. An
    /// environment variable that lost its port would otherwise dial port 80 and
    /// fail in a way that looks like the other service being down.
    #[test]
    fn a_url_without_an_explicit_port_is_refused() {
        assert_eq!(
            split_url("http://ledger/v1/state"),
            Err(HttpError::BadUrl("the port must be explicit"))
        );
    }

    #[test]
    fn only_plain_http_is_dialled() {
        assert!(split_url("https://ledger:8000/").is_err());
        assert!(split_url("ledger:8000/").is_err());
        assert!(split_url("http:///path").is_err());
    }

    #[test]
    fn a_header_with_a_newline_is_refused_rather_than_sanitised() {
        let result = post_json(
            "http://127.0.0.1:1/x",
            "{}",
            &[("idempotency-key", "a\r\nX-Injected: 1")],
            Duration::from_millis(50),
        );
        assert_eq!(result, Err(HttpError::BadHeader));
    }

    #[test]
    fn a_closed_port_is_a_transport_error_not_a_panic() {
        // Port 1 on loopback is not listening in any environment this runs in.
        let result = get("http://127.0.0.1:1/health", Duration::from_millis(200));
        assert!(matches!(result, Err(HttpError::Transport(_))));
    }

    #[test]
    fn success_is_the_two_hundreds_and_nothing_else() {
        for (status, ok) in [
            (199u16, false),
            (200, true),
            (299, true),
            (300, false),
            (503, false),
        ] {
            let response = HttpResponse {
                status,
                body: String::new(),
            };
            assert_eq!(response.is_success(), ok, "status {status}");
        }
    }
}

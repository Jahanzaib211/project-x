//! Container healthcheck. Exits 0 when the service answers /health.
//!
//! A separate binary rather than a shell `curl`, so the runtime image needs no
//! shell and no curl — a smaller image is a smaller attack surface.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

fn main() -> std::process::ExitCode {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8000);

    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return std::process::ExitCode::FAILURE;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return std::process::ExitCode::FAILURE;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return std::process::ExitCode::FAILURE;
    }
    if response.starts_with("HTTP/1.1 200") {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}

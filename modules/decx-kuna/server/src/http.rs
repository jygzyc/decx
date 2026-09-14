//! Minimal HTTP/1.1 plumbing over `std::net::TcpListener`.
//!
//! No async runtime and no HTTP framework: DECX engine servers answer one
//! client at a time (the Go CLI is strictly sequential), so a blocking
//! read → dispatch → write loop per connection is sufficient. Every response
//! carries `Connection: close`; keep-alive is deliberately not implemented.

use std::io::{self, BufRead, Write};

pub const MAX_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug)]
pub enum RequestError {
    /// The peer closed the connection before sending any request bytes; this is
    /// a normal end of a connection, not a protocol error.
    Closed,
    /// The bytes on the wire are not a supported HTTP/1.1 request.
    Malformed(String),
    Io(io::Error),
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => write!(formatter, "connection closed"),
            Self::Malformed(message) => write!(formatter, "{message}"),
            Self::Io(error) => write!(formatter, "I/O error: {error}"),
        }
    }
}

impl std::error::Error for RequestError {}

fn read_line(reader: &mut impl BufRead) -> Result<Option<String>, RequestError> {
    let mut line: Vec<u8> = Vec::new();
    let read = reader.read_until(b'\n', &mut line).map_err(RequestError::Io)?;
    if read == 0 {
        return Ok(None);
    }
    if line.len() > MAX_HEADER_BYTES {
        return Err(RequestError::Malformed(
            "request line or header exceeds the size limit".to_string(),
        ));
    }
    if line.ends_with(b"\n") {
        line.pop();
    }
    if line.ends_with(b"\r") {
        line.pop();
    }
    String::from_utf8(line)
        .map(Some)
        .map_err(|_| RequestError::Malformed("request line or header is not valid UTF-8".to_string()))
}

/// Read exactly one HTTP/1.1 request. Bare-LF line endings are accepted for
/// robustness; a `Transfer-Encoding` other than `identity` is rejected because
/// the CLI always sends `Content-Length`.
pub fn read_request(reader: &mut impl BufRead) -> Result<HttpRequest, RequestError> {
    let request_line = match read_line(reader)? {
        Some(line) if !line.is_empty() => line,
        Some(_) => return Err(RequestError::Malformed("empty request line".to_string())),
        None => return Err(RequestError::Closed),
    };

    let mut parts = request_line.split(' ');
    let method = parts
        .next()
        .filter(|part| !part.is_empty())
        .ok_or_else(|| RequestError::Malformed(format!("malformed request line {request_line:?}")))?;
    let target = parts
        .next()
        .filter(|part| !part.is_empty())
        .ok_or_else(|| RequestError::Malformed(format!("malformed request line {request_line:?}")))?;
    let version = parts
        .next()
        .filter(|part| !part.is_empty())
        .ok_or_else(|| RequestError::Malformed(format!("malformed request line {request_line:?}")))?;
    if parts.next().is_some() {
        return Err(RequestError::Malformed(format!(
            "malformed request line {request_line:?}"
        )));
    }
    if !version.starts_with("HTTP/1.") {
        return Err(RequestError::Malformed(format!(
            "unsupported HTTP version {version:?}"
        )));
    }

    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let line = match read_line(reader)? {
            Some(line) => line,
            None => {
                return Err(RequestError::Malformed(
                    "connection closed inside request headers".to_string(),
                ))
            }
        };
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').ok_or_else(|| {
            RequestError::Malformed(format!("malformed header line {line:?}"))
        })?;
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }

    let mut content_length = 0usize;
    for (name, value) in &headers {
        match name.as_str() {
            "content-length" => {
                content_length = value.parse::<usize>().map_err(|_| {
                    RequestError::Malformed(format!("invalid Content-Length {value:?}"))
                })?;
            }
            "transfer-encoding" => {
                if !value.eq_ignore_ascii_case("identity") {
                    return Err(RequestError::Malformed(
                        "Transfer-Encoding is not supported (send a Content-Length)".to_string(),
                    ));
                }
            }
            _ => {}
        }
    }
    if content_length > MAX_BODY_BYTES {
        return Err(RequestError::Malformed(format!(
            "request body of {content_length} bytes exceeds the {MAX_BODY_BYTES}-byte limit"
        )));
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).map_err(|error| {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                RequestError::Malformed(format!(
                    "request body truncated (Content-Length {content_length})"
                ))
            } else {
                RequestError::Io(error)
            }
        })?;
    }

    let path = target.split_once('?').map_or(target, |(path, _)| path);
    Ok(HttpRequest {
        method: method.to_string(),
        path: path.to_string(),
        headers,
        body,
    })
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn json(status: u16, body: String) -> Self {
        Self {
            status,
            body: body.into_bytes(),
        }
    }

    pub fn write_to(&self, writer: &mut impl Write) -> io::Result<()> {
        write!(
            writer,
            "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.status,
            reason_phrase(self.status),
            self.body.len()
        )?;
        writer.write_all(&self.body)?;
        writer.flush()
    }
}

pub fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn parse(raw: &[u8]) -> Result<HttpRequest, RequestError> {
        read_request(&mut Cursor::new(raw.to_vec()))
    }

    #[test]
    fn parses_post_with_headers_and_body() {
        let request = parse(
            b"POST /api/decx/get_functions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 7\r\n\r\n{\"a\":1}",
        )
        .unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/decx/get_functions");
        assert_eq!(request.header("host"), Some("127.0.0.1"));
        assert_eq!(request.header("content-length"), Some("7"));
        assert_eq!(request.body, b"{\"a\":1}");
    }

    #[test]
    fn lowercases_header_names_and_trims_values() {
        let request =
            parse(b"GET /health HTTP/1.1\r\nX-Foo:   spaced value  \r\n\r\n").unwrap();
        assert_eq!(request.header("x-foo"), Some("spaced value"));
        assert!(request.body.is_empty());
    }

    #[test]
    fn strips_query_string_from_path() {
        let request = parse(b"GET /health?verbose=1 HTTP/1.1\r\n\r\n").unwrap();
        assert_eq!(request.path, "/health");
    }

    #[test]
    fn accepts_bare_lf_line_endings() {
        let request = parse(b"GET /health HTTP/1.1\nHost: x\n\n").unwrap();
        assert_eq!(request.path, "/health");
        assert_eq!(request.header("host"), Some("x"));
    }

    #[test]
    fn rejects_truncated_headers() {
        let error = parse(b"POST /api/decx/get_functions HTTP/1.1\r\nHost: x\r\n").unwrap_err();
        assert!(
            matches!(error, RequestError::Malformed(ref message) if message.contains("inside request headers")),
            "{error}"
        );
    }

    #[test]
    fn rejects_malformed_request_line() {
        assert!(matches!(
            parse(b"GET\r\n\r\n").unwrap_err(),
            RequestError::Malformed(_)
        ));
        assert!(matches!(
            parse(b"GET /health\r\n\r\n").unwrap_err(),
            RequestError::Malformed(_)
        ));
        assert!(matches!(
            parse(b"GET /health HTTP/2.0\r\n\r\n").unwrap_err(),
            RequestError::Malformed(_)
        ));
    }

    #[test]
    fn rejects_truncated_body() {
        let error =
            parse(b"POST /api HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc").unwrap_err();
        assert!(
            matches!(error, RequestError::Malformed(ref message) if message.contains("truncated")),
            "{error}"
        );
    }

    #[test]
    fn rejects_non_utf8_request_line() {
        assert!(matches!(
            parse(b"GET /\xff HTTP/1.1\r\n\r\n").unwrap_err(),
            RequestError::Malformed(_)
        ));
    }

    #[test]
    fn rejects_chunked_requests() {
        let error = parse(b"POST /api HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap_err();
        assert!(
            matches!(error, RequestError::Malformed(ref message) if message.contains("Transfer-Encoding")),
            "{error}"
        );
    }

    #[test]
    fn reports_closed_connection() {
        assert!(matches!(parse(b"").unwrap_err(), RequestError::Closed));
    }

    #[test]
    fn response_writer_sets_json_headers() {
        let response = HttpResponse::json(404, "{\"ok\":false}".to_string());
        let mut out = Vec::new();
        response.write_to(&mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("HTTP/1.1 404 Not Found\r\n"));
        assert!(head.contains("Content-Type: application/json; charset=utf-8\r\n"));
        assert!(head.contains("Content-Length: 12\r\n"));
        assert!(text.contains("Connection: close\r\n"));
        assert_eq!(body, "{\"ok\":false}");
    }
}

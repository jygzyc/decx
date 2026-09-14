//! End-to-end test through the real `kuna-server` binary over a loopback TCP
//! socket, against the vendored `sample.elf` fixture in the pinned kuna
//! submodule.
//!
//! The engine needs compiled SLEIGH specs. They are produced by
//! `modules/decx-kuna/build.sh` into `modules/decx-kuna/.build/specs`; when that
//! tree (or an explicit `KUNA_SPECS`) is absent the test prints a skip message
//! and passes — it never fails for a missing build artifact.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixture_path() -> PathBuf {
    manifest_dir().join("../kuna/integrations/web/test/fixtures/sample.elf")
}

fn has_sla(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if has_sla(&path) {
                return true;
            }
        } else if path.extension().and_then(|value| value.to_str()) == Some("sla") {
            return true;
        }
    }
    false
}

/// `KUNA_SPECS` when set, else the build.sh output directory.
fn specs_root() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("KUNA_SPECS") {
        let value = value.trim();
        if !value.is_empty() {
            let path = PathBuf::from(value);
            return has_sla(&path).then_some(path);
        }
    }
    let path = manifest_dir().join("../.build/specs");
    has_sla(&path).then_some(path)
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    let port = listener.local_addr().expect("local addr").port();
    drop(listener);
    port
}

/// One request/response over its own connection. The server answers with
/// `Connection: close`, so `read_to_end` returns after the body.
fn try_http_request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("connect to kuna-server: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(300)))
        .map_err(|error| format!("set read timeout: {error}"))?;
    let body = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("write request: {error}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|error| format!("read response: {error}"))?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| format!("no header/body separator in response: {text:?}"))?;
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| format!("no status code in response head: {head:?}"))?;
    Ok((status, body.to_string()))
}

fn http_request(port: u16, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
    try_http_request(port, method, path, body).unwrap_or_else(|error| panic!("{error}"))
}

fn wait_for_health(child: &mut Child, port: u16, deadline: Instant) -> String {
    loop {
        if let Some(status) = child.try_wait().expect("poll server") {
            panic!("kuna-server exited before becoming healthy: {status}");
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("kuna-server did not become healthy in time");
        }
        if let Ok((200, body)) = try_http_request(port, "GET", "/health", None) {
            return body;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(child.id().to_string())
            .status();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

#[test]
fn engine_serves_health_functions_source_and_xrefs() {
    let Some(specs) = specs_root() else {
        eprintln!(
            "integration test skipped: no compiled SLEIGH specs found. \
             Run `modules/decx-kuna/build.sh` once (specs land in modules/decx-kuna/.build/specs) \
             or point KUNA_SPECS at an extracted specs/ tree."
        );
        return;
    };
    let fixture = fixture_path();
    assert!(fixture.is_file(), "fixture missing: {}", fixture.display());

    let port = free_port();
    let mut child = Command::new(env!("CARGO_BIN_EXE_kuna-server"))
        .arg(&fixture)
        .arg("--port")
        .arg(port.to_string())
        .arg("--specs")
        .arg(&specs)
        .arg("--mode")
        .arg("reliable")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn kuna-server");

    let deadline = Instant::now() + Duration::from_secs(300);
    let health = wait_for_health(&mut child, port, deadline);
    let health: serde_json::Value = serde_json::from_str(&health).expect("health JSON");
    assert_eq!(health["status"], "running");
    assert_eq!(health["ok"], true);

    let (status, body) = http_request(port, "POST", "/api/decx/get_functions", Some(r#"{"limit": 200}"#));
    assert_eq!(status, 200, "get_functions status: {body}");
    let functions: serde_json::Value = serde_json::from_str(&body).expect("functions JSON");
    assert_eq!(functions["ok"], true);
    let items = functions["items"].as_array().expect("items array");
    assert!(!items.is_empty(), "inventory is empty: {body}");
    assert!(
        functions["summary"]["total"].as_u64().unwrap_or(0) > 0,
        "no functions reported: {body}"
    );
    let names: Vec<&str> = items
        .iter()
        .filter_map(|item| item["name"].as_str())
        .collect();
    let chosen = ["add", "sum_to", "main"]
        .iter()
        .find(|candidate| names.contains(candidate))
        .map(|candidate| candidate.to_string())
        .unwrap_or_else(|| names.first().expect("at least one named item").to_string());
    let first = items
        .iter()
        .find(|item| item["name"].as_str() == Some(chosen.as_str()))
        .expect("chosen item present");
    assert!(first["address"].as_u64().is_some(), "address missing: {first}");
    assert!(
        first["address_hex"].as_str().unwrap_or("").starts_with("0x"),
        "address_hex missing: {first}"
    );
    assert!(
        !first["kind"].as_str().unwrap_or("").is_empty(),
        "kind missing: {first}"
    );

    let request = format!(r#"{{"name": "{}", "limit": 40}}"#, chosen);
    let (status, body) = http_request(port, "POST", "/api/decx/get_function_source", Some(&request));
    assert_eq!(status, 200, "get_function_source status: {body}");
    let source: serde_json::Value = serde_json::from_str(&body).expect("source JSON");
    assert_eq!(source["ok"], true);
    let source_item = &source["items"][0];
    let code = source_item["code"].as_str().unwrap_or("");
    assert!(
        !code.is_empty(),
        "empty decompiled code for {chosen}: {body}"
    );
    assert_eq!(source["summary"]["name"].as_str(), Some(chosen.as_str()));
    assert!(
        source["summary"]["lines"].as_u64().unwrap_or(0) > 0,
        "no code lines reported: {body}"
    );

    let request = format!(r#"{{"name": "{}", "direction": "callers"}}"#, chosen);
    let (status, body) = http_request(port, "POST", "/api/decx/get_function_xref", Some(&request));
    assert_eq!(status, 200, "get_function_xref status: {body}");
    let xrefs: serde_json::Value = serde_json::from_str(&body).expect("xref JSON");
    assert_eq!(xrefs["ok"], true);
    assert_eq!(xrefs["summary"]["direction"], "callers");
    for item in xrefs["items"].as_array().expect("xref items array") {
        assert!(item["from"].as_u64().is_some(), "from missing: {item}");
        assert!(item["to"].as_u64().is_some(), "to missing: {item}");
        assert!(
            item["from_hex"].as_str().unwrap_or("").starts_with("0x"),
            "from_hex missing: {item}"
        );
        let kind = item["kind"].as_str().expect("kind");
        assert!(
            ["call", "jump", "data", "read", "write"].contains(&kind),
            "unknown xref kind {kind:?}"
        );
        assert!(item["instruction"].is_string(), "instruction missing: {item}");
        assert!(
            item["from_function"].is_null() || item["from_function"].is_string(),
            "from_function malformed: {item}"
        );
    }

    // A conflicting selector is an INVALID_PARAMETER envelope, not a crash.
    let (status, body) = http_request(
        port,
        "POST",
        "/api/decx/get_function_source",
        Some(r#"{"name": "main", "address": "0x1000"}"#),
    );
    assert_eq!(status, 400, "conflicting selector: {body}");
    let error: serde_json::Value = serde_json::from_str(&body).expect("error JSON");
    assert_eq!(error["ok"], false);
    assert_eq!(error["error"]["code"], "INVALID_PARAMETER");

    terminate(&mut child);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.try_wait().expect("wait for server exit") {
            Some(status) => {
                assert_eq!(
                    status.code(),
                    Some(0),
                    "kuna-server did not exit cleanly on SIGTERM: {status}"
                );
                break;
            }
            None if Instant::now() > deadline => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("kuna-server ignored SIGTERM");
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

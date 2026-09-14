//! kuna-server: the DECX HTTP engine server for the kuna decompiler.
//!
//! The Go CLI (`decx kuna <command>`) spawns this binary with a target file and
//! a port, then POSTs flat JSON to `/api/decx/<endpoint>`. The engine is
//! bootstrapped once at startup (parse the object, commit analysis, classify
//! entries, build the xref index) and requests are handled sequentially through
//! a mutex — the CLI is strictly sequential, so no concurrency machinery is
//! needed. The HTTP/1.1 layer is hand-rolled over `std::net::TcpListener`.

pub mod args;
pub mod engine;
pub mod handlers;
pub mod http;

/// Crate version, reported at startup and in `/health`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

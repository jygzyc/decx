//! kuna-server entry point: parse args, resolve specs, bootstrap the engine
//! once, then serve DECX HTTP requests until SIGINT/SIGTERM.

use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kuna_server::args;
use kuna_server::engine::Engine;
use kuna_server::handlers::{self, ApiError};
use kuna_server::http::{self, HttpResponse, RequestError};

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", args::USAGE);
        return;
    }
    let parsed = match args::parse_args(&argv) {
        Ok(parsed) => parsed,
        Err(error) => exit_with_error(&error),
    };

    if !parsed.target.is_file() {
        exit_with_error(&format!(
            "target file {} does not exist",
            parsed.target.display()
        ));
    }
    if let Some(slice) = &parsed.slice {
        // Must be exported before bootstrap: the Mach-O fat loader reads it
        // when it picks a slice (kuna's `--slice` equivalent).
        std::env::set_var(kuna_analysis::loader::macho_fat::SLICE_ENV, slice);
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let env_specs = std::env::var_os("KUNA_SPECS")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from);
    let specs_root =
        match args::resolve_specs_root(parsed.specs.as_deref(), env_specs.as_deref(), &exe_dir) {
            Ok(root) => root,
            Err(error) => exit_with_error(&error),
        };

    let target = parsed.target.display().to_string();
    let specs = specs_root.display().to_string();
    eprintln!("kuna-server: loading {target} (specs={specs}) ...");
    let startup = Instant::now();
    let engine = match Engine::build(
        &target,
        &specs,
        parsed.mode.as_deref(),
        parsed.language.as_deref(),
    ) {
        Ok(engine) => engine,
        Err(error) => exit_with_error(&error),
    };
    let startup_ms = startup.elapsed().as_millis();
    eprintln!(
        "kuna-server: version={} target={} specs={} functions={} mode={} language={} startup_ms={}",
        kuna_server::VERSION,
        target,
        specs,
        engine.entries.len(),
        engine.mode,
        engine.language.unwrap_or("null"),
        startup_ms
    );

    let shutdown = Arc::new(AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        if let Err(error) = signal_hook::flag::register(signal, Arc::clone(&shutdown)) {
            eprintln!("kuna-server: warning: cannot install handler for signal {signal}: {error}");
        }
    }

    let listener = match TcpListener::bind((parsed.host.as_str(), parsed.port)) {
        Ok(listener) => listener,
        Err(error) => exit_with_error(&format!(
            "cannot bind {}:{}: {error}",
            parsed.host, parsed.port
        )),
    };
    if let Err(error) = listener.set_nonblocking(true) {
        exit_with_error(&format!("cannot make the listener non-blocking: {error}"));
    }
    eprintln!("listening on {}:{}", parsed.host, parsed.port);

    // DECX clients (the Go CLI) issue strictly sequential requests, so a single
    // accept → handle → close loop is the whole concurrency story. The mutex
    // exists to hand out `&mut Engine` safely and is uncontended by construction.
    let engine = Mutex::new(engine);
    loop {
        if shutdown.load(Ordering::SeqCst) {
            eprintln!("kuna-server: received shutdown signal, exiting");
            std::process::exit(0);
        }
        match listener.accept() {
            Ok((stream, _peer)) => handle_connection(&engine, &stream),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                eprintln!("kuna-server: accept failed: {error}");
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn exit_with_error(message: &str) -> ! {
    eprintln!("kuna-server: {message}");
    std::process::exit(1);
}

fn handle_connection(engine: &Mutex<Engine>, stream: &TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(300)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(300)));
    let Ok(reader_stream) = stream.try_clone() else {
        return;
    };
    let mut reader = std::io::BufReader::new(reader_stream);
    let request = match http::read_request(&mut reader) {
        Ok(request) => request,
        Err(RequestError::Closed) => return,
        Err(RequestError::Malformed(message)) => {
            let response = HttpResponse::json(
                400,
                handlers::error_body("error", &ApiError::invalid(message)),
            );
            let mut writer = stream;
            let _ = response.write_to(&mut writer);
            return;
        }
        Err(RequestError::Io(error)) => {
            if error.kind() != std::io::ErrorKind::UnexpectedEof
                && error.kind() != std::io::ErrorKind::ConnectionReset
            {
                eprintln!("kuna-server: request I/O error: {error}");
            }
            return;
        }
    };

    let (status, body) = {
        let mut guard = engine.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        handlers::handle(&mut guard, &request.method, &request.path, &request.body)
    };
    let response = HttpResponse::json(status, body);
    let mut writer = stream;
    if let Err(error) = response.write_to(&mut writer) {
        eprintln!("kuna-server: response write failed: {error}");
    }
    let _ = writer.flush();
}

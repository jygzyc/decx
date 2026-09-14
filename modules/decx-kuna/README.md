# kuna-server

DECX server module for [kuna](https://github.com/Noelo-Lab/kuna), a Rust
decompiler and analysis framework for native binaries. `kuna-server` wraps
kuna's in-process analysis/decompilation API in a small HTTP/JSON server that
the Go CLI talks to as `decx -m kuna <command>`.

kuna analyzes **ELF, PE and Mach-O** object files and executables. There is no
DEX/APK support here — Android targets stay on the `jadx` module.

## Layout

| Path | Role |
|---|---|
| `server/` | Rust crate, binary `kuna-server` (HTTP layer is hand-rolled on `std::net::TcpListener`) |
| `server/tests/integration.rs` | end-to-end test against the real engine over loopback TCP |
| `kuna/` | pinned upstream kuna git submodule (decompiler workspace + `.slaspec` sources) |
| `bin/kuna-server` | POSIX sh launcher template packaged into the archive |
| `build.sh` | builds the server + slacomp, compiles specs, packs the release archive |
| `.build/` | build scratch: slacomp target dir + a *copy* of the specs tree (the submodule stays clean) |
| `dist/` | release archives |

## Requirements

- Rust 1.90+ (kuna's `rust-version`); tested with 1.93.1
- Network access on the first build (crates.io fetch; nothing is vendored)
- `git` to initialize the submodule
- `zip` for packing (falls back to `python3` when `zip` is absent)

## Build

```sh
git submodule update --init modules/decx-kuna/kuna
cd modules/decx-kuna
./build.sh
```

`build.sh` does, in order:

1. `cargo build --release --manifest-path server/Cargo.toml` (target dir `server/target`)
2. `cargo build --release --locked -p kuna-slacomp --target-dir .build/target` in
   kuna's decompiler workspace, then compiles every `.slaspec` with
   `.build/target/release/slacomp -a .build/specs` **on a copy** of `kuna/specs`.
   `--locked` guarantees the submodule's `Cargo.lock` is never rewritten, and the
   specs copy keeps slacomp from touching the pinned tree.
3. stages `.build/pack/` and packs `dist/kuna-server-<version>-<os>-<arch>.zip`,
   where `<version>` is the repo-root `version` file and `<os>/<arch>` use Go's
   `runtime.GOOS`/`runtime.GOARCH` naming (`darwin|linux|windows`,
   `amd64|arm64`) because the DECX installer substitutes those tokens.

Environment knobs:

| Variable | Default | Meaning |
|---|---|---|
| `SKIP_SPECS` | unset | `1` reuses an existing `.build/specs` (skips slacomp build + spec compile) |
| `PACK_VERSION` | repo-root `version` | version component of the archive name |
| `OUT_OS` | `uname -s` | `darwin`, `linux` or `windows` |
| `OUT_ARCH` | `uname -m` | `amd64` or `arm64` |
| `OUT_DIR` | `<script dir>/dist` | archive output directory |

Skip the (slow) spec compile while iterating on the server with `SKIP_SPECS=1 ./build.sh`.

## Archive layout

```
bin/kuna-server    POSIX sh launcher (resolves itself through symlinks, pins KUNA_SPECS to specs/)
kuna_server        compiled Rust server
specs/             slacomp-compiled SLEIGH specs (platform-independent; ~148 .sla files)
LICENSE, NOTICE    from the pinned kuna submodule
UPSTREAM.md        submodule revision + dirty flag + exact build commands + pack timestamp
```

## Run

```sh
<extracted>/bin/kuna-server <target-file> --port 45999
```

or run the binary directly (it then resolves specs itself):

```sh
kuna_server <target-file> --port 45999 [--specs <dir>]
```

```
kuna-server <target-file> --port <port> [--specs <dir>]
            [--mode <auto|reliable|aggressive|fast>]
            [--language <c-language|rust-language|auto>]
            [--slice <name>] [--host 127.0.0.1]
```

- `--mode` defaults to `reliable`. `auto` selects by target size via kuna's
  `resolve_mode_for_size` (`aggressive` for small files, `reliable` in the
  middle, `fast` for large ones).
- `--language` defaults to auto-detection from compiler metadata (may resolve
  to `null`); explicit values select kuna's C or Rust print language.
- `--slice` selects a slice of a Mach-O universal (fat) binary by setting
  `KUNA_MACHO_SLICE` before bootstrap.
- Specs root precedence: `--specs` > `KUNA_SPECS` > `<exe_dir>/specs` >
  `<exe_dir>/../specs`. The chosen tree must contain at least one compiled
  `.sla`; a tree with only `.slaspec` sources is rejected with a hint to run
  `./build.sh`. All candidates missing is a startup error.
- On startup the server logs one line to stderr:
  `kuna-server: version=… target=… specs=… functions=… mode=… language=… startup_ms=…`
  followed by `listening on <host>:<port>`. `SIGTERM`/`SIGINT` exit 0.
- The target is analyzed once at startup; requests are served sequentially
  (one connection at a time). The DECX CLI issues one call at a time, so this
  is sufficient and keeps the engine state lock-free per request.

## HTTP API

Requests are `POST http://<host>:<port>/api/decx/<endpoint>` with a flat JSON
body. Success responses share one envelope:

```json
{"ok": true, "kind": "<route kind>", "query": {…echoed request…},
 "summary": {…}, "items": [ … ], "page": {"limit": …, "offset": …, "returned": …}}
```

Errors use:

```json
{"ok": false, "kind": "<route kind or \"error\">",
 "error": {"code": "…", "message": "…"}}
```

with codes `INVALID_PARAMETER` (400: bad JSON, missing/conflicting selector,
unknown direction, bad regex), `FUNCTION_NOT_FOUND` (404), `UNKNOWN_ENDPOINT`
(404), `METHOD_NOT_ALLOWED` (405), `INTERNAL_ERROR` (500).

### `GET /health`

`{"ok":true,"status":"running","version":"0.1.0","binary":"…","functions":13,"mode":"reliable","language":null}`

### `POST /api/decx/get_functions`

Request:

| Field | Type | Meaning |
|---|---|---|
| `name_contains` | string | simple case-aware substring pre-filter |
| `includes` | string[] | patterns a name must match |
| `excludes` | string[] | patterns that reject a name |
| `case_sensitive` | bool (default `false`) | matching case mode |
| `regex` | bool (default `false`) | `false`: patterns are substrings; `true`: regex |
| `limit` | int (default `100`) | page size |
| `offset` | int (default `0`) | page offset |

Response: `summary` = `{binary, count, total}`; `items[]` =
`{name, address, address_hex, aliases[], size, kind, object_location}` where
`kind` is `func`, `plt` or `thunk`; `page` = `{limit, offset, returned}`.

### `POST /api/decx/get_function_source`

Request — exactly one of `name` / `address` is required:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | function name or alias (kuna `EntrySelector` syntax accepted) |
| `address` | string | virtual address, `0x…` hex or decimal |
| `limit` | int | truncate `code` to N lines (sets `summary.truncated`) |

Response: `summary` =
`{binary, name, address, address_hex, size, language, mode, lines, truncated}`;
`items[0]` =
`{name, address, address_hex, size, code, error, variables[], line_mappings[], aliases[], object_location}`.
`variables[]` = `{name, type, kind, arg_index, stack_offset, size}`;
`line_mappings[]` = `{line_number, addresses[]}`.

### `POST /api/decx/get_function_xref`

Request — exactly one of `name` / `address` is required:

| Field | Type | Meaning |
|---|---|---|
| `name` / `address` | string | selector, as above |
| `direction` | `"callers"` \| `"callees"` | required |
| `kinds` | string[] | keep only `call`, `jump`, `data`, `read`, `write` |
| `limit` | int | cap the item count |

Response: `summary` = `{binary, name, address, address_hex, direction, count}`;
`items[]` = `{from, from_hex, to, to_hex, kind, instruction, from_function, from_function_hex}`
where `from_function`/`from_function_hex` name the enclosing function when the
source address resolves to one, else `null`.

## Environment variables

| Variable | Meaning |
|---|---|
| `KUNA_SPECS` | specs root used at startup when `--specs` is absent (the archive launcher always pins it to the bundled `specs/` tree) |
| `KUNA_MACHO_SLICE` | Mach-O fat-binary slice selector; set automatically by `--slice` |

## Tests

```sh
cargo test --manifest-path server/Cargo.toml
```

Unit tests cover argument parsing, specs-root resolution, flat-JSON request
validation, name filtering, envelope construction and HTTP parsing. The
integration test in `server/tests/integration.rs` boots the real server over
loopback TCP against `kuna/integrations/web/test/fixtures/sample.elf` and
asserts `/health`, `get_functions`, `get_function_source` and
`get_function_xref`, plus a 400 on conflicting selectors and clean `SIGTERM`
shutdown. It needs compiled specs (`.build/specs`, or `KUNA_SPECS`); when they
are absent it prints a skip message and passes instead of failing.

## Known limits (v1)

- No DEX/APK analysis — use the `jadx` module for Android targets.
- No per-request mode/language switching: mode and language are fixed at
  startup.
- Single-threaded request handling by design (one connection at a time).
- `--slice` is the only extra loader knob exposed; kuna's other load-time
  switches (arm64e handling) are applied automatically by the mode policy.
- `get_functions` filters names only; there is no kind/size filter yet.

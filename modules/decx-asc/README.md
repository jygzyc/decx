# asc-server

Stdlib-only HTTP adapter that exposes [ASC](https://github.com/MG1937/ASC) as a
DECX server module. ASC is a pure-Python, on-demand APK analyzer (R8-aware findrefs and
class decompilation, no JVM); upstream ships a CLI/GUI only, so `asc_server.py`
is new DECX code that drives ASC's Python API in-process and speaks the DECX
engine protocol:

```
decx session open app.apk --engine asc     # or DECX_ASC_SERVER=... 
  -> asc-server app.apk --port <n>
  -> GET /health  must return {"status":"running"}
  -> POST /api/decx/<route>
```

Engine launch contract (DECX Go client): `<binary> <target-file> --port <port>`,
`GET /health` polled until ready, JSON POSTs under `/api/decx/`.

## Layout

```
modules/decx-asc/
  asc_server.py        the adapter (stdlib only; ASC imports happen in main())
  bin/asc-server       POSIX sh launcher: venv bootstrap + exec
  asc/                 pinned ASC tree — git submodule (src/, main.py, requirements.txt, LICENSE)
  build.sh             packs dist/asc-server-<version>.zip from the submodule
  VERSION              adapter version (must match ADAPTER_VERSION in asc_server.py)
  tests/test_asc_server.py
  .build/              local build dir (venv, pack staging, e2e; gitignored)
  dist/                packed archives (gitignored)
```

Packed archive layout (`asc-server-<version>.zip`):

```
bin/asc-server         launcher (entry point; executable)
asc_server.py          the adapter
asc/src/...            pinned upstream ASC source (submodule tree, unmodified)
asc/main.py, README.md, LICENSE, requirements.txt
UPSTREAM.md            submodule URL, revision, dirty flag, build provenance
```

## Requirements

- Python **3.11 or 3.12** (`python3.12` preferred) with a working `python3 -m venv`.
- Network access on first run: the launcher creates `venv/` next to `asc/` and
  `pip install`s `asc/requirements.txt` (`androguard==4.1.3` plus its heavy
  transitive tree). This is a one-time cost, typically 1–3 minutes and
  ~250–350 MB installed. A `.venv-ready` marker (containing a checksum of
  `requirements.txt`) is written only after a successful install; the install is
  retried when the requirements file changes.
- No Java, no system tools, no Tk (GUI not used).

## Build / pack

ASC is vendored as the git submodule `modules/decx-asc/asc`, so nothing is
cloned or downloaded at build time and the packed tree is exactly the pinned
revision:

```sh
 git submodule update --init modules/decx-asc/asc   # first checkout only
cd modules/decx-asc
./build.sh
```

Environment knobs:

| Variable | Default | Purpose |
|---|---|---|
| `ASC_ROOT` | `modules/decx-asc/asc` (the submodule) | ASC checkout to pack (must contain `src/asc_client/apk_handler.py`). |
| `OUT_DIR` | `modules/decx-asc/dist` | Output directory. |

Output: `dist/asc-server-<version>.zip` with the layout above. `build.sh` fails
if `VERSION` and `ADAPTER_VERSION` in `asc_server.py` disagree, records the
submodule revision (and a dirty-tree warning) in `UPSTREAM.md`, and never
touches the submodule itself. Bumping ASC is a normal submodule update:

```sh
git -C modules/decx-asc/asc fetch && git -C modules/decx-asc/asc checkout <rev>
git add modules/decx-asc/asc   # commit the new gitlink
```

## Install

```sh
decx install --module asc        # downloads asc-server-<version>.zip into module storage
decx session open app.apk --engine asc
```

The archive is extracted under `$DECX_HOME/modules/asc` (`bin/asc-server` is the
entry point), so the same layout can be produced by hand:

```sh
DECX_HOME=${DECX_HOME:-$HOME/.decx}
mkdir -p "$DECX_HOME/modules/asc"
unzip -o modules/decx-asc/dist/asc-server-<version>.zip -d "$DECX_HOME/modules/asc"

# the launcher creates $DECX_HOME/modules/asc/venv on first run
export DECX_ASC_SERVER="$DECX_HOME/modules/asc/bin/asc-server"
"$DECX_ASC_SERVER" /path/to/app.apk --port 39001
```

`DECX_ASC_SERVER` overrides the server binary path for the DECX CLI
(`registry/binary.go` resolution order: env -> `$DECX_HOME/modules/asc` ->
checkout root -> absolute -> next to the CLI -> `PATH`).

The launcher can also be exercised directly from a staging directory as long as
the layout holds (`<root>/bin/asc-server` + `<root>/asc_server.py` +
`<root>/asc/src/...`; the adapter resolves `asc/` next to itself, then walks up
for a sibling `ASC`/submodule checkout, or accepts `--asc-root` / `ASC_ROOT`).

## Routes

Server args: `<target-file> --port <n> [--threads N] [--concurrency N] [--debug]`.
Binds `127.0.0.1` only and prints `asc-server listening on port <n>` after binding.
`--threads` (default 4) is ASC's per-call worker count (`ApkHandler(max_workers=…)`);
`--concurrency` (default 2) bounds concurrent ASC calls server-wide with a
semaphore, because every findrefs call spawns a process pool.

Success envelope:

```json
{"ok": true, "kind": "...", "query": {...}, "summary": {...}, "items": [...], "page": {...}}
```

Error envelope (HTTP status matches the code family):

```json
{"ok": false, "kind": "...", "error": {"code": "UPPER_SNAKE", "message": "..."}}
```

Codes: `INVALID_PARAMETER` (400), `CLASS_NOT_FOUND` (404), `UNKNOWN_ENDPOINT`
(404), `METHOD_NOT_ALLOWED` (405), `INTERNAL_ERROR` (500).

### `GET /health`

```json
{"ok": true, "status": "running", "engine": "asc", "version": "0.1.0", "target": "/abs/app.apk"}
```

`"status":"running"` is what DECX readiness polls for.

### `POST /api/decx/get_class_source`

Body: `{"cls": "com.example.Foo", "filter": {"limit": 40}}` (limit optional;
caps returned source lines). `cls` accepts dotted (`com.example.Foo`) or Dalvik
form (`Lcom/example/Foo;`).

```json
{
  "ok": true,
  "kind": "class_source",
  "query": {"cls": "com.example.Foo"},
  "summary": {"dex": "classes.dex", "total_lines": 120, "returned_lines": 40, "truncated": true},
  "items": [{"name": "Lcom/example/Foo;", "code": "public class Foo {\n...", "error": null}],
  "page": {"index": 1, "size": 40, "has_next": true}
}
```

`code` is ASC's real `AscHandler.getclass` output (androguard DAD), never
fabricated. A class that ASC cannot find yields
`404 CLASS_NOT_FOUND`.

### `POST /api/decx/find_refs`

Body: `{"query": "token", "type": "string|type|method|field", "filter": {"limit": 50}}`.
Optional `cls` and `fuzzy_class` (method/field only) mirror ASC's CLI
`findrefs --class … --fuzzy-class`; `cls` is rejected for string/type queries.
`query` is the ASC value: a **regex** for `string`/`type` (validated here with a
bytes `re.compile`, length ≤ 4096) and a substring for `method`/`field`.

```json
{
  "ok": true,
  "kind": "find_refs",
  "query": {"query": "token", "type": "string", "cls": null, "fuzzy_class": false},
  "summary": {"count": 2},
  "items": [
    {"dex": "classes.dex", "method": "Lcom/x/Y;->a()", "matched": ["token"],
     "line": "classes.dex | Lcom/x/Y;->a() | matched=(token)"}
  ],
  "page": {"index": 1, "size": 2, "has_next": false}
}
```

`items` map ASC's real findrefs fields (dex entry, referencing
`class->method`, matched names) and keep the raw upstream line verbatim. An
empty result is a success with `items: []`.

## Tests

Unit tests need only a stdlib Python (no androguard). From `modules/decx-asc`:

```sh
python3 -m unittest discover -s tests -v
```

They cover class-name normalization, find-query construction (exact upstream
shapes), request validation (bad type, invalid regex, oversized input, limits),
exception mapping and all HTTP envelopes/status codes using fake ASC handlers.

End-to-end check against a real APK (the checked-in
`decx/tests/fixtures/sieve.apk`):

```sh
cd modules/decx-asc
./build.sh                                    # writes dist/asc-server-<version>.zip

# stage the archive and start it (first run creates venv/ + pip-installs)
rm -rf .build/e2e && mkdir -p .build/e2e
unzip -q dist/asc-server-<version>.zip -d .build/e2e
# optional shortcut for repeated runs: reuse the launcher venv
[ -d .build/venv ] && cp -al .build/venv .build/e2e/venv
.build/e2e/bin/asc-server "$PWD/../decx/tests/fixtures/sieve.apk" --port 39011 &

# exercise it
curl -s http://127.0.0.1:39011/health
curl -s -X POST http://127.0.0.1:39011/api/decx/get_class_source \
     -H 'Content-Type: application/json' \
     -d '{"cls":"com.withsecure.example.sieve.activity.MainLoginActivity","filter":{"limit":15}}'
curl -s -X POST http://127.0.0.1:39011/api/decx/find_refs \
     -H 'Content-Type: application/json' \
     -d '{"query":"m_MainLogin","type":"string"}'
kill %1
```

## Known limitations

- **Windows unproven.** Upstream ASC itself is only CI-tested on Linux, ASC
  disables `fork` process pools on Windows, and this launcher is a POSIX `sh`
  script. macOS and Linux are the supported targets.
- **Dependency weight.** `pip install -r requirements.txt` pulls the full
  androguard dependency tree (frida, matplotlib, ipython, cryptography, …) even
  though ASC stubs most of it at import time; budget hundreds of MB and a slow
  first run. A trimmed install was not verified.
- **Process-pool cost per findrefs call.** ASC builds a fresh
  `ProcessPoolExecutor` per call, and because the HTTP server is multi-threaded
  ASC's `fork` fast path is skipped (its `_process_pool_context()` refuses to
  fork from a threaded parent), so workers are spawned instead. The server
  semaphore (`--concurrency`, default 2) bounds how many pools exist at once;
  findrefs calls remain heavier than decompiles.
- **Regex semantics.** string/type queries are compiled over the DEX MUTF-8
  byte stream, so patterns are case-sensitive bytes regexes with active
  metacharacters. The adapter validates them with a bytes `re.compile` and caps
  their length, but does not sandbox catastrophic backtracking (ASC has the same
  exposure).
- **No APK index.** Only the two routes above are implemented. `get_classes`,
  `search_method` and similar would require ASC's GUI `GuiDexStore` full-dex
  inflate, which contradicts ASC's on-demand design.
- **Archive install path unverified end to end.** `decx install --module asc`
  is wired in the registry (`asc-server-{version}.zip` release asset, `format:
  zip`, `binary: bin/asc-server`, installed under `$DECX_HOME/modules/asc`) and
  the archive is built and run manually, but install → `decx session open --engine asc` has not
  been exercised in one run (it needs a published asset).

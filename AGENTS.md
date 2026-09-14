# AGENTS.md

Coding agent instructions for the DECX repository.

## Repository Purpose

### Active Go migration

This branch is Go-only: the TypeScript client sources were removed and the CLI
lives under `decx/cmd/decx` and `decx/internal/`; see root `MIGRATION.md`
for the remaining work. The published npm package still serves the last
TypeScript release until the Go client replaces it, so `README.md` and
`README_zh.md` still document that older surface.
The Go client is driven by self-describing `decx.json` manifests:
`registry.Load(home, extraDirs...)` scans `$DECX_HOME/modules/<id>/decx.json`;
an explicit leading `--config <path>` adds that path (plus its `modules/`, and
the legacy `bin/` or `plugins/` layouts) as an extra scan root, and the nearest
`modules/` (servers) or `plugins/` (plugins) directory of a source checkout
works without installing it, as long as the module's build output exists
(`modules/decx-kuna/bin/kuna-server`, `modules/decx-asc/bin/asc-server`,
`plugins/ard-framework/dist/`, `modules/decx-jadx/jadx-server.jar` for the JVM
server). There is no registry file in DECX_HOME and no `self init`: `decx self`
only has `update` and `skills`. A compiled-in known-module table
(`decx/internal/registry/known.go`) fills in modules that are not present
locally, so a fresh machine can run `decx install --module jadx`; it carries no
command tree, and a present manifest always wins. Every server and plugin is a
module, selected per invocation with the global flag as
`decx -m <module> <command>` (`decx -m jadx classes …`,
`decx -m ard-framework framework …`); `decx -m <module>` alone prints the
module's command list, and the names `session`, `module`, `plugin`,
`self`, `install`, `settings`, `help` are reserved for the CLI itself.
`module list` reports every discovered module with its install state, version
and release source, and command help plus HTTP requests are driven by the
manifests. `session open/list/check/close` manages persistent server processes; module `launch.stop` commands run before termination, with plain process termination as the fallback;
tool calls auto-select the only healthy compatible session or accept `--session`
or a direct `--port`. Session records use `sessions-v1.json` under DECX_HOME,
with an OS file lock and atomic replacement; process ownership includes PID and
creation time. Timeout retains live session records. The default module is
`jadx`, launching `jadx-server.jar`; `DECX_JADX_SERVER` overrides its path.
Run `go test -race ./...`, `go vet ./...` and
`go build ./cmd/decx` from `decx/` to validate this implementation.

DECX (`Decompiler + X`) is an AI-oriented analysis layer built on top of JADX.
The repository contains:

- A Kotlin HTTP analysis server shared by plugin mode and standalone mode
- A JADX GUI plugin that starts the DECX server and an in-process Kotlin MCP server
- A standalone `jadx-server` fat JAR for headless analysis
- A Go CLI (`decx/`) that starts and talks to `jadx-server`
- AI skill definitions under `skills/` for DECX-driven analysis workflows

Primary request flow:

```text
AI Assistant / CLI
  -> MCP or direct HTTP
  -> DECX HTTP server
  -> DecxApi
  -> JADX decompiler state
```

## Repository Layout

| Path | Stack | Role |
|---|---|---|
| `modules/decx-jadx/core/` | Kotlin, JVM 17 | Shared API, HTTP transport, services, models, utilities |
| `modules/decx-jadx/plugin/` | Kotlin, Shadow JAR | JADX GUI plugin, lifecycle, UI, in-process MCP server management |
| `modules/decx-jadx/` | Kotlin, Shadow JAR | Standalone headless server with `JadxServerApp` main class |
| `decx/` | Go 1.25+ (`gofrs/flock`, `buke/quickjs-go` (cgo), `shirou/gopsutil`) | User CLI for session management, module commands and Android workflows |
| `plugins/ard-framework/` | TypeScript + esbuild (dev-only npm deps) | In-process plugin module (run by the CLI's embedded JS engine) providing Android device + framework workflows under `decx -m ard-framework` |
| `modules/decx-asc/` | Python 3.11/3.12 + ASC git submodule (`asc/`) | Optional `asc` server module: stdlib HTTP adapter over ASC, packed as a zip release asset |
| `modules/decx-kuna/` | Rust (Kuna git submodule `kuna/`) | Optional `kuna` server module: native ELF/PE/Mach-O decompiler server, packed as a per-platform zip release asset |
| `skills/decx-cli/` | Skill `decx-cli` | DECX CLI usage, general analysis, and workflow routing |
| `skills/decx-vulnhunt/` | Skill `decx-vulnhunt` | Android vulnerability hunting workflow (App + Framework tracks) |
| `skills/decx-report/` | Skill `decx-report` | Report generation from finalized DECX analysis graph findings |
| `skills/decx-poc/` | Skill `decx-poc` | PoC app construction workflow |

## What Is Actually Implemented

### Kotlin server capabilities

`modules/decx-jadx/core` exposes these HTTP endpoints through `DecxRoutes` and `RouteHandler`:

- Common code analysis:
  `get_classes`, `get_class_context`, `get_class_source`, `search_global_key`, `search_class_key`,
  `search_method`, `get_method_source`, `get_method_context`, `get_method_cfg`, `get_method_xref`, `get_field_xref`,
  `get_class_xref`, `get_implementations`, `get_subclasses`
- Android app analysis:
  `get_aidl_interfaces`, `get_app_manifest`, `get_main_activity`, `get_application`,
  `get_exported_components`, `get_deep_links`, `get_dynamic_receivers`,
  `get_all_resources`, `get_resource_file`, `get_strings`
- Android framework analysis:
  `get_system_service_impl`
- Health endpoint:
  `GET /health`

### Plugin responsibilities

The JADX plugin does more than just expose the server:

- Waits until the decompiler is ready before creating DECX services
- Initializes preferences and server port
- Starts the embedded DECX HTTP server
- Starts and stops the in-process Kotlin MCP HTTP server on `serverPort + 1`
- Provides UI and restart hooks through `DecxUIManager`
- Bounds decompiler memory on headless servers: a byte-capped LRU code cache (`decx.decompile.cacheMaxBytes` → default `min(4G, -Xmx/2)`) plus a backpressured daemon that unloads evicted classes; see `DecompileGuard`

### CLI responsibilities

#### Go client (active migration)

The Go client registers every server and plugin as a module behind one global selector flag, so one executable serves every backend:

- `decx -m <module> <command>` — server module commands (shipped servers: `jadx` (default), `asc` and `kuna`) and runtime plugin workflows (shipped plugin: `ard-framework`, providing `device …` and `framework …`); `decx -m <module>` alone prints the module's command list and `decx -m <module> <command> --help` prints the arguments a command takes
- `decx session open|list|check|close` — persistent server processes; `session open --module <id>` selects which server module backs the session
- `decx module list` — one JSON row per discovered module (`id`, `kind`, `description`, `default`, `installed`, `path`, `version`, `installable`, `source`)
- `decx install` / `decx self update` — download modules into `$DECX_HOME/modules` from the `release` block of each module's own `decx.json` manifest (`--module <id|repo|path>`, `--all`, `--prerelease`, `--force`); a bare `decx install` installs every module that declares a release source (`--all` is the explicit form of that), so the known table's missing modules (`jadx`, `asc`, `kuna` and the `ard-framework` plugin) come in as well, while a bare `decx self update` only refreshes what is installed. `decx self update --cli` additionally replaces the running `decx` executable with the newest `decx-cli-{version}-{os}-{arch}` release archive (skipped when the running version already matches; `--force` overrides, `--prerelease` selects prereleases). The registry is manifest-driven and offers no backward compatibility for it:
  - There is no catalog file and no `self init`: `registry.Load` scans `$DECX_HOME/modules/<id>/decx.json`. A compiled-in known-module table (`decx/internal/registry/known.go`: `jadx` (default), `asc`, `kuna` and `ard-framework` (default)) fills in modules that are not present locally so a fresh machine can run `decx install --module jadx`; it carries no command tree, and an installed manifest always wins.
  - A module's definition — runtime and release — lives in its own `decx.json` manifest (`{"manifest":1,"kind":"server|plugin","id":…,"entry"` for plugins, `"binary"`/`"launch"` for servers, plus the command tree and a `"release"` block) next to a `VERSION` file. Servers and plugins install under the same `$DECX_HOME/modules/<id>` root; a module is runnable only with such a manifest, otherwise `decx -m <module> …` answers ``module <id> is not installed; run `decx install --module <id>` ``. A manifest that does not parse is skipped and reported as a warning, so `decx install --force` can repair it.
  - An explicit `--module` source is classified in order: a module id (installed/checkout/known-table) refreshes from the manifest's release block; an existing directory or `.zip`/`.tar.gz` archive is imported; a repository (`owner/repo[@ref]`, `github.com/owner/repo`, `https://host/owner/repo`) is downloaded and imported. The imported tree must carry `decx.json` at its root or as its single top-level directory. Repository and path imports record their origin in `<module>/.decx-source.json`, which `decx self update` re-imports from; a release install clears the record.
  - A source checkout is usable without installing it when the module's build output exists (`modules/decx-kuna/bin/kuna-server`, `modules/decx-asc/bin/asc-server`, `plugins/ard-framework/dist/`, `modules/decx-jadx/jadx-server.jar`): the explicit `--config <dir>` (plus its `modules/` and the legacy `bin/`/`plugins/`), the executable directory and the working directory are scanned, and the nearest `modules/` (servers) or `plugins/` (plugins) directory above them is searched for module manifests; installed modules win over checkouts.
  - The `release` block (`source: "repo"`, `repository` defaulting to `jygzyc/decx`, `tag` containing `{version}`, `asset`/`asset_fallbacks` naming archives with `{version}` and optional `{os}`/`{arch}`, `checksums` and `format`) installs an archive that must carry `decx.json` and `VERSION`, and every release install verifies the SHA-256 listed in the checksums asset; `--prerelease` is a CLI flag, not a manifest field.
- Release: each component publishes from its own tag through its own workflow — `jadx-server-v*`, `asc-server-v*`, `kuna-server-v*`, `ard-framework-v*` in `.github/workflows/release-<component>.yml` — which checks the tag against the component's `VERSION` file, builds its archive and uploads it with a `SHA256SUMS` asset; the CLI archives keep publishing from `.github/workflows/release-cli.yml` on `v*` tags. Asset templates take `{version}` (the resolved release version, mandatory) plus `{os}`/`{arch}` (Go's `runtime.GOOS`/`GOARCH`) so one component can publish per-platform archives; `asset_fallbacks` accept the same tokens. Servers stop through `launch.stop`: `"terminate"` (default) ends the process, a command list runs first for a graceful shutdown with `{pid}`/`{port}`/`{binary}`/`{home}`/`{target}` substituted, and termination remains the fallback when the command fails or the server survives it. A component without its own `repository` in its `release` block falls back to the compiled-in default `jygzyc/decx`, and prereleases are selected with the CLI flag `--prerelease` rather than a manifest field.

The device and framework commands (`device system-services|permission-info`, `framework collect|process`, reached as `decx -m ard-framework …`) live in the `ard-framework` plugin under `plugins/ard-framework` (TypeScript, bundled by esbuild into the single self-contained file `dist/ard-framework.js` the registry points at): the CLI evaluates that file in an embedded QuickJS engine (`quickjs-go`, linked through cgo) running in-process and calls the global `handle(request)` with one JSON request, then reads one JSON response. The bundle is platform independent and installs from the `decx-ard-framework-plugin-{version}.zip` release asset into `$DECX_HOME/modules/ard-framework` (`decx install`, since every shipped module declares a release source); CLI archives carry no plugin files. There is no module loader — host modules come from the `decx` global (`fs`, `path`, `os`, `child_process`, `crypto`, `protocol`, `pluginDir`) the runtime installs, and the build aliases the sources' bare Node imports to shims that read it. `framework process` only writes the packed jar and reports its path, so session ownership stays in the Go CLI. No native binaries ship with the CLI any more; the plugin parses ext4 and EROFS payload images natively and only falls back to system `debugfs`/`erofs-utils` from `PATH` (Linux/macOS) for unsupported features.

The `asc` server module is a pure-Python adapter in `modules/decx-asc/` for [ASC](https://github.com/MG1937/ASC) (on-demand DEX analysis, no JVM). ASC is vendored as the git submodule `modules/decx-asc/asc` (pinned gitlink; upstream bumps are submodule checkouts), `asc_server.py` adds that tree to `sys.path` and drives the upstream client API in-process, `bin/asc-server` bootstraps a venv from `asc/requirements.txt` and execs the adapter, and `build.sh` packs `dist/asc-server-<release-version>.zip` (layout `bin/asc-server`, `asc_server.py`, `asc/`, `UPSTREAM.md`) without touching the submodule. The registry installs that zip under `$DECX_HOME/modules/asc` (its `decx.json` names `binary: bin/asc-server`, env `DECX_ASC_SERVER`) through the `asc-server-v*` workflow.

The `kuna` server module is a Rust adapter in `modules/decx-kuna/server/` over [Kuna](https://github.com/Noelo-Lab/kuna) (native ELF/PE/Mach-O decompilation to pseudo-C; no DEX/APK — that stays on `jadx`). Kuna is vendored as the git submodule `modules/decx-kuna/kuna` (pinned gitlink, Apache-2.0) and the server crate path-depends on its `decompiler/` workspace crates (`kuna-console`, `kuna-analysis`, `kuna-decomp`, `kuna-base`) instead of shelling out: one bootstrap per process, then `get_functions`, `get_function_source` and `get_function_xref` over `std::net::TcpListener` with a hand-rolled JSON/HTTP layer (upstream ships no HTTP or serde stack). SLEIGH specs are compiled once by the submodule's `slacomp` into a copy of `kuna/specs` (never into the submodule) and shipped inside the archive; `build.sh` packs `dist/kuna-server-<release-version>-<os>-<arch>.zip` (layout `bin/kuna-server`, `kuna_server`, `specs/`, `LICENSE`, `NOTICE`, `UPSTREAM.md`) using Go's `runtime.GOOS`/`GOARCH` platform names, so `{os}`/`{arch}` asset templates resolve directly. The registry installs it under `$DECX_HOME/modules/kuna` (its `decx.json` names `binary: bin/kuna-server`, env `DECX_KUNA_SERVER`) through the `kuna-server-v*` workflow; `KUNA_SPECS` overrides the specs root at runtime.

#### Published npm client (TypeScript release)

The npm package `@jygzyc/decx-cli` still ships the TypeScript client described
here; the Go client covers the same workflows under `decx session …` and
`decx -m <module> …`. The bullets below stay accurate for the
published package until the release switch described in `MIGRATION.md`.

The CLI is session-oriented and can spawn standalone DECX server processes.
Current top-level commands are:

- `decx process`
- `decx code`
- `decx android`
- `decx self`

Notable details:

- `decx process open <file>` launches `java -jar jadx-server.jar ...`
- `decx process open <file>` starts the JVM with `-Xmx` set to 2/3 of machine memory rounded down
- `decx process open <file>` is also reused by `decx android framework open` and `decx android framework run`
- `decx process open <file> --script <s1.jadx.kts> [--script <s2.jadx.kts> ...]` runs Jadx Kotlin scripts during decompilation; scripts are passed to jadx-server as positional input files after the main target
- Scripts execute at decompile time (top-level code at load, `jadx.afterLoad { }` blocks after classes load); the server bundles the `jadx-script-kotlin` plugin
- Session reuse is keyed on the target file **plus** the exact script set; opening the same file with a different script set errors until `--force`
- `--force` replaces alive sessions matching the same name **or** the same file hash: their JVMs are killed with verified death before the new server starts. A failed kill aborts the spawn (session record kept, pid reported) instead of leaking orphan processes; `process close` keeps the record on failed kills too
- While waiting for the server to become healthy, `process open` prints a heartbeat to stderr roughly every 15s (elapsed time + last server log line); stdout stays JSON-only
- `process open --timeout <seconds>` bounds the health wait (default 300s). On timeout with the JVM still alive, the session record is **kept** and the error suggests `decx process check --port <port>` / `decx process close`; the record is only removed when the JVM exited
- Standard `jadx-cli` flags are passed through by `process open`
- `process open` auto-injects `--show-bad-code`, `--no-imports`, and `-Pdex-input.verify-checksum=no` (each skipped if already present), and intentionally strips `--deobf` because DECX relies on original symbol names
- `process open` also injects `--rename-flags case,valid` by default (skipped when the user passed `--rename-flags`/`-rf` in any form) and strips the `printable` token from user-supplied rename-flag values: jadx's default `printable` rename replaces non-ASCII obfuscated identifiers (e.g. `Ď锬볝觧`) with `m0`-style aliases in decompiled source, which breaks DECX's original-name contract (`all` is rewritten to `case,valid`; `none` and unparseable values pass through untouched)
- No DECX command binds `-P` to `--port`; `-P<key>=<value>` tokens are forwarded to jadx-cli by `process open` as JADX project properties. Use `--port` everywhere for the server port
- When `--port` is omitted, `process open` auto-assigns a free random port in `30000–40000` (checked for availability, retried on collision); the chosen port is recorded on the session
- CLI sessions are tracked locally and can be reused by session name and file hash
- `decx process close` can close by session name, by `--port <port>`, or all sessions with `--all`
- CLI data defaults to `~/.decx`; set `DECX_HOME` to redirect config, sessions, logs, tmp files, output, and installed server JARs
- CLI tests set `DECX_HOME` to `.decx_test/home/.decx` and keep test-only artifacts under `.decx_test/`
- `decx self install` installs or updates `jadx-server.jar`; the skip-if-current check reads the version baked into the installed jar (`version.properties`) and prefers it over the config record, so stale records or manually replaced jars are handled correctly
- `decx self skills install [--client <client>]` clones `https://github.com/jygzyc/decx.git` in-process through the embedded Go git implementation (`go-git`; no `git` binary is required), copies the `decx-*` skills (directories carrying `SKILL.md`) into `$DECX_HOME/skills`, and links them into the client's skill directory: `~/.codex/skills`, `~/.claude/skills`, `~/.cursor/skills` or the shared `~/.agents/skills` (default when `--client` is omitted; comma-separated and repeatable). Links are symlinks; Windows falls back to a junction and then to a copy. Implemented in `decx/internal/skills/skills.go` (`--client` accepts `codex`/`codex-cli`, `claude`/`claude-code`, `cursor`, anything else maps to the shared agents directory)
- `decx self update` updates both the server JAR and the currently installed npm CLI package
- On startup the CLI runs a non-blocking update check (`decx-cli/src/core/update-notifier.ts`): the latest version comes from the npm registry, results are cached in `DECX_HOME/update-check.json` for 24 hours, refreshes happen in a detached `__update-check` child process, and update hints go to stderr; disable with `DECX_NO_UPDATE_CHECK=1` (also skipped under `CI`)
- Framework processing is implemented in TypeScript under `plugins/ard-framework/src/` (bundled to `dist/ard-framework.js`, which the embedded JS engine loads) and runs in-process in the Go CLI (the published npm package still ships its own TypeScript copy under `decx-cli/src/android/`, which no longer exists here)
- The published package builds runtime JavaScript as two bundles: `dist/index.js` for the CLI and `dist/sdk/index.js` for SDK imports; its packaged native tools are stored as `dist/bin.tar.gz` (this repository no longer builds or ships either)
- The published package extracts its native tools to a cache directory gated by a `.native-tools.sha256` content-hash marker that cleans and re-extracts on upgrade
- `decx android framework` provides framework collection and preprocessing subcommands:
  `collect`, `process`, `run`, `open`
- `decx android device` provides adb-backed inspection commands:
  `system-services`, `permission-info`
- Framework collection is tiered: ready-made files first (`/system/framework`, the runtime `/apex` mount whose activated modules expose already-extracted `javalib` jars, `/vendor/framework`, `/system_ext/framework`), then `.apex`/`.capex` images from `/system/apex` only for modules `/apex` did not already cover (result field `skippedCoveredModules`). At process time, jars/dex under a source `apex/<module>/...` layout reuse the APEX post-extraction scheme (`<module>_`-prefixed dex outputs, `@version` dir suffixes stripped); `.apex` files keep going through payload-image extraction
- Zip/jar read-write operations are centralized in `plugins/ard-framework/src/zip-utils.ts` (published npm package: `decx-cli/src/android/zip-utils.ts`) and are cross-platform: Windows 10+ uses the bundled bsdtar (`C:\Windows\System32\tar.exe`, no `zip`/`unzip` dependency), other platforms use Info-ZIP `zip`/`unzip` from `PATH`
- ext4 `apex_payload.img` images are parsed natively (`plugins/ard-framework/src/ext4-reader.ts`: superblock → group descriptors → extents → dirents) and EROFS payloads are parsed natively as well (`plugins/ard-framework/src/erofs-reader.ts`, ported from the Rust branch's `android_sdk/erofs.rs`: zmap/LZ4/fragment/ztailpacking decoding, byte-exact against `fsck.erofs` on the committed fixture). Unsupported ext4/EROFS features fall back to `debugfs`/`extract.erofs`/`fsck.erofs` resolved from `PATH` (`DECX_DEBUGFS`, `DECX_EXTRACT_EROFS`, `DECX_FSCK_EROFS` override) — no bundled binaries and no WSL delegation; on Windows those tools do not exist, so unsupported payloads fail with platform guidance. Tools are resolved lazily during `framework process`, so `/apex`-pulled sources need none of them
- ADB interaction is centralized in `plugins/ard-framework/src/adb.ts` (in the published npm package: `decx-cli/src/android/adb.ts`, removed from this repository)
- `decx android device system-services` returns structured JSON for live Binder/system services and supports `--serial`, `--adb-path`, and `--grep`
- `decx android device permission-info <permission>` returns one structured JSON object for a permission and supports `--serial` and `--adb-path`
- `get_classes` accepts a `filter` object with `limit`, regex-enabled `includes`/`excludes`, and optional `regex=false`
- `get_class_source` accepts an optional `filter.limit` to return at most N source lines
- `get_aidl_interfaces` and `get_dynamic_receivers` accept the same regex-enabled `filter` object for package filtering
- `get_exported_components` accepts regex-enabled `includes`/`excludes` and optional `regex=false`
- `get_all_resources` accepts `filter.includes` and optional `regex=false` for resource file-name filtering
- `search_global_key` accepts a `search` object with `limit`, `includes`, `excludes`, `caseSensitive`, and `regex`
- `search_class_key` greps within one class and requires a `grep` object with `limit`, `caseSensitive`, and `regex`
- Framework build metadata is stored per-output-directory under `.artifact.json`; legacy `.meta.json` is no longer used. The artifact vendor (device model) is auto-detected: a single connected adb device is auto-selected; several devices require `--serial` (`ADB_DEVICE_AMBIGUOUS`); no device keeps the offline `unknown` default
- `decx android framework open` / `run` ultimately create normal process sessions via `decx process open`; framework artifacts are not stored as a separate session kind
### Skill workflow details

- Skill architecture and authoring rules are defined in `skills/AGENTS.md`.
- Vulnerability hunting is the `decx-vulnhunt` skill with App and Framework tracks sharing one methodology, evidence gates, and rating authority; report/PoC skills consume its finalized finding writeups.
- `skills/decx-report/` (`decx-report`) owns report templates and consumes finalized DECX finding writeups; vuln-hunt skills should not duplicate report templates.
- PoC projects are generated by the agent on the spot: `skills/decx-poc/references/poc-base.md` is the single source of truth for the `poc-<target>/app/` + `poc-<target>/server/` contract; there are no template assets or setup scripts.
- The PoC app contract defined in `poc-base.md` keeps a dynamic button registry in `ExploitRegistry` and also accepts browser-driven `poc-<target>://run/trigger?exploit=<id>` launches through `PoCActivity`.

### Minimal OpenCode plugin

`.opencode/plugins/decx.js` is a minimal OpenCode plugin (auto-loaded from `.opencode/plugins/`) that only injects a routing hint into the system prompt, pointing the agent at the installed skills (`decx-cli`, `decx-vulnhunt`, `decx-report`, `decx-poc`). There is no graph database and no function-level tool set; workflow discipline is enforced by the skills themselves.

## Build And Test Commands

### Kotlin modules

```bash
cd modules/decx-jadx
./gradlew dist
./gradlew :plugin:shadowJar
./gradlew :server:shadowJar
./gradlew test
```

Artifacts copied by Gradle:

- `modules/decx-jadx/build/dist/jadx_decx_plugin-<version>.jar`
- `modules/decx-jadx/build/dist/jadx-server-<version>.jar`

Jadx script plugin: `jadx-script-kotlin` is not on Maven Central. `jadx-server`'s `fetchJadxScriptPlugin` task downloads its GitHub release zip once and extracts the plugin jar; the scripting runtime (Kotlin scripting, ktlint, kotlin-logging) comes from Maven Central. Offline builds can set `DECX_JADX_SCRIPT_ZIP=/path/to/jadx-script-kotlin-<ver>.zip`. The fat jar uses Zip64 (>65535 entries) and its `META-INF/services/jadx.api.plugins.JadxPlugin` merge is verified to contain both `DexInputPlugin` and `JadxScriptKotlinPlugin`.

Version source:

- repository-root `version` file

### CLI

```bash
cd decx
go build ./cmd/decx     # or: make build (version-stamped dist/decx); needs cgo and a C toolchain
go test -race ./...
go vet ./...
```

`make build` stamps the repository-root `version` file into the binary and
writes `dist/decx`; `make release` (`go run ./cmd/pack`) builds the release archive of
the host platform only (the plugin engine needs cgo, so other platforms are
built by their own CI runners), and `make install` runs `go install`. The `build`, `test`
and `install` targets first run `make plugins` (`npm ci && npm run
build` in `plugins/ard-framework`), because the local plugin resolution and the
plugin tests need the compiled bundle under `plugins/ard-framework/dist`.
Publishing plugin bundles is not the CLI's job: the DECX release workflow
(`release-ard-framework.yml`) builds and attaches them, and the CLI only installs
(`decx install`) and loads them.

### Framework plugin

```bash
cd plugins/ard-framework
npm ci                          # typescript + @types/node (development only)
npm run build                   # tsc -> dist/src/*.js, dist/tests/*.js
node --test "dist/tests/*.test.js"   # Node 24; tests run against the compiled output
```

`plugins/ard-framework/dist` is git-ignored and rebuilt by `make -C decx
plugins`, the release workflows and `npm run build`; the plugin has no runtime
npm dependencies (the embedded engine cannot resolve `node_modules`).

### ASC module

```bash
git submodule update --init modules/decx-asc/asc   # ASC sources, first checkout only
cd modules/decx-asc
python3 -m unittest discover -s tests -v         # adapter unit tests (stdlib only)
./build.sh                                       # packs dist/asc-server-<version>.zip
```

### Kuna module

```bash
git submodule update --init modules/decx-kuna/kuna   # Kuna sources, first checkout only
cd modules/decx-kuna
cargo test --manifest-path server/Cargo.toml        # unit + integration tests
./build.sh                                          # compiles specs, packs dist/kuna-server-<version>-<os>-<arch>.zip
```

The first build fetches the Kuna crate graph from crates.io (rustc 1.90+ required); spec compilation runs `slacomp` over the submodule's `.slaspec` tree into `.build/specs` and is reused with `SKIP_SPECS=1`.

## Technology And Style Notes

### Kotlin

- JVM toolchain: 17
- Main libraries: JADX, Javalin, Gson, Jackson, SLF4J/Logback
- Logging goes through `LogUtils`
- Error responses use `DecxError`
- Shared transport and routing live in `modules/decx-jadx/core`; avoid duplicating server logic in plugin/server modules

Current error codes defined in `DecxError.kt` (see `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/api/DecxError.kt`):

- `INTERNAL_ERROR` (500), `SERVICE_ERROR` (503), `REQUEST_TIMEOUT` (504), `HEALTH_CHECK_FAILED` (500)
- `UNKNOWN_ENDPOINT` (404), `INVALID_PARAMETER` (400), `METHOD_NOT_FOUND` (404)
- `CLASS_NOT_FOUND` (404), `RESOURCE_NOT_FOUND` (404), `MANIFEST_NOT_FOUND` (404)
- `FIELD_NOT_FOUND` (404), `INTERFACE_NOT_FOUND` (404), `SERVICE_IMPL_NOT_FOUND` (404)
- `NO_STRINGS_FOUND` (404), `NO_MAIN_ACTIVITY` (404), `NO_APPLICATION` (404)
- `EMPTY_SEARCH_KEY` (400), `DECOMPILATION_SKIPPED` (503), `NOT_GUI_MODE` (503)

### Go

- Module `github.com/jygzyc/decx/decx`, `go 1.25.0`, third-party dependencies `github.com/gofrs/flock` (session-file lock), `github.com/buke/quickjs-go` (embedded QuickJS engine, linked through cgo, executing plugins in-process) and `github.com/shirou/gopsutil/v4` (machine memory for the JVM heap default)
- Plugins are authored in TypeScript and bundled by esbuild into one self-contained `.js` file, which the embedded QuickJS engine evaluates (`internal/plugin`: `runtime.go` engine core plus the bridge helpers, `prelude.js` Node prelude, `fs.go`, `child_process.go`, `crypto.go`); the toolchain is development-only, no Node/npm runtime is required. The CLI only parses the registry and installs/loads plugin bundles into `$DECX_HOME/modules/<id>`, which it discovers like any other plugin location (`internal/registry/manifest.go` scans the roots, `internal/plugin` evaluates the bundle); bundling and publishing them belongs to the DECX release workflow (`.github/workflows/release-ard-framework.yml`, one platform-independent `decx-ard-framework-plugin-{version}.zip`), not to the CLI. Because the engine needs cgo, `go run ./cmd/pack` only builds the host platform and every release archive comes from a native runner (`.github/workflows/release-cli.yml` matrix: linux amd64/arm64, darwin amd64/arm64, windows amd64/arm64)
- The command tree comes from the runtime registry (`internal/registry`), not from a command framework: servers and plugins are data
- Tests are plain Go tests (`go test -race ./...`); Android end-to-end fixtures live in `decx/tests/fixtures`
- New files are gofmt-formatted; `cmd/decx/main.go` predates that and is still compact single-line style

### MCP server

- DECX exposes an in-process Kotlin MCP server (official `io.modelcontextprotocol:kotlin-sdk-server`) over Ktor CIO Streamable HTTP on `serverPort + 1` at `/mcp`.
- The MCP tool surface, transport, lifecycle, and registry live in `modules/decx-jadx/core/.../server/`: `DecxMcpServer.kt`, `McpHttpServer.kt`, `McpToolRegistry.kt`.
- `McpToolRegistry` is backed by `DecxRoutes`; tools delegate to existing API routes, so MCP exposure stays in sync with HTTP exposure.
- MCP is **disabled by default**:
  - Standalone server: opt-in via `--mcp` (parsed in `JadxServerApp`)
  - CLI: `decx session open <file> -- --mcp` passes the flag through to `jadx-server`
  - Plugin: auto-start driven by the `mcpAutoStart` preference (`PreferencesManager`)
- A `DecxApiResult` envelope is shared across HTTP and MCP responses; MCP tool responses are derived from the same `DecxApiResult` the HTTP layer returns.
- The Python MCP sidecar (`modules/decx-jadx/plugin/src/main/resources/mcp/`) and its `SidecarProcessManager` / `McpPreferences` were removed in v3.4.0.

## Architecture Pointers

### Shared server path

For server behavior, follow this chain:

```text
DecxServer
  -> RouteHandler
  -> DecxApi / DecxApiImpl
  -> service/* and utils/*
```

Use this rule of thumb:

- New analysis capability usually starts in `DecxApi` and `DecxApiImpl`
- HTTP exposure is registered in `DecxRoutes`
- CLI exposure is added through the module's `commands` list in its `decx.json` manifest, reached as `decx -m <id> <command>` (dispatch in `decx/internal/cli/cli.go`)
- MCP exposure is added in `modules/decx-jadx/core/.../server/McpToolRegistry.kt`

### Plugin path

For plugin-only behavior, check:

- `DecxPlugin.kt`
- `lifecycle/PluginLifecycleManager.kt`
- `ui/DecxUIManager.kt`
- `utils/PreferencesManager.kt` (for `mcpAutoStart`)

### Standalone server path

For headless operation, check:

- `jadx-server/src/main/kotlin/jadx/plugins/decx/server/JadxServerApp.kt`

This binary:

- parses `--port`
- parses `--mcp` (opt-in MCP server on `port + 1`)
- normalizes the remaining jadx arguments with `JadxPassthroughArgs`: drops `--deobf`, defaults `--show-bad-code`, `--no-imports`, `-Pdex-input.verify-checksum=no` and `--rename-flags case,valid`, strips the `printable` rename token, rewrites `all` to `case,valid`, and canonicalizes the DECX `-rf` alias to jadx's `--rename-flags` (jadx does not know `-rf`, so a surviving token would be treated as an input file)
- forwards remaining args to JADX CLI parsing
- validates the input file exists (and any `.jadx.kts` script files)
- defaults the log level to INFO (jadx-cli's PROGRESS mode sets root OFF, which would silence script `log` output); `--log-level` / `-q` / `-v` still override
- warms up the decompiler
- starts `DecxServer`

Jadx Kotlin scripts: pass `.jadx.kts` files as additional positional inputs (the CLI does this via `process open --script`). The bundled `jadx-script-kotlin` plugin evaluates them during `decompiler.load()` (top-level code) and registers `afterLoad` blocks as a `JadxAfterLoadPass`.

## Common Change Patterns

### Add or change an HTTP API endpoint

1. Add the capability in `DecxApi` and `DecxApiImpl`
2. Implement or extend logic in the relevant service under `modules/decx-jadx/core/service/`
3. Register the route in `DecxRoutes`
4. If needed, update CLI and MCP consumers

### Add a CLI command

1. Server-backed command: add the command to the `commands` list of the server module's own `decx.json` manifest (`modules/<component>/decx.json`) — the request mapping in the manifest covers the HTTP shape, so no Go change is needed for a plain endpoint + args + request body; the command is then reachable as `decx -m <id> <command>`
2. Plugin command: implement it in the runtime plugin (`plugins/<id>/src`) and register its command tree on the plugin module's `commands` list in its own `decx.json` manifest — it is then reachable as `decx -m <id> <command>`, and the Go side only schedules the plugin, so no CLI change is needed once the plugin exists
3. Add or update tests next to the code (`decx/internal/**/*_test.go`) and, for end-to-end flows, in `decx/tests/`
4. Keep the help text (`internal/cli/cli.go`, per-command `Help`) aligned with actual behavior

### Add an MCP tool

1. Update `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/server/McpToolRegistry.kt`
2. Point the tool at an existing `DecxRoutes` endpoint when possible
3. Only add new server APIs if the capability does not already exist

### Change plugin lifecycle or MCP startup

Validate interactions across:

- `PluginLifecycleManager`
- `DecxMcpServer` (in-process MCP server lifecycle)
- `PreferencesManager`
- `DecxUIManager`

Port coordination matters:

- DECX HTTP server uses the configured port
- Kotlin MCP server uses `port + 1`

## Key Files

| File | Why it matters |
|---|---|
| `AGENTS.md` | This repository guide for coding agents |
| `README.md` / `README_zh.md` | User-facing product and usage docs |
| `modules/decx-jadx/settings.gradle.kts` | Gradle module inclusion |
| `modules/decx-jadx/build.gradle.kts` | Root versioning, repositories, `dist` aggregation task |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/Decx.kt` | Public facade for API, server, MCP, routes, tools |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/server/DecxServer.kt` | Javalin HTTP server and route registration |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/server/RouteHandler.kt` | Endpoint-to-API dispatch |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/api/DecxApi.kt` | Shared API contract |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/api/DecxApiImpl.kt` | Core API implementation |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/api/DecxApiResult.kt` | Unified success/error envelope (HTTP + MCP) |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/api/DecxError.kt` | Structured error codes |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/server/DecxMcpServer.kt` | In-process Kotlin MCP server lifecycle |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/server/McpHttpServer.kt` | Ktor CIO Streamable HTTP transport for MCP |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/server/McpToolRegistry.kt` | MCP tool surface, backed by DecxRoutes |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/utils/DecompileGuard.kt` | Single authority for decompiler-derived state: decompile guards, bounded code cache + cold-class unloading, class/method symbol index |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/utils/BoundedCodeCache.kt` | Byte-bounded LRU `ICodeCache` installed by the headless server (JADX default is unbounded) |
| `modules/decx-jadx/core/src/main/kotlin/jadx/plugins/decx/utils/RouteTelemetry.kt` | In-flight + per-endpoint latency telemetry via `/health` and logs |
| `modules/decx-jadx/plugin/src/main/kotlin/jadx/plugins/decx/DecxPlugin.kt` | JADX plugin entry point |
| `modules/decx-jadx/plugin/src/main/kotlin/jadx/plugins/decx/lifecycle/PluginLifecycleManager.kt` | Startup sequencing |
| `modules/decx-jadx/plugin/src/main/kotlin/jadx/plugins/decx/ui/DecxUIManager.kt` | Plugin UI and restart actions |
| `modules/decx-jadx/server/src/main/kotlin/jadx/plugins/decx/server/JadxServerApp.kt` | Headless entry point |
| `decx/cmd/decx/main.go` | CLI entry point (DECX_HOME, `App` wiring) |
| `decx/internal/cli/cli.go` | Command dispatch, module routing (`-m`), usage text, HTTP requests |
| `decx/internal/registry/manifest.go` | `decx.json` manifest schema, validation and module discovery (`ScanManifests`; modules under `$DECX_HOME/modules`) |
| `plugins/README.md` | Runtime plugin-module contract: manifest fields, request/response JSON, resolution order |
| `plugins/ard-framework/src/index.ts` | Android device/framework workflows (TypeScript plugin bundled to one file, run in-process by the CLI's embedded engine) |
| `decx/internal/session/session.go` | Session lifecycle and server spawning |
| `decx/internal/install/install.go` | Release resolution and archive installs |
| `decx/internal/cli/self.go` | `install` plus `self update/skills` |
| `decx/internal/plugin/plugin.go` | Runtime-plugin resolution and in-process QuickJS execution (bridge, host modules, request/response envelope) |
| `decx/internal/skills/skills.go` | Agent skill install and client linking |

## Agent Guidance For This Repo

- Prefer updating `AGENTS.md` when repository behavior changes in ways that affect future coding agents.
- Keep this file grounded in code, not aspirational documentation.
- Avoid listing commands, endpoints, or scripts that are not actually present in the repo.
- When unsure whether user-facing behavior changed, verify against `README.md`, command sources, and Gradle/package manifests.
- If you add a new top-level module, new server or plugin module, or transport path, update this file in the same change.

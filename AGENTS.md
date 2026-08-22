# AGENTS.md

Coding agent instructions for the DECX repository.

## Repository Purpose

DECX (`Decompiler + X`) is an AI-oriented analysis layer built on top of JADX.
The repository contains:

- A Kotlin HTTP analysis server shared by plugin mode and standalone mode
- A JADX GUI plugin that starts the DECX server and an in-process Kotlin MCP server
- A standalone `decx-server` fat JAR for headless analysis
- A TypeScript CLI that starts and talks to `decx-server`
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
| `decx/decx-core/` | Kotlin, JVM 17 | Shared API, HTTP transport, services, models, utilities, DecxExtension SPI |
| `decx/decx-plugin/` | Kotlin, Shadow JAR | JADX GUI plugin, lifecycle, UI, in-process MCP server management |
| `decx/decx-server/` | Kotlin, Shadow JAR | Standalone headless server with `DecxServerApp` main class |
| `decx/decx-taint/` | Kotlin | Taint extension (DecxExtension SPI impl): JSON rules, async job manager, Tai-e worker sources; also builds the standalone worker fat jar |
| `decx-cli/` | TypeScript, Node.js 22.5+ | User CLI for session management and analysis commands |
| `skills/decx-cli/` | Skill `decx-cli` | DECX CLI usage, general analysis, and workflow routing |
| `skills/decx-vulnhunt/` | Skill `decx-vulnhunt` | Android vulnerability hunting workflow (App + Framework tracks) |
| `skills/decx-report/` | Skill `decx-report` | Report generation from finalized DECX analysis graph findings |
| `skills/decx-poc/` | Skill `decx-poc` | PoC app construction workflow |

## What Is Actually Implemented

### Kotlin server capabilities

`decx-core` exposes these HTTP endpoints through `DecxRoutes` and `RouteHandler`:

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
- Caches decompiled source on demand via `DecompileGuard` (compressed) for fast repeat queries; no background warmup

### CLI responsibilities

The CLI is session-oriented and can spawn standalone DECX server processes.
Current top-level commands are:

- `decx process`
- `decx code`
- `decx android`
- `decx self`
- `decx taint`

Notable details:

- `decx process open <file>` launches `java -jar decx-server.jar ...`
- `decx process open <file>` starts the JVM with `-Xmx` set to 2/3 of machine memory rounded down
- `decx process open <file>` is also reused by `decx android framework open` and `decx android framework run`
- `decx process open <file> --script <s1.jadx.kts> [--script <s2.jadx.kts> ...]` runs Jadx Kotlin scripts during decompilation; scripts are passed to decx-server as positional input files after the main target
- Scripts execute at decompile time (top-level code at load, `jadx.afterLoad { }` blocks after classes load); the server bundles the `jadx-script-kotlin` plugin
- Session reuse is keyed on the target file **plus** the exact script set; opening the same file with a different script set errors until `--force`
- `--force` replaces alive sessions matching the same name **or** the same file hash (kills their JVMs before spawning the new one) instead of leaking orphan processes
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
- `decx self install` installs or updates `decx-server.jar`; `decx self install tai-e` installs the Tai-e taint engine (dist jars + worker jar) into `DECX_HOME/tai-e`
- `decx self skills install --client <client>` downloads DECX skills from GitHub into `DECX_HOME/skills`, then symlinks them into private directories for Codex, Claude Code, and Cursor or the shared `~/.agents/skills` directory for every other or omitted client
- `decx self update` updates both the server JAR and the currently installed npm CLI package
- On startup the CLI runs a non-blocking update check (`decx-cli/src/core/update-notifier.ts`): the latest version comes from the npm registry, results are cached in `DECX_HOME/update-check.json` for 24 hours, refreshes happen in a detached `__update-check` child process, and update hints go to stderr; disable with `DECX_NO_UPDATE_CHECK=1` (also skipped under `CI`)
- `decx-cli` builds runtime JavaScript as two bundles: `dist/index.js` for the CLI and `dist/sdk/index.js` for SDK imports; packaged native tools are stored as `dist/bin.tar.gz` and extracted to cache at runtime
- `decx android framework` provides framework collection and preprocessing subcommands:
  `collect`, `process`, `run`, `open`
- `decx android device` provides adb-backed inspection commands:
  `system-services`, `permission-info`
- Framework processing is implemented in native TypeScript under `decx-cli/src/android/`
- Zip/jar read-write operations are centralized in `decx-cli/src/android/zip-utils.ts` and are cross-platform: Windows 10+ uses the bundled bsdtar (`C:\Windows\System32\tar.exe`, no `zip`/`unzip` dependency), other platforms use Info-ZIP `zip`/`unzip`
- Framework APEX filesystem-image extraction (debugfs/erofs-utils) has no native Windows binaries; on Windows `decx-cli/src/android/framework-tools.ts` delegates those tools to WSL (`wsl.exe`) with `/mnt/<drive>/...` path translation (`translateWslArgs`), falling back to the packaged `linux/x86_64/extract.erofs`. Without WSL, `decx android framework` errors with an explicit "Windows requires WSL" message
- ADB interaction is centralized in `decx-cli/src/android/adb.ts`
- `decx android device system-services` returns structured JSON for live Binder/system services and supports `--serial`, `--adb-path`, and `--grep`
- `decx android device permission-info <permission>` returns one structured JSON object for a permission and supports `--serial` and `--adb-path`
- `get_classes` accepts a `filter` object with `limit`, regex-enabled `includes`/`excludes`, and optional `regex=false`
- `get_class_source` accepts an optional `filter.limit` to return at most N source lines
- `get_aidl_interfaces` and `get_dynamic_receivers` accept the same regex-enabled `filter` object for package filtering
- `get_exported_components` accepts regex-enabled `includes`/`excludes` and optional `regex=false`
- `get_all_resources` accepts `filter.includes` and optional `regex=false` for resource file-name filtering
- `search_global_key` accepts a `search` object with `limit`, `includes`, `excludes`, `caseSensitive`, and `regex`
- `search_class_key` greps within one class and requires a `grep` object with `limit`, `caseSensitive`, and `regex`
- Framework build metadata is stored per-output-directory under `.artifact.json`; legacy `.meta.json` is no longer used
- `decx android framework open` / `run` ultimately create normal process sessions via `decx process open`; framework artifacts are not stored as a separate session kind

### Taint analysis engine (Tai-e, single decx-taint module)

- Taint analysis lives entirely in **`decx/decx-taint/`** and is mounted as a **`DecxExtension` SPI** (ServiceLoader): `decx-core/extension/DecxExtension.kt` interface, `DecxExtensions.kt` registry, `taint/TaintExtension.kt` implementation. `decx-core` has no taint code; routes/MCP tools exist only when the module is on the classpath (bundled by decx-server / decx-plugin)
- Routes are injected **dynamically**: when `TaintExtension.isAvailable()` is true the taint surface registers; otherwise the core jadx surface is completely unaffected
- The outward surface is exactly **3 interfaces** (HTTP + MCP stay in lockstep): `config`, `analyze`, `progress` under `/api/decx/taint/` with MCP tools `taint_config` / `taint_analyze` / `taint_progress`
- **Rules are appshark-style JSON documents** (one file = many named rules): each rule has `description` / `category` / `severity` and `sources` / `sinks` / `transfers` / `sanitizers` entries using Tai-e/Jimple signatures `<class: returnType name(paramTypes)>` and positions `result` / `base` / 0-based parameter index (wildcards unsupported in v1). Parsing/validation lives in `taint/rules/TaintRuleParser.kt`; rule sources in priority order: inline `rules` JSON > `rulePath` directory > built-in classpath `taint/rules/*.json` (`privacy-leak.json` defines `deviceIdLeak` / `locationLeak` / `userInputLeak`)
- `TaintRuleCompiler` merges all selected rules into **one** Tai-e taint fragment (one analysis pass, one world build) and builds attribution tables; reported flows are attributed back to rule names/severities, and source-of-rule-A → sink-of-rule-B flows are flagged `cross_rule`
- **`analyze` is async**: it validates synchronously (rules, target, engine readiness) and returns `{jobId, state: queued}`; execution is serialized on one daemon thread in `taint/TaintJobManager.kt` (states `queued → running → succeeded | failed | cancelled`, bounded queue of 8 waiting jobs → `TAINT_QUEUE_FULL`, finished jobs kept for the latest 32)
- **`progress` returns state and results**: with `jobId` it returns state/stage/message/`progressLog` (latest 100 entries) and — when succeeded — the attributed flows as items plus `perRule` counts in the summary; without `jobId` it lists recent jobs; `cancel: true` cancels a queued/running job
- Error codes: `INVALID_TAINT_CONFIG`, `TAINT_ANALYSIS_FAILED`, `TAINT_ENGINE_NOT_READY`, `TAINT_JOB_NOT_FOUND`, `TAINT_QUEUE_FULL`
- The engine runs in a **separate worker JVM** spawned per analysis by `taint/TaintWorkerPool.kt` (Tai-e world is process-scoped); communication is NDJSON over stdin/stdout (`taint/protocol/WorkerMessage` / `WorkerProtocol`); the Tai-e entry point is `taint/worker/TaiEEngine.kt` (writes a temp Tai-e taint-config, runs pta, reads back `TaintFlow`s)
- Worker classpath = `DECX_HOME/tai-e/lib/*.jar` (full Tai-e dist lib: tai-e + patched Soot/FlowDroid + runtime deps) + `DECX_HOME/tai-e/worker/decx-taint-worker.jar`; the worker fat jar contains only module classes + Gson + kotlin-stdlib + logback (stderr-only logging, stdout stays NDJSON)
- **Tai-e never ships inside any DECX jar**: the Gradle `FetchTaiETask` in `decx-taint/build.gradle.kts` downloads the official `tai-e-<version>.zip` release once (Tai-e 0.5.4 is not on Maven Central; offline override `DECX_TAIE_ZIP=/path/to/zip`) and extracts it to `build/taie/lib` as a `compileOnly` dependency; `shadowJar` is configured as the worker binary (consumers get the plain jar via `shadowRuntimeElements.isCanBeConsumed = false`)
- Compile-time note: the **full** Tai-e lib dir must be on the compile classpath — Tai-e's API signatures reference Soot/Jackson/ASM types and Kotlin eagerly resolves supertypes, so a lone tai-e jar fails with `Unresolved reference 'pascal'`
- Runtime environment lives under **`DECX_HOME`** (`~/.decx` or `DECX_HOME` env var): `tai-e/lib/`, `tai-e/worker/`, `tai-e/java-benchmarks/JREs/` (not shipped in any jar), `platforms/`; dev fallbacks probe this module's `build/taie/lib` and `build/libs/decx-taint-worker.jar`; `DECX_TAINT_WORKER_JAR` overrides the worker jar location
- Android analysis requires the APK's JRE version under `java-benchmarks/JREs/jre1.X/` (version inferred from targetSdk by Tai-e) and an Android SDK `platforms/` dir (`-ajs`)
- CLI mirrors the 3 interfaces: `decx taint config [--rules <file|json>] [--rule-path <dir>] [--rule-names <a,b>]`, `decx taint analyze (--target-session <name> | --apk <path>) [--cs ...] [--timeout <sec>] ...`, `decx taint progress [<jobId>] [--watch] [--cancel]`; `decx self install tai-e` installs the Tai-e dist jars + worker jar into `DECX_HOME/tai-e` and reports the still-missing JREs/platforms
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
cd decx
./gradlew dist
./gradlew :decx-plugin:shadowJar
./gradlew :decx-server:shadowJar
./gradlew :decx-taint:shadowJar
./gradlew test
```

Artifacts copied by Gradle:

- `decx/build/dist/jadx_decx_plugin-<version>.jar`
- `decx/build/dist/decx-server-<version>.jar`
- `decx/build/dist/decx-taint-worker.jar` (taint worker fat jar; no Tai-e inside)

Tai-e engine: `net.pascal-lab:tai-e` is not on Maven Central beyond 0.5.1 (the taint engine needs 0.5.4). `decx-taint`'s `fetchTaiE` task downloads the official GitHub release zip once and extracts its `lib/` into `build/taie/lib` as a `compileOnly` dependency — Tai-e never enters any shipped jar. Offline builds can set `DECX_TAIE_ZIP=/path/to/tai-e-<ver>.zip`.

Jadx script plugin: `jadx-script-kotlin` is not on Maven Central. `decx-server`'s `fetchJadxScriptPlugin` task downloads its GitHub release zip once and extracts the plugin jar; the scripting runtime (Kotlin scripting, ktlint, kotlin-logging) comes from Maven Central. Offline builds can set `DECX_JADX_SCRIPT_ZIP=/path/to/jadx-script-kotlin-<ver>.zip`. The fat jar uses Zip64 (>65535 entries) and its `META-INF/services/jadx.api.plugins.JadxPlugin` merge is verified to contain both `DexInputPlugin` and `JadxScriptKotlinPlugin`.

Version source:

- repository-root `version` file

### CLI

```bash
cd decx-cli
npm install
npm run build
npm test
npm run lint
npm run typecheck
npm run dev
```

`npm run build` type-checks (via `tsc --noEmit` behind the build script) and emits a compact runtime bundle under `dist/`. `npm run typecheck` runs `tsc --noEmit` standalone for CI/local checks.

## Technology And Style Notes

### Kotlin

- JVM toolchain: 17
- Main libraries: JADX, Javalin, Gson, Jackson, SLF4J/Logback
- Logging goes through `LogUtils`
- Error responses use `DecxError`
- Shared transport and routing live in `decx-core`; avoid duplicating server logic in plugin/server modules

Current error codes defined in `DecxError.kt` (see `decx/decx-core/src/main/kotlin/jadx/plugins/decx/api/DecxError.kt`):

- `INTERNAL_ERROR` (500), `SERVICE_ERROR` (503), `REQUEST_TIMEOUT` (504), `HEALTH_CHECK_FAILED` (500)
- `UNKNOWN_ENDPOINT` (404), `INVALID_PARAMETER` (400), `METHOD_NOT_FOUND` (404)
- `CLASS_NOT_FOUND` (404), `RESOURCE_NOT_FOUND` (404), `MANIFEST_NOT_FOUND` (404)
- `FIELD_NOT_FOUND` (404), `INTERFACE_NOT_FOUND` (404), `SERVICE_IMPL_NOT_FOUND` (404)
- `NO_STRINGS_FOUND` (404), `NO_MAIN_ACTIVITY` (404), `NO_APPLICATION` (404)
- `EMPTY_SEARCH_KEY` (400), `DECOMPILATION_SKIPPED` (503), `NOT_GUI_MODE` (503)

### TypeScript

- ESM project (`"type": "module"`)
- Commander-based command tree
- esbuild-based bundle
- Jest-based tests
- Node.js requirement: `>=22.5`

### MCP server

- DECX exposes an in-process Kotlin MCP server (official `io.modelcontextprotocol:kotlin-sdk-server`) over Ktor CIO Streamable HTTP on `serverPort + 1` at `/mcp`.
- The MCP tool surface, transport, lifecycle, and registry live in `decx-core/.../server/`: `DecxMcpServer.kt`, `McpHttpServer.kt`, `McpToolRegistry.kt`.
- `McpToolRegistry` is backed by `DecxRoutes`; tools delegate to existing API routes, so MCP exposure stays in sync with HTTP exposure.
- MCP is **disabled by default**:
  - Standalone server: opt-in via `--mcp` (parsed in `DecxServerApp`)
  - CLI: `decx process open <file> --mcp` forwards the flag to `decx-server`
  - Plugin: auto-start driven by the `mcpAutoStart` preference (`PreferencesManager`)
- A `DecxApiResult` envelope is shared across HTTP and MCP responses; MCP tool responses are derived from the same `DecxApiResult` the HTTP layer returns.
- The Python MCP sidecar (`decx-plugin/src/main/resources/mcp/`) and its `SidecarProcessManager` / `McpPreferences` were removed in v3.4.0.

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
- CLI exposure is added in `decx-cli/src/commands/`
- MCP exposure is added in `decx-core/.../server/McpToolRegistry.kt`

### Plugin path

For plugin-only behavior, check:

- `DecxPlugin.kt`
- `lifecycle/PluginLifecycleManager.kt`
- `ui/DecxUIManager.kt`
- `utils/PreferencesManager.kt` (for `mcpAutoStart`)

### Standalone server path

For headless operation, check:

- `decx-server/src/main/kotlin/jadx/plugins/decx/server/DecxServerApp.kt`

This binary:

- parses `--port`
- parses `--mcp` (opt-in MCP server on `port + 1`)
- forwards remaining args to JADX CLI parsing
- validates the input file exists (and any `.jadx.kts` script files)
- defaults the log level to INFO (jadx-cli's PROGRESS mode sets root OFF, which would silence script `log` output); `--log-level` / `-q` / `-v` still override
- warms up the decompiler
- starts `DecxServer`

Jadx Kotlin scripts: pass `.jadx.kts` files as additional positional inputs (the CLI does this via `process open --script`). The bundled `jadx-script-kotlin` plugin evaluates them during `decompiler.load()` (top-level code) and registers `afterLoad` blocks as a `JadxAfterLoadPass`.

## Common Change Patterns

### Add or change an HTTP API endpoint

1. Add the capability in `DecxApi` and `DecxApiImpl`
2. Implement or extend logic in the relevant service under `decx-core/service/`
3. Register the route in `DecxRoutes`
4. If needed, update CLI and MCP consumers

### Add a CLI command

1. Extend the relevant file in `decx-cli/src/commands/`
2. If it is a new command group, register it in `decx-cli/src/index.ts`
3. Add or update tests in `decx-cli/tests/`
4. Keep help text aligned with actual behavior

### Add an MCP tool

1. Update `decx/decx-core/src/main/kotlin/jadx/plugins/decx/server/McpToolRegistry.kt`
2. Point the tool at an existing `DecxRoutes` endpoint when possible
3. Only add new server APIs if the capability does not already exist

### Add a DecxExtension (optional engine surface)

1. Implement `jadx.plugins.decx.extension.DecxExtension` in `decx-core` (routes reuse `DecxRouteGroup`/`DecxRoute`, MCP tools reuse `McpTool`)
2. Register the implementation in `META-INF/services/jadx.plugins.decx.extension.DecxExtension`
3. Keep `isAvailable()` truthful: when the extension's environment is missing it must return `false` so no routes/tools are injected
4. Heavy work belongs in a worker process, not in the extension class

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
| `decx/settings.gradle.kts` | Gradle module inclusion |
| `decx/build.gradle.kts` | Root versioning, repositories, `dist` aggregation task |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/Decx.kt` | Public facade for API, server, MCP, routes, tools |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/server/DecxServer.kt` | Javalin HTTP server and route registration |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/server/RouteHandler.kt` | Endpoint-to-API dispatch |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/api/DecxApi.kt` | Shared API contract |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/api/DecxApiImpl.kt` | Core API implementation |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/api/DecxApiResult.kt` | Unified success/error envelope (HTTP + MCP) |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/api/DecxError.kt` | Structured error codes |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/server/DecxMcpServer.kt` | In-process Kotlin MCP server lifecycle |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/server/McpHttpServer.kt` | Ktor CIO Streamable HTTP transport for MCP |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/server/McpToolRegistry.kt` | MCP tool surface, backed by DecxRoutes |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/utils/DecompileGuard.kt` | Guarded decompilation, high-memory skip, and compressed source cache |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/utils/SymbolIndex.kt` | Lazy class/method name inventory for `get_classes`/`search_method` |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/utils/RouteTelemetry.kt` | In-flight + per-endpoint latency telemetry via `/health` and logs |
| `decx/decx-plugin/src/main/kotlin/jadx/plugins/decx/DecxPlugin.kt` | JADX plugin entry point |
| `decx/decx-plugin/src/main/kotlin/jadx/plugins/decx/lifecycle/PluginLifecycleManager.kt` | Startup sequencing |
| `decx/decx-plugin/src/main/kotlin/jadx/plugins/decx/ui/DecxUIManager.kt` | Plugin UI and restart actions |
| `decx/decx-server/src/main/kotlin/jadx/plugins/decx/server/DecxServerApp.kt` | Headless entry point |
| `decx/decx-taint/src/main/kotlin/jadx/plugins/decx/taint/TaintExtension.kt` | Taint extension: 3 routes + 3 MCP tools (config / analyze / progress) |
| `decx/decx-taint/src/main/kotlin/jadx/plugins/decx/taint/TaintService.kt` | Taint facade: loadConfig / startAnalysis / getProgress |
| `decx/decx-taint/src/main/kotlin/jadx/plugins/decx/taint/TaintJobManager.kt` | Async job state machine, progress log, cancellation |
| `decx/decx-taint/src/main/kotlin/jadx/plugins/decx/taint/rules/TaintRuleParser.kt` | Appshark-style JSON rule parsing + validation |
| `decx/decx-taint/src/main/kotlin/jadx/plugins/decx/taint/rules/TaintRuleCompiler.kt` | Rule merge into one Tai-e fragment + flow attribution |
| `decx/decx-taint/src/main/kotlin/jadx/plugins/decx/taint/TaintWorkerPool.kt` | Worker JVM spawn + NDJSON protocol driving |
| `decx/decx-taint/src/main/kotlin/jadx/plugins/decx/taint/worker/TaiEEngine.kt` | Tai-e invocation inside the worker process |
| `decx-cli/src/index.ts` | CLI command registration |
| `decx-cli/src/commands/process.ts` | Session lifecycle and server spawning |
| `decx-cli/src/commands/code.ts` | Common code-analysis commands |
| `decx-cli/src/commands/android.ts` | Android-analysis commands |
| `decx-cli/src/commands/self.ts` | CLI/server self-management (incl. `install tai-e`) |
| `decx-cli/src/commands/taint.ts` | Taint CLI: config / analyze / progress commands |

## Agent Guidance For This Repo

- Prefer updating `AGENTS.md` when repository behavior changes in ways that affect future coding agents.
- Keep this file grounded in code, not aspirational documentation.
- Avoid listing commands, endpoints, or scripts that are not actually present in the repo.
- When unsure whether user-facing behavior changed, verify against `README.md`, command sources, and Gradle/package manifests.
- If you add a new top-level module, new command group, or new transport path, update this file in the same change.

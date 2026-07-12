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
| `decx/decx-core/` | Kotlin, JVM 17 | Shared API, HTTP transport, services, models, utilities |
| `decx/decx-plugin/` | Kotlin, Shadow JAR | JADX GUI plugin, lifecycle, UI, in-process MCP server management |
| `decx/decx-server/` | Kotlin, Shadow JAR | Standalone headless server with `DecxServerApp` main class |
| `decx/decx-taie-engine/` | Kotlin, Shadow JAR | TaiEEngine process: Tai-e analysis (PTA, CG, taint) with JSON-RPC IPC |
| `decx-cli/` | TypeScript, Node.js 22.5+ | User CLI for session management and analysis commands |
| `skills/decx-cli/` | Skill `decx-cli` | DECX CLI usage, general analysis, and workflow routing |
| `skills/decx-app-vulnhunt/` | Skill `decx-app-vulnhunt` | Android app vulnerability hunting workflow |
| `skills/decx-framework-vulnhunt/` | Skill `decx-framework-vulnhunt` | Android framework vulnerability hunting workflow |
| `skills/decx-report/` | Skill `decx-report` | Report generation from finalized DECX analysis graph findings |
| `skills/decx-poc/` | Skill `decx-poc` | PoC app construction workflow |
| `skills/decx-poc/assets/poc-template-app/` | Android template | Source-of-truth minimal Android PoC app scaffold |
| `skills/decx-poc/assets/poc-template-server/` | Node template | Source-of-truth PoC HTML server scaffold |

## What Is Actually Implemented

### Kotlin server capabilities

`decx-core` exposes these HTTP endpoints through `DecxRoutes` and `RouteHandler`:

- Common code analysis:
  `get_classes`, `get_class_context`, `get_class_source`, `search_global_key`, `search_class_key`,
  `search_method`, `get_method_source`, `get_method_context`, `get_method_cfg`, `get_method_xref`, `get_field_xref`,
  `get_class_xref`, `get_implement`, `get_sub_classes`
- Android app analysis:
  `get_aidl`, `get_app_manifest`, `get_main_activity`, `get_application`,
  `get_exported_components`, `get_deep_links`, `get_dynamic_receivers`,
  `get_all_resources`, `get_resource_file`, `get_strings`
- Android framework analysis:
  `get_system_service_impl`
- TaiEEngine taint analysis (requires `--tai-e`):
  `get_taint_rules`, `investigate`, `investigate_custom`, `get_points_to`,
  `get_taie_dynamic_receivers`, `get_icc_targets`, `get_callbacks`, `get_call_graph`
- Health endpoint:
  `GET /health`

### TaiEEngine static analysis engine

DECX integrates [Tai-e](https://github.com/pascal-lab/Tai-e) as a separate
JVM process (`decx-taie-engine`) for memory isolation. Tai-e's heap
(World + PTA + points-to sets) runs in its own `-Xmx4G`, completely separate
from JADX's heap. This prevents the two heavy analysis engines from
competing for memory.

**Architecture**: TaiEEngine only connects to `decx-core`. Core defines the
`ITaiEEngine` interface and the IPC layer (`TaiEEngineClient`,
`TaiEEngineProcess`) — both pure Kotlin with zero Tai-e imports.
`decx-server` and `decx-plugin` use TaiEEngine through `Decx.api(taiEEngine)`,
identically. The IPC protocol is JSON-RPC 2.0 over stdin/stdout with
Content-Length framing (same as MCP stdio transport).

**Three core APIs** (TaintService):
1. `get_taint_rules` — lists preset rules from `~/.decx/rules/` (id, name,
   description, parameters)
2. `investigate` — executes a preset rule by ID, returns source→sink paths
3. `investigate_custom` — executes an AI-provided inline YAML rule

Rules use AppShark-style source/sink/sanitizer format with `{{param}}`
template substitution. When TaiEEngine is unavailable, DECX falls back to
JADX-only xref (single-level `useIn` + smali scan).

### Plugin responsibilities

The JADX plugin does more than just expose the server:

- Waits until the decompiler is ready before creating DECX services
- Initializes preferences and server port
- Starts the embedded DECX HTTP server
- Starts and stops the in-process Kotlin MCP HTTP server on `serverPort + 1`
- Provides UI and restart hooks through `DecxUIManager`
- Performs decompiler warmup in the background for faster later queries

### CLI responsibilities

The CLI is session-oriented and can spawn standalone DECX server processes.
Current top-level commands are:

- `decx process`
- `decx code`
- `decx ard`
- `decx self`

Notable details:

- `decx process open <file>` launches `java -jar decx-server.jar ...`
- `decx process open <file>` starts the JVM with `-Xmx` set to 2/3 of machine memory rounded down
- `decx process open <file>` is also reused by `decx ard framework open` and `decx ard framework run`
- Standard `jadx-cli` flags are passed through by `process open`
- `process open` enables `--show-bad-code` by default unless the flag is already present in passthrough args
- CLI sessions are tracked locally and can be reused by session name and file hash
- `decx process close` can close by session name, by `--port <port>`, or all sessions with `--all`
- CLI data defaults to `~/.decx`; set `DECX_HOME` to redirect config, sessions, logs, tmp files, output, and installed server JARs
- CLI tests set `DECX_HOME` to `.decx_test/home/.decx` and keep test-only artifacts under `.decx_test/`
- `decx self install` installs or updates `decx-server.jar`
- `decx self update` updates both the server JAR and the currently installed npm CLI package
- `decx-cli` builds runtime JavaScript as two bundles: `dist/index.js` for the CLI and `dist/sdk/index.js` for SDK imports; packaged native tools are stored as `dist/bin.tar.gz` and extracted to cache at runtime
- `decx ard framework` provides framework collection and preprocessing subcommands:
  `collect`, `process`, `pack`, `run`, `open`, `tools`
- `decx ard` also includes adb-backed inspection commands:
  `system-services`, `perm-info`, `top-app`, `am-start`
- Framework processing is implemented in native TypeScript under `decx-cli/src/android/`
- ADB interaction is centralized in `decx-cli/src/android/adb.ts`
- `decx ard system-services` returns structured JSON for live Binder/system services and supports `--serial`, `--adb-path`, and `--grep`
- `decx ard perm-info <permission>` returns one structured JSON object for a permission and supports `--serial` and `--adb-path`
- `decx ard top-app` returns the current foreground package/activity via `dumpsys activity activities` and supports `--serial` and `--adb-path`
- `decx ard am-start <pkg-or-component>` launches an app or activity via `am start`; pair a package argument with `--activity <class>` to target a specific activity, and use `--serial`/`--adb-path` for device selection
- All adb-backed `decx ard` commands resolve the target device with priority `--serial` > `$ANDROID_SERIAL` > the single connected device, and require `--serial` (or `$ANDROID_SERIAL`) when more than one device is attached
- `get_classes` accepts a `filter` object with `limit`, regex-enabled `includes`/`excludes`, and optional `regex=false`
- `get_class_source` accepts an optional `filter.limit` to return at most N source lines
- `get_aidl` and `get_dynamic_receivers` accept the same regex-enabled `filter` object for package filtering
- `get_exported_components` accepts regex-enabled `includes`/`excludes` and optional `regex=false`
- `get_all_resources` accepts `filter.includes` and optional `regex=false` for resource file-name filtering
- `search_global_key` accepts a `search` object with `limit`, `includes`, `excludes`, `caseSensitive`, and `regex`
- `search_class_key` greps within one class and requires a `grep` object with `limit`, `caseSensitive`, and `regex`
- Framework build metadata is stored per-output-directory under `.artifact.json`; legacy `.meta.json` is no longer used
- `decx ard framework open` / `run` ultimately create normal process sessions via `decx process open`; framework artifacts are not stored as a separate session kind
### Skill workflow details

- Skill architecture and authoring rules are defined in `skills/AGENTS.md`.
- DECX analysis skills share `skills/decx-analysis-core/`, a minimal SQLite Fact/Intent/Hint DAG protocol (Cairn-minimal blackboard). Each analysis session gets one `decx-analysis.db` under `.decx-analysis/<session>/`. App hunts initialize with `--kind android_app`; framework hunts initialize with `--kind android_framework`. An Intent *is* the graph edge (`from_facts` -> `to_fact`); Facts are the only truth nodes, and Hints are out-of-graph guidance. Chains are Fact→Fact paths formed by concluded Intents. `init` seeds a single `origin` Fact (`f000`); there is no `goal` Fact. Intent execution uses `start --by <generator-id>` with a renewable lease; `fact --from <intent> --by <same-generator>` requires that live claim. Finding kinds require the gate-enforced `promote` command. The shared graph CLI is `skills/decx-analysis-core/scripts/decx-graph.mjs`, and `skills/decx-analysis-core/tests/graph-conformance.mjs` verifies OpenCode/Skill bidirectional compatibility.
- `skills/decx-report/` (`decx-report`) owns report templates and consumes finalized DECX analysis graph findings; app/framework vuln-hunt skills should not duplicate report templates.
- `skills/decx-poc/scripts/setup-poc.mjs` copies `skills/decx-poc/assets/poc-template-app/` into `poc-<target>/app/` and `skills/decx-poc/assets/poc-template-server/` into `poc-<target>/server/`
- The PoC app template keeps a dynamic button registry in `ExploitRegistry` and also accepts browser-driven `poc-<target>://run/trigger?exploit=<id>` launches through `PoCActivity`.

### Agent framework

The agent framework (`decx-agent`) has been extracted into a standalone project and is no longer part of this repository. It is a generic, configured TypeScript framework separate from the Kotlin server and the deterministic `decx` CLI.

## Build And Test Commands

### Kotlin modules

```bash
cd decx
./gradlew dist
./gradlew :decx-plugin:shadowJar
./gradlew :decx-server:shadowJar
./gradlew test
```

Artifacts copied by Gradle:

- `decx/build/dist/jadx_decx_plugin-<version>.jar`
- `decx/build/dist/decx-server-<version>.jar`

Version source:

- repository-root `version` file

### CLI

```bash
cd decx-cli
npm install
npm run build
npm test
npm run lint
npm run dev
```

Do not document or rely on `npm run typecheck` unless you add that script first.
`decx-cli/package.json` does not currently define it.

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
- validates an input file exists
- warms up the decompiler
- starts `DecxServer`

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
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/utils/DecompileGuard.kt` | Guarded decompilation and high-memory skip logging |
| `decx/decx-plugin/src/main/kotlin/jadx/plugins/decx/DecxPlugin.kt` | JADX plugin entry point |
| `decx/decx-plugin/src/main/kotlin/jadx/plugins/decx/lifecycle/PluginLifecycleManager.kt` | Startup sequencing and warmup |
| `decx/decx-plugin/src/main/kotlin/jadx/plugins/decx/ui/DecxUIManager.kt` | Plugin UI and restart actions |
| `decx/decx-server/src/main/kotlin/jadx/plugins/decx/server/DecxServerApp.kt` | Headless entry point |
| `decx-cli/src/index.ts` | CLI command registration |
| `decx-cli/src/commands/process.ts` | Session lifecycle and server spawning |
| `decx-cli/src/commands/code.ts` | Common code-analysis commands |
| `decx-cli/src/commands/ard.ts` | Android-analysis commands |
| `decx-cli/src/commands/self.ts` | CLI/server self-management |

## Agent Guidance For This Repo

- Prefer updating `AGENTS.md` when repository behavior changes in ways that affect future coding agents.
- Keep this file grounded in code, not aspirational documentation.
- Avoid listing commands, endpoints, or scripts that are not actually present in the repo.
- When unsure whether user-facing behavior changed, verify against `README.md`, command sources, and Gradle/package manifests.
- If you add a new top-level module, new command group, or new transport path, update this file in the same change.

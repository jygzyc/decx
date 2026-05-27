# AGENTS.md

Coding agent instructions for the DECX repository.

## Repository Purpose

DECX (`Decompiler + X`) is an AI-oriented analysis layer built on top of JADX.
The repository contains:

- A Kotlin HTTP analysis server shared by plugin mode and standalone mode
- A JADX GUI plugin that starts the DECX server and manages a Python MCP sidecar
- A standalone `decx-server` fat JAR for headless analysis
- A TypeScript CLI that starts and talks to `decx-server`
- AI skill definitions under `skill/` for DECX-driven analysis workflows

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
| `decx/decx-core/` | Kotlin, JVM 11 | Shared API, HTTP transport, services, models, utilities |
| `decx/decx-plugin/` | Kotlin, Shadow JAR | JADX GUI plugin, lifecycle, UI, MCP sidecar management |
| `decx/decx-server/` | Kotlin, Shadow JAR | Standalone headless server with `DecxServerApp` main class |
| `decx/decx-plugin/src/main/resources/mcp/` | Python 3.10+ | Bundled MCP server resources extracted to `~/.decx/mcp/` |
| `decx-cli/` | TypeScript, Node.js 18+ | User CLI for session management and analysis commands |
| `decx-agent/decx_agent/core/` | Python 3.10+ | Cairn-style Fact / Intent / Hint board, dispatcher, storage, prompt protocol, and skill references |
| `decx-agent/decx_agent/decx/` | Python 3.10+ | Internal DECX HTTP probe client and config-driven managed server helper |
| `decx-agent/decx_agent/workers/` | Python 3.10+ | Bottom adapters for noop, Codex, Claude Code, and OpenCode workers |
| `decx-agent/decx_agent/cli.py` | Python 3.10+ | CLI entrypoint exposed as `uv run decx-agent` |
| `skills/decx-cli/` | Skill `decx-cli` | DECX CLI usage, general analysis, and workflow routing |
| `skills/decx-app-vulnhunt/` | Skill `decx-app-vulnhunt` | Android app vulnerability hunting workflow |
| `skills/decx-framework-vulnhunt/` | Skill `decx-framework-vulnhunt` | Android framework vulnerability hunting workflow |
| `skills/decx-report/` | Skill `decx-report` | Report generation from finalized DECX analysis artifacts |
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
- Health endpoint:
  `GET /health`

### Plugin responsibilities

The JADX plugin does more than just expose the server:

- Waits until the decompiler is ready before creating DECX services
- Initializes preferences and server port
- Starts the embedded DECX HTTP server
- Extracts bundled MCP resources to `~/.decx/mcp/`
- Starts and stops the Python sidecar on `serverPort + 1`
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
- `decx process open <file>` is also reused by `decx ard framework open` and `decx ard framework run`
- Standard `jadx-cli` flags are passed through by `process open`
- `process open` enables `--show-bad-code` by default unless the flag is already present in passthrough args
- CLI sessions are tracked locally and can be reused by session name and file hash
- `decx process close` can close by session name, by `--port <port>`, or all sessions with `--all`
- CLI data defaults to `~/.decx`; set `DECX_HOME` to redirect config, sessions, logs, tmp files, output, and installed server JARs
- CLI tests set `DECX_HOME` to `.decx_test/home/.decx` and keep test-only artifacts under `.decx_test/`
- `decx self install` installs or updates `decx-server.jar`
- `decx self update` updates both the server JAR and the currently installed npm CLI package
- `decx ard framework` provides framework collection and preprocessing subcommands:
  `collect`, `process`, `pack`, `run`, `open`, `tools`
- `decx ard` also includes adb-backed inspection commands:
  `system-services`, `perm-info`
- Framework processing is implemented in native TypeScript under `decx-cli/src/android/`
- ADB interaction is centralized in `decx-cli/src/android/adb.ts`
- `decx ard system-services` returns structured JSON for live Binder/system services and supports `--serial`, `--adb-path`, and `--grep`
- `decx ard perm-info <permission>` returns one structured JSON object for a permission and supports `--serial` and `--adb-path`
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

- App and framework vuln-hunt XML artifacts under `.decx-analysis/<target>/` are named `h_<sourceId>_<sinkId>_<flowSig>.xml` for handoff and `r_<sourceId>_<sinkId>_<flowSig>.xml` for finalized results. `sourceId` and `sinkId` are base64url ids of source/sink component signatures; `flowSig` tracks the current class-level flow signature.
- Separate recon/coverage/shortlist/findings/resume JSON files are no longer the skill workflow default, and `decx-analysis.xml` should not be reintroduced.
- PoC readiness is stored in the selected result XML's `poc` block. Do not reintroduce a separate PoC handoff file unless explicitly requested.
- `skills/decx-report/` (`decx-report`) owns report templates and consumes finalized `r_<sourceId>_<sinkId>_<flowSig>.xml` artifacts; app/framework vuln-hunt skills should not duplicate report templates.
- `skills/decx-poc/scripts/setup-poc.mjs` copies `skills/decx-poc/assets/poc-template-app/` into `poc-<target>/app/` and `skills/decx-poc/assets/poc-template-server/` into `poc-<target>/server/`
- The PoC app template keeps a dynamic button registry in `ExploitRegistry` and also accepts browser-driven `poc-<target>://run/trigger?exploit=<id>` launches through `PoCActivity`

### Agent workflow harness

The workflow harness is intentionally separate from the Kotlin server and the TypeScript CLI.

- `decx-agent/decx_agent/` is the Python source of truth.
- `decx-agent/decx_agent/core/board.py` owns the Fact / Intent / Hint board model.
- `decx-agent/decx_agent/core/agent.py` owns dispatcher state transitions.
- `.decx-analysis/<target>/run.json` is a Fact / Intent / Hint board, not a fixed recon/trace/coverage task list.
- Core task kinds are only `bootstrap`, `explore`, and `reason`.
- DECX core observations are dispatcher-owned `probes` implemented in `decx-agent/decx_agent/decx/client.py`; workers request probes in JSON instead of shelling out to `decx-cli`.
- Managed DECX server lifecycle is internal and config-driven through `decx-agent/decx_agent/core/config.py` plus `decx-agent/decx_agent/decx/server.py`; do not expose it as a `decx-cli process` replacement, and do not resolve server jars from local Gradle build outputs.
- Managed mode uses the GitHub-release server jar installed by `decx self install`: explicit `server.jar`, `DECX_SERVER_HOME`, `DECX_HOME/bin/decx-server.jar`, or `~/.decx/bin/decx-server.jar`.
- Public `decx-agent` commands should stay task-oriented: `run`, `resume`, `status`, `hint`, and `workers`. Do not add raw `server`, `call`, or `probe` commands.
- Skill context is passed as file references from `decx-agent/decx_agent/core/skills.py`; worker backends receive those paths through prompts and `DECX_WORKER_REFERENCES`.
- Worker protocol lives in `decx-agent/decx_agent/workers/base.py`; subprocess-backed workers share `workers/command.py`.
- Worker backends such as `noop`, `codex`, `claude-code`, and `opencode` are bottom adapters. They receive prompts and return JSON; they do not write run state directly.
- `.opencode/plugins/decx.js` is only a JavaScript shim required by OpenCode. It registers tools and invokes `uv run decx-agent` in `decx-agent/`.
- Validate Python changes with `uv run decx-agent --json workers` and a `noop` CLI smoke test.
- The harness must not duplicate DECX analysis logic from `decx/` or process/session behavior from `decx-cli/`; it orchestrates DECX core HTTP capabilities through dispatcher probes and analysis artifacts.

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

- `DECX_VERSION` environment variable if set
- otherwise `dev`

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

- JVM toolchain: 11
- Main libraries: JADX, Javalin, Gson, Jackson, SLF4J/Logback
- Logging goes through `LogUtils`
- Error responses use `DecxError`
- Shared transport and routing live in `decx-core`; avoid duplicating server logic in plugin/server modules

Current error codes defined in `DecxError.kt`:

- `E001` internal server error
- `E002` service error
- `E003` health check failed
- `E004` method not found
- `E005` invalid parameter

### TypeScript

- ESM project (`"type": "module"`)
- Commander-based command tree
- esbuild-based bundle
- Jest-based tests
- Node.js requirement: `>=18`

### Python MCP resources

- Bundled with the plugin under `decx-plugin/src/main/resources/mcp/`
- Sidecar executor detection prefers `uv`, then `python3`, then `python`
- Non-`uv` startup checks for `requests`, `fastmcp`, and `pydantic`

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
- MCP exposure is added in `decx_mcp_server.py`

### Plugin path

For plugin-only behavior, check:

- `DecxPlugin.kt`
- `lifecycle/PluginLifecycleManager.kt`
- `mcp/SidecarProcessManager.kt`
- `ui/DecxUIManager.kt`

### Standalone server path

For headless operation, check:

- `decx-server/src/main/kotlin/jadx/plugins/decx/server/DecxServerApp.kt`

This binary:

- parses `--port`
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

1. Update `decx/decx-plugin/src/main/resources/mcp/decx_mcp_server.py`
2. Point the tool at an existing DECX HTTP endpoint when possible
3. Only add new server APIs if the capability does not already exist

### Change plugin lifecycle or MCP startup

Validate interactions across:

- `PluginLifecycleManager`
- `SidecarProcessManager`
- `PreferencesManager`
- `DecxUIManager`

Port coordination matters:

- DECX HTTP server uses the configured port
- MCP sidecar uses `port + 1`

## Key Files

| File | Why it matters |
|---|---|
| `AGENTS.md` | This repository guide for coding agents |
| `README.md` / `README_zh.md` | User-facing product and usage docs |
| `decx/settings.gradle.kts` | Gradle module inclusion |
| `decx/build.gradle.kts` | Root versioning, repositories, `dist` aggregation task |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/http/DecxServer.kt` | Javalin server and route registration |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/http/RouteHandler.kt` | Endpoint-to-API dispatch |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/api/DecxApi.kt` | Shared API contract |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/api/DecxApiImpl.kt` | Core API implementation |
| `decx/decx-core/src/main/kotlin/jadx/plugins/decx/model/DecxError.kt` | Structured error codes |
| `decx/decx-plugin/src/main/kotlin/jadx/plugins/decx/DecxPlugin.kt` | JADX plugin entry point |
| `decx/decx-plugin/src/main/kotlin/jadx/plugins/decx/lifecycle/PluginLifecycleManager.kt` | Startup sequencing and warmup |
| `decx/decx-plugin/src/main/kotlin/jadx/plugins/decx/mcp/SidecarProcessManager.kt` | Sidecar extraction, startup, shutdown |
| `decx/decx-plugin/src/main/kotlin/jadx/plugins/decx/ui/DecxUIManager.kt` | Plugin UI and restart actions |
| `decx/decx-plugin/src/main/resources/mcp/decx_mcp_server.py` | MCP tool surface |
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

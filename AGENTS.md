# AGENTS.md

Coding agent instructions for the DECX repository.

## Repository Purpose

DECX (`Decompiler + X`) is an AI-oriented analysis layer built on top of JADX.
The repository contains:

- A Kotlin HTTP analysis server shared by plugin mode and standalone mode
- A JADX GUI plugin that starts the DECX server and manages a Python MCP sidecar
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
| `decx/decx-core/` | Kotlin, JVM 11 | Shared API, HTTP transport, services, models, utilities |
| `decx/decx-plugin/` | Kotlin, Shadow JAR | JADX GUI plugin, lifecycle, UI, MCP sidecar management |
| `decx/decx-server/` | Kotlin, Shadow JAR | Standalone headless server with `DecxServerApp` main class |
| `decx/decx-plugin/src/main/resources/mcp/` | Python 3.10+ | Bundled MCP server resources extracted to `~/.decx/mcp/` |
| `decx-cli/` | TypeScript, Node.js 22.5+ | User CLI for session management and analysis commands |
| `decx-agent/src/server/` | TypeScript, Node.js 22.5+ | SQLite state, local API, and Web audit UI for the standalone agent |
| `decx-agent/src/dispatcher/` | TypeScript, Node.js 22.5+ | Cairn-style bootstrap/reason/explore/review loop and workflow routing |
| `decx-agent/src/roles/` | TypeScript, Node.js 22.5+ | Built-in and configured role prompt registry |
| `decx-agent/src/workers/` | TypeScript, Node.js 22.5+ | Bottom adapters for command and model workers |
| `skills/decx-cli/` | Skill `decx-cli` | DECX CLI usage, general analysis, and workflow routing |
| `skills/decx-app-vulnhunt/` | Skill `decx-app-vulnhunt` | Android app vulnerability hunting workflow |
| `skills/decx-framework-vulnhunt/` | Skill `decx-framework-vulnhunt` | Android framework vulnerability hunting workflow |
| `skills/decx-report/` | Skill `decx-report` | Report generation from finalized blackboard findings |
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

- Skill architecture and authoring rules are defined in `skills/AGENTS.md`.
- Vulnerability hunting skills use a SQLite blackboard architecture. Each target gets one `decx-analysis.db` under `.decx-analysis/<target>/`. App hunts initialize with `--kind android_app`; framework hunts initialize with `--kind android_framework`. The blackboard is driven by Facts (immutable observations whose descriptions carry the observation type), Intents (exploration goals), Events (audit trail), and links/chains. Chains emerge from the fact→intent→fact graph when evidence proves a complete path. The blackboard CLI is `scripts/decx-analysis-db.mjs`.
- `skills/decx-report/` (`decx-report`) owns report templates and consumes finalized blackboard findings; app/framework vuln-hunt skills should not duplicate report templates.
- `skills/decx-poc/scripts/setup-poc.mjs` copies `skills/decx-poc/assets/poc-template-app/` into `poc-<target>/app/` and `skills/decx-poc/assets/poc-template-server/` into `poc-<target>/server/`
- The PoC app template keeps a dynamic button registry in `ExploitRegistry` and also accepts browser-driven `poc-<target>://run/trigger?exploit=<id>` launches through `PoCActivity`

### Agent framework

The agent is a generic, configured TypeScript framework intentionally separate from the Kotlin server and the deterministic `decx` CLI.

- `decx-agent` is bundled as a standalone binary. Do not add a `decx agent` bridge command.
- Public commands are `run <config>`, `resume`, `status`, `workers`, and `serve`.
- There are no fixed business task subcommands; vulnerability hunting, cloud-control analysis, attribution, parameter reversal, and other tasks are expressed by `task.json`, prompt files, roles, and workflow rules.
- Runtime state is stored in SQLite at `.decx/agent_tasks/agent.sqlite` by default.
- Session directories under `.decx/agent_tasks/<session>/` hold `task.json`, prompt files, and task-local artifacts.
- The dispatcher loop has `bootstrap`, `reason`, `explore`, and asynchronous `review` phases.
- Built-in roles are `planner`, `dispatcher`, `executor`, `explorer`, and `reviewer`; task configs can extend them with prompt-defined roles.
- Worker backends are bottom adapters. They receive prompts and return JSON; they do not own agent state. CLI runners (`codex`, `claude-code`, `opencode`, plus any custom command) use `kind: "command"`. Model runners (`api`, `openai`, `anthropic`, `openai-compatible`, plus any custom `ModelProvider`) use `kind: "model"` and are matched by id through `src/workers/providers/registry.ts`, which wraps the official `openai` and `@anthropic-ai/sdk` SDKs. New model providers are added with `registerProvider(...)` — no source edit required. The legacy `api` `WorkerKind` is gone; the `api` worker name still resolves to `model`.
- Command workers are split into a driver registry plus command adapter/base helpers under `decx-agent/src/workers/`; configured command workers support prompt/session/path placeholders, optional `sessionStrategy` (`none`, `stable`, `uuid`, `regex`), optional `sessionPattern`, and `responseMode: "jsonl-assistant-text"` for JSONL agent output.
- `.opencode/plugins/decx.js` only registers the repository `skills/` directory with OpenCode's `skills.paths`; do not add unfinished `decx-agent` tool shims there.
- Validate agent changes with `cd decx-agent && npm run build && npm run smoke`, plus `cd decx-cli && npm run build && npm test`.

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

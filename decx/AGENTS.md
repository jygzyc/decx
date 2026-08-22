# AGENTS.md

Coding agent instructions for the DECX Kotlin modules.

Broader repository context (CLI, skills, agent) is in the root `AGENTS.md`.

## Module Architecture

```
decx-core (shared library, compile-only JADX dependency)
  → decx-plugin (JADX GUI plugin, Shadow JAR)
  → decx-server (standalone headless server, Shadow JAR with full JADX runtime)
decx-taint (self-contained taint module, DecxExtension SPI impl; also builds the
            standalone Tai-e worker fat jar — bundled by decx-server/decx-plugin)
```

- `decx-core/`: API contract (`api/`), HTTP & MCP server transport (`server/`), service layer (`service/`), utilities (`utils/`), public facade (`Decx.kt`), extension SPI (`extension/`)
- `decx-plugin/`: Plugin lifecycle management, Swing UI, MCP controls
- `decx-server/`: `DecxServerApp` main class, fat JAR bundling
- `decx-taint/`: everything taint — JSON rules (`taint/rules/`), request config (`taint/config/`), async job manager, worker pool, NDJSON protocol (`taint/protocol/`), and the Tai-e worker entry points (`taint/worker/`); on the classpath of decx-server / decx-plugin only

## Extension SPI (taint is a plugin)

`decx-core` has **no taint code**. Optional analysis capabilities mount through
`extension/DecxExtension.kt`, discovered via `ServiceLoader`
(`META-INF/services/jadx.plugins.decx.extension.DecxExtension`):

- `decx-taint` implements the SPI and ships the service registration file;
  `decx-server` and `decx-plugin` bundle it as a dependency, so taint routes
  (`/api/decx/taint/config|analyze|progress`) and MCP tools
  (`taint_config` / `taint_analyze` / `taint_progress`) exist only when the
  module is loaded.
- `DecxExtensions.isAvailable()` gates registration: without the Tai-e worker
  environment the extension is silent and contributes no routes/tools.
- To add a new capability, create a module implementing `DecxExtension`;
  never add capability code back into `decx-core`.

### decx-taint internals

- **Rules**: appshark-style JSON documents (one file = many named rules;
  built-ins under `src/main/resources/taint/rules/`). `TaintRuleParser`
  validates signatures/positions; `TaintRuleCompiler` merges selected rules
  into one Tai-e taint fragment and attributes reported flows back to rules.
- **Async jobs**: `analyze` validates then returns `{jobId}`;
  `TaintJobManager` serializes execution (`queued → running →
  succeeded|failed|cancelled`, bounded queue, progress ring buffer);
  `progress` returns state/log and, on success, attributed flows.
- **Worker**: `TaintWorkerPool` spawns a fresh JVM per analysis (classpath =
  Tai-e dist lib + worker fat jar, no Tai-e inside any shipped jar);
  `worker/TaiEEngine.kt` drives `pascal.taie.Main` and reads back taint flows.
- **Build**: `fetchTaiE` downloads the official Tai-e release zip once
  (`DECX_TAIE_ZIP` overrides offline) into `build/taie/lib`, consumed as
  `compileOnly` — the full lib dir is required at compile time because Tai-e's
  API references Soot/Jackson/ASM types. `shadowJar` is repurposed as the
  worker binary; consumers get the plain jar
  (`shadowRuntimeElements.isCanBeConsumed = false`).

## Architecture Layers

| Package    | Layer         | Key classes                              |
|------------|---------------|------------------------------------------|
| `api/`     | API contract  | DecxApi, DecxApiResult, DecxError        |
| `server/`  | Transport     | DecxServer, DecxMcpServer, RouteHandler  |
| `service/` | Business logic | CommonService, ContextService, ...      |
| `utils/`   | Infra         | AnalysisResultUtils, CacheUtils, ...     |

## Key Patterns

| Pattern | Where | Purpose |
|---|---|---|
| `DecxApi` interface + `DecxApiImpl` | `api/` | Define all operations as interface; implement with caching in impl |
| `Decx` facade | root `Decx.kt` | Public embeddable entry point for API, HTTP server, MCP server, routes, and tools |
| `DecxRouteGroup(name, routes)` | `api/DecxApiContract.kt` | Canonical service-extension format; groups route registration by service |
| `DecxRoute(path, kind, invoke)` | `api/DecxApiContract.kt` | Type-safe route registration; no HTTP dependency |
| `DecxApiResult(success, data)` | `api/DecxApiResult.kt` | Unified return envelope for all API methods |
| `DecxRequestParams` | `api/` | Type-safe parameter extraction from request map |
| `DecxFilter` | `api/` | Includes/excludes with regex, limit, literal matching |
| `DecxError` enum | `api/` | Structured error codes with format string |
| `DecxConstants` object | Root | Global constants (port, paths) |
| `DecxService` / `DecompilerBackedService` / `UiBackedService` | `service/DecxService.kt` | Uniform service contract and UI/decompiler capability marker |
| `AnalysisResultUtils` | `utils/` | Response formatting helpers |
| `DecompileGuard` | `utils/` | Centralized guarded access to `JavaClass.decompile()` for high-memory cases |

## Response Helpers

All service methods return `DecxApiResult`. For new service code prefer the unified helpers on `DecxApiResult`:

```kotlin
DecxApiResult.success(kind, query, items, summary)
DecxApiResult.error(kind, query, DecxError.METHOD_NOT_FOUND, "methodName")
```

The response body shape is stable across HTTP and MCP:

- Success: `ok`, `kind`, `query`, `summary`, `items`, `page`
- Failure: `ok`, `kind`, `query`, `error`

## Error Handling

- Always use `DecxError` enum for error codes. Do not invent new codes.
- Format with `DecxError.format(*args)` for parameterized messages.
- Log errors via `LogUtils.error(tag, message)`.
- Current codes include: `INTERNAL_ERROR`, `SERVICE_ERROR`, `REQUEST_TIMEOUT`, `HEALTH_CHECK_FAILED`, `UNKNOWN_ENDPOINT`, `INVALID_PARAMETER`, `METHOD_NOT_FOUND`, `CLASS_NOT_FOUND`, `RESOURCE_NOT_FOUND`, `MANIFEST_NOT_FOUND`, `FIELD_NOT_FOUND`, `INTERFACE_NOT_FOUND`, `SERVICE_IMPL_NOT_FOUND`, `NO_STRINGS_FOUND`, `NO_MAIN_ACTIVITY`, `NO_APPLICATION`, `EMPTY_SEARCH_KEY`, `DECOMPILATION_SKIPPED`, `NOT_GUI_MODE`.

## Decompiler Memory Guard

High-memory decompiler operations must go through `DecompileGuard`.

- Do not call `JavaClass.decompile()` directly from services or utilities.
- Use `DecompileGuard.decompile(clazz, purpose)` with the closest purpose: `JAVA`, `SMALI`, `WARMUP`, or `XREF`.
- Java source paths should not pre-read `clazz.smali` just to estimate class size.
- Smali paths may use `Purpose.SMALI`; this checks smali size and avoids extra Java decompilation.
- Xref helpers such as `CodeUtils.buildUsageQuery` must remain guarded because they can trigger hidden decompilation.
- Guard thresholds are tunable with JVM properties:
  `-Ddecx.decompile.maxSmaliChars`,
  `-Ddecx.decompile.maxMethods`,
  `-Ddecx.decompile.minFreeHeapBytes`.
- Guard skip decisions are logged via `LogUtils.warn` with class name, purpose, reason, heap, and threshold details.
- If decompilation is skipped for a user-facing request, return `DecxError.DECOMPILATION_SKIPPED`.

## Coding Conventions

- JVM toolchain: 17
- Base package: `jadx.plugins.decx`
- Use `data class` for models, `object` for singletons
- All public API methods defined in `DecxApi` interface
- All service methods return `DecxApiResult`
- No Chinese characters in source code
- Logging goes through `LogUtils`, not `println`
- Error responses use `DecxError`, not raw exceptions

## Add a New API Endpoint

1. Add method signature to `DecxApi` interface (`api/DecxApi.kt`).
2. Implement in `DecxApiImpl` (`api/DecxApiImpl.kt`) by delegating to a service.
3. Add business logic in the relevant `service/*Service.kt`; service classes should implement `DecompilerBackedService` or `UiBackedService` as appropriate.
4. Register routes in `DecxApiContract.kt` by adding a `DecxRouteGroup(name, routes)` and including it in `DecxRoutes.groups`.
5. If the endpoint should be MCP-visible, add a matching `McpTool` in `mcp/McpToolRegistry.kt`; use `McpToolRegistry.toolOf()` / `toolsForRoute()` for lookups.
6. Update CLI command in `decx-cli/src/commands/` — keep help text aligned.

## Build Commands

```bash
cd decx
./gradlew dist              # Build all artifacts (plugin + server + taint worker)
./gradlew :decx-plugin:shadowJar   # Plugin fat JAR
./gradlew :decx-server:shadowJar   # Server fat JAR
./gradlew :decx-taint:shadowJar    # Tai-e taint worker fat JAR
./gradlew test               # Run tests
```

Artifacts: `decx/build/dist/jadx_decx_plugin-<version>.jar`, `decx/build/dist/decx-server-<version>.jar`, `decx/build/dist/decx-taint-worker.jar`

Version source: repository-root `version` file

## Key Files

| File | Role |
|---|---|
| `decx/settings.gradle.kts` | Module inclusion |
| `decx/build.gradle.kts` | Root versioning, repositories, dist task |
| `decx/decx-core/.../Decx.kt` | Public facade for embedders |
| `decx/decx-core/.../server/DecxServer.kt` | Javalin server startup and route registration |
| `decx/decx-core/.../server/RouteHandler.kt` | Endpoint-to-API dispatch |
| `decx/decx-core/.../api/DecxApi.kt` | Public API interface |
| `decx/decx-core/.../api/DecxApiResult.kt` | Unified API result envelope and response helpers |
| `decx/decx-core/.../api/DecxApiImpl.kt` | API implementation with caching |
| `decx/decx-core/.../api/DecxApiContract.kt` | Route groups and route contract table |
| `decx/decx-core/.../api/DecxFilter.kt` | Filtering and pagination |
| `decx/decx-core/.../api/DecxRequestParams.kt` | Request parameter parsing |
| `decx/decx-core/.../api/DecxError.kt` | Error codes |
| `decx/decx-core/.../service/DecxService.kt` | Service extension contract |
| `decx/decx-core/.../utils/LogUtils.kt` | Logging wrapper |
| `decx/decx-core/.../utils/AnalysisResultUtils.kt` | Response formatting |
| `decx/decx-core/.../utils/DecompileGuard.kt` | Guarded decompilation and high-memory skip logging |
| `decx/decx-core/.../utils/WarmupUtils.kt` | Background decompiler warmup with guarded decompilation |
| `decx/decx-plugin/.../DecxPlugin.kt` | Plugin entry point |
| `decx/decx-plugin/.../lifecycle/PluginLifecycleManager.kt` | Plugin lifecycle |
| `decx/decx-core/.../server/DecxMcpServer.kt` | MCP server lifecycle |
| `decx/decx-core/.../server/McpHttpServer.kt` | Official Kotlin SDK MCP Streamable HTTP transport |
| `decx/decx-core/.../server/McpToolRegistry.kt` | MCP tool registry backed by DecxRoutes |
| `decx/decx-plugin/.../ui/DecxUIManager.kt` | Plugin UI |
| `decx/decx-server/.../server/DecxServerApp.kt` | Standalone server main |

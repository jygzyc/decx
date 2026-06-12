# AGENTS.md

Coding agent instructions for the DECX Kotlin modules.

Broader repository context (CLI, skills, agent) is in the root `AGENTS.md`.

## Module Architecture

```
decx-core (shared library, compile-only JADX dependency)
  → decx-plugin (JADX GUI plugin, Shadow JAR)
  → decx-server (standalone headless server, Shadow JAR with full JADX runtime)
```

- `decx-core/`: Javalin HTTP server, API interface and implementation, service layer, data models, utilities
- `decx-plugin/`: Plugin lifecycle management, Swing UI, MCP sidecar process management
- `decx-server/`: `DecxServerApp` main class, fat JAR bundling

## Architecture Layers

```
HTTP Layer   (DecxServer, RouteHandler)
  ↓
API Layer    (DecxApi interface → DecxApiImpl with caching)
  ↓
Service     (CommonService, AndroidService, ContextService, UIService)
  ↓
JADX        (Decompiler API)
```

## Key Patterns

| Pattern | Where | Purpose |
|---|---|---|
| `DecxApi` interface + `DecxApiImpl` | `api/` | Define all operations as interface; implement with caching in impl |
| `DecxRoute(path, kind, invoke)` | `api/DecxApiContract.kt` | Type-safe route registration; no HTTP dependency |
| `DecxApiResult(success, data)` | `api/` | Unified return type for all API methods |
| `DecxRequestParams` | `api/` | Type-safe parameter extraction from request map |
| `DecxFilter` | `api/` | Includes/excludes with regex, limit, literal matching |
| `DecxError` enum | `model/` | Structured error codes with format string |
| `DecxConstants` object | Root | Global constants (port, paths) |
| `DecxServiceInterface` | `model/` | Marker interface for service classes |
| `AnalysisResultUtils` | `utils/` | Response formatting helpers |
| `DecompileGuard` | `utils/` | Centralized guarded access to `JavaClass.decompile()` for high-memory cases |

## Response Helpers

All service methods return `DecxApiResult`. Use the helpers from `AnalysisResultUtils`:

```kotlin
success(kind, query, items, summary)
error(kind, query, DecxError.METHOD_NOT_FOUND, "methodName")
```

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

- JVM toolchain: 11
- Base package: `jadx.plugins.decx`
- Use `data class` for models, `object` for singletons
- All public API methods defined in `DecxApi` interface
- All service methods return `DecxApiResult`
- No Chinese characters in source code
- Logging goes through `LogUtils`, not `println`
- Error responses use `DecxError`, not raw exceptions

## Add a New API Endpoint

1. Add method signature to `DecxApi` interface (`api/DecxApi.kt`)
2. Implement in `DecxApiImpl` (`api/DecxApiImpl.kt`)
3. Add business logic in the relevant service under `service/`
4. Register route in `DecxApiContract` (`api/DecxApiContract.kt`): `DecxRoute(path, kind, invoke)`
5. Register HTTP endpoint in `DecxRoutes` (`http/DecxRoutes.kt`)
6. Update CLI command in `decx-cli/src/commands/` — keep help text aligned
7. Update MCP tool in `decx/decx-plugin/src/main/resources/mcp/decx_mcp_server.py`

## Build Commands

```bash
cd decx
./gradlew dist              # Build all artifacts
./gradlew :decx-plugin:shadowJar   # Plugin fat JAR
./gradlew :decx-server:shadowJar   # Server fat JAR
./gradlew test               # Run tests
```

Artifacts: `decx/build/dist/jadx_decx_plugin-<version>.jar`, `decx/build/dist/decx-server-<version>.jar`

Version source: repository-root `version` file

## Key Files

| File | Role |
|---|---|
| `decx/settings.gradle.kts` | Module inclusion |
| `decx/build.gradle.kts` | Root versioning, repositories, dist task |
| `decx/decx-core/.../http/DecxServer.kt` | Javalin server startup and route registration |
| `decx/decx-core/.../http/RouteHandler.kt` | Endpoint-to-API dispatch |
| `decx/decx-core/.../api/DecxApi.kt` | Public API interface |
| `decx/decx-core/.../api/DecxApiImpl.kt` | API implementation with caching |
| `decx/decx-core/.../api/DecxApiContract.kt` | Route contract table |
| `decx/decx-core/.../api/DecxFilter.kt` | Filtering and pagination |
| `decx/decx-core/.../api/DecxRequestParams.kt` | Request parameter parsing |
| `decx/decx-core/.../model/DecxError.kt` | Error codes |
| `decx/decx-core/.../model/DecxServiceInterface.kt` | Service marker interface |
| `decx/decx-core/.../utils/LogUtils.kt` | Logging wrapper |
| `decx/decx-core/.../utils/AnalysisResultUtils.kt` | Response formatting |
| `decx/decx-core/.../utils/DecompileGuard.kt` | Guarded decompilation and high-memory skip logging |
| `decx/decx-core/.../utils/WarmupUtils.kt` | Background decompiler warmup with guarded decompilation |
| `decx/decx-plugin/.../DecxPlugin.kt` | Plugin entry point |
| `decx/decx-plugin/.../lifecycle/PluginLifecycleManager.kt` | Plugin lifecycle |
| `decx/decx-plugin/.../mcp/SidecarProcessManager.kt` | Sidecar management |
| `decx/decx-plugin/.../ui/DecxUIManager.kt` | Plugin UI |
| `decx/decx-server/.../server/DecxServerApp.kt` | Standalone server main |

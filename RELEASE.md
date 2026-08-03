# DECX v4.0.0

DECX v4.0.0 is a breaking release covering everything since v3.4.1: the CLI `ard` group is renamed to `android`, the `-P` short option is reclaimed for JADX project properties, three HTTP/MCP endpoints are renamed to match CLI command names, `process open` switches to file-first session reuse, the OpenCode plugin control plane is removed in favor of installed skills, and the server gets a decompile-cache / symbol-index / route-telemetry rework on Javalin 7.

### Breaking

- CLI: `decx ard` command group renamed to `decx android` (`ard-app` → `android-app`, `ard-device` → `android-device`, `ard-framework` → `android-framework`, `ard-shared` → `android-shared`); `decx ard` no longer exists.
- CLI: the `-P, --port` short option is removed from `process open` / `process check` / `process status` / `process close`. `-P<key>=<value>` tokens are now always forwarded to jadx-cli as JADX project properties; the server port is set with `--port` only.
- HTTP/MCP API: three endpoints renamed to match CLI command names — `/api/decx/get_implement` → `/api/decx/get_implementations`, `/api/decx/get_sub_classes` → `/api/decx/get_subclasses`, `/api/decx/get_aidl` → `/api/decx/get_aidl_interfaces`. The `getImplementOfInterface` API method is renamed to `getImplementations`.
- CLI: `process open` session reuse is now file-first — an alive session already holding the same file (by sha256) is reused regardless of name; opening a different file under an existing session name is refused with a `--force` / `--name` hint instead of silently shadowing the record.
- OpenCode: the plugin control plane under `.opencode/` is removed (graph engine, role-scoped `decx_planner_*` / `decx_explorer_*` / `decx_evaluator_*` / `decx_metacog_*` / `decx_graph_*` / `decx_cross_*` function tools, analysis profiles, agents, SQLite analysis database). DECX is no longer installed through the `plugin` array in `opencode.json`; install the `skills/` directory into the agent's skills path instead (e.g. `~/.config/opencode/skills`). A zero-dependency plugin at `.opencode/plugins/decx.js` only injects a routing hint pointing at the installed skills.
- Server: background warmup is removed — `WarmupUtils` and `CacheUtils` are deleted; decompilation is triggered on demand through the reworked `DecompileGuard` (compressed source cache, high-memory skip, `-D decx.decompile.*` tunables) instead of a startup warmup pass.

### Changes

- Server: Javalin upgraded 6.7.0 → 7.2.2 and route registration moved to the `config.routes` DSL (`/health` GET plus one POST per `DecxRoutes` entry).
- Server: `DecompileGuard` is now the single decompile authority: limit checking, decompile triggering, and a compressed whole-class source cache (Deflater/Inflater, per-class keys, hit/miss and byte stats) so repeated source reads never re-decompile.
- Server: new `SymbolIndex` — lazy class/method name inventory backing `get_classes` / `search_method`; invalidated together with the decompile cache.
- Server: new `RouteTelemetry` — in-flight operation and per-endpoint latency tracking exposed through `/health` (`active_operations`, `endpoint_stats`, `cache` snapshots) and logs.
- Server: new Kotlin test suites: `DecxFilterTest`, `DecxRoutesTest`, `AnalysisResultUtilsTest`, `DecompileGuardCacheTest`, `RouteTelemetryTest`.
- CLI: `process open` auto-assigns a free random port in 30000–40000 when `--port` is omitted (availability-checked, retried on collision, MCP-aware).
- CLI: `process check` and `process status` auto-select the only alive session when `--port` is omitted, and stale session records are cleaned up before selection.
- CLI: `self update` reworked — npm executable resolution (npm.cmd on Windows, PATH prefixing) for reliable updates; framework artifact pulls use relative staging paths to fix WSL/Windows `adb.exe` layouts; `zip`/`unzip` shelling out replaced by `adm-zip`.
- Dependencies: jadx 1.5.5 → 1.5.6, ktor 3.4.3 → 3.5.1, jackson 2.22.0 → 2.22.1, logback 1.5.34 → 1.5.38, shadow 9.0.0-beta10 → 9.5.1, gradle wrapper 9.6.0 → 9.6.1.
- Skills: the `decx-agent` TypeScript framework is removed from the repository (extracted to a standalone project); the shared `decx-analysis-core` DAG protocol (introduced after v3.4.1) is dropped; `decx-app-vulnhunt` and `decx-framework-vulnhunt` are consolidated into one `decx-vulnhunt` skill with App/Framework tracks, `app_*` / `framework_*` pattern cards, and a single risk-rating authority; `decx-report` drops the 1031-line `decx-analysis-db.mjs` script for a `references/` structure (finding-intake, report-structure, composition-section); confidence gates and band documentation propagate through `decx-cli` / `decx-poc` / `decx-report`.
- CLI: `package-lock.json` is no longer tracked; `decx-cli` test suites extended (`process.test.ts`, `help.test.ts`, `self.test.ts`, `framework.test.ts`).
- Docs: README / README_zh / AGENTS.md synced with the `android` rename, `--port` behavior, endpoint renames, and the skill consolidation.

### Fix

- CLI: `decx self update` no longer fails to spawn npm on Windows — the npm executable is resolved explicitly (`npm.cmd` on Windows, with PATH prefixing) instead of relying on the shell.
- CLI: framework `collect` / `process` staging no longer breaks on WSL/Windows where `adb.exe` lives outside the WSL PATH.

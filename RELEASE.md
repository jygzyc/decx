# DECX v3.4.1

DECX v3.4.1 is a maintenance release that hardens CLI server-port handling and aligns MCP transport with the stateless Kotlin SDK variant. No analysis capabilities change.

### Fix

- CLI: new `decx-cli/src/core/ports.ts` with `parseServerPort` enforcing the valid range (1001–65535); invalid `--port` values now fail fast with a clear `ProcessError`.
- CLI: `process open` no longer aborts when the preferred port is taken. `selectAvailableServerPort` keeps the requested port when free and otherwise falls back to a random available port; when `--mcp` is set it also verifies `port + 1` is free (up to 20 retries).
- CLI: `process check` now reports port availability via `isServerPortAvailable` (true bind probe) instead of inferring from an HTTP ping.
- CLI: `resolveClient` and `process close --port` route port parsing through `parseServerPort` so the same validation applies everywhere.
- CLI: `code search-global` help text clarified — it searches class names and decompiled class bodies (not method/resource text).
- Server: switched the MCP HTTP transport to the stateless variant (`mcpStatelessStreamableHttp`) in `McpHttpServer`.
- Skills: `decx-cli` skill updated to document `process status` variants, the `--mcp` flag, the corrected `search-global` scope, and the "look up the exact method signature via `search-method`" workflow.
- Chore: `.env` added to `.gitignore`.

# DECX v3.4.0

DECX v3.4.0 replaces the Python MCP sidecar with an in-process Kotlin SDK server, eliminating the separate runtime and file-based IPC. The MCP Streamable HTTP endpoint is now opt-in via `--mcp` on both the standalone server and the CLI.

### Changes

- Server: replaced the Python MCP sidecar (`decx_mcp_server.py` + `SidecarProcessManager`) with the official Kotlin MCP SDK (`io.modelcontextprotocol:kotlin-sdk-server` 0.13.0) over Ktor CIO Streamable HTTP, running in-process on `serverPort + 1`.
- Server: package consolidation — `http/` merged into `server/` (DecxServer, RouteHandler, new DecxMcpServer / McpHttpServer / McpToolRegistry); `model/` dissolved (DecxError → `api/`, DecxServiceInterface → `service/DecxService`).
- Server: new public `Decx` facade (`decx-core/.../Decx.kt`) as the embeddable entry point for API, HTTP server, MCP server, routes, and tools.
- Server: new unified `DecxApiResult` envelope shared across HTTP and MCP responses.
- Server: MCP is disabled by default; enable with `--mcp` on `decx-server` or `decx process open`.
- Plugin: in-process MCP server with auto-start driven by preferences; removed `SidecarProcessManager` and `McpPreferences`.
- Plugin: removed bundled `resources/mcp/` Python files (`.python-version`, `decx_mcp_server.py`, `pyproject.toml`, `requirements.txt`).
- CLI: added `--mcp` flag to `decx process open` — forwards `--mcp` to `decx-server` and reports `mcpPort` (HTTP port + 1) in the session result.
- CLI: `extractPassthroughArgs` now strips `--mcp` / `--no-mcp` so they are not forwarded to jadx-cli.
- Docs: updated `decx/AGENTS.md` with the new server/MCP architecture, package layout, and port contract.

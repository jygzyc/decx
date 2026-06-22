# DECX v3.4.0

DECX v3.4.0 replaces the Python MCP sidecar with an in-process Kotlin SDK server, eliminating the separate runtime and file-based IPC. The MCP Streamable HTTP endpoint is now opt-in via `--mcp` on the standalone server and via the plugin's auto-start checkbox. The JVM toolchain is also bumped from 11 to 17.

### Changes

- Server: replaced the Python MCP sidecar (`decx_mcp_server.py` + `SidecarProcessManager`) with the official Kotlin MCP SDK (`io.modelcontextprotocol:kotlin-sdk-server` 0.13.0) over Ktor CIO Streamable HTTP, running in-process on `serverPort + 1`.
- Server: package consolidation — `http/` merged into `server/` (DecxServer, RouteHandler, new DecxMcpServer / McpHttpServer / McpToolRegistry); `model/` dissolved (DecxError → `api/`, DecxServiceInterface → `service/DecxService`).
- Server: new public `Decx` facade (`decx-core/.../Decx.kt`) as the embeddable entry point for API, HTTP server, MCP server, routes, and tools.
- Server: new unified `DecxApiResult` envelope shared across HTTP and MCP responses.
- Server: MCP is disabled by default; enable with `--mcp` on `decx-server`.
- Server: `DecxServerApp` help text now references the current CLI name (`decx`).
- Build: bumped JVM toolchain from 11 to 17 in `decx/build.gradle.kts`; CI already used JDK 17.
- Plugin: in-process MCP server with auto-start driven by preferences; removed `SidecarProcessManager` and `McpPreferences`.
- Plugin: removed bundled `resources/mcp/` Python files (`.python-version`, `decx_mcp_server.py`, `pyproject.toml`, `requirements.txt`).
- Plugin: fixed the settings dialog where the OK/Cancel and Start/Stop MCP buttons could be pushed off-screen by BoxLayout stretching — switched from `JOptionPane` to a `JDialog` with `BorderLayout`, and clamped FlowLayout rows to their preferred height.
- Plugin: dropped the redundant "Implementation: Kotlin SDK" info row from the settings panel.
- CLI: added `--mcp` flag to `decx process open` — forwards `--mcp` to `decx-server` and reports `mcpPort` (HTTP port + 1) in the session result.
- CLI: `extractPassthroughArgs` now strips `--mcp` / `--no-mcp` so they are not forwarded to jadx-cli.
- CLI: `checkForServerUpdate` now uses a 5s fetch timeout so `decx self update` cannot hang on a slow GitHub API response.
- CLI: `client.test.ts` switched from environment-dependent tests to a typed `jest.fn<typeof fetch>` mock covering success, failure, and structured error responses.
- Docs: synced `README.md`, `README_zh.md`, root `AGENTS.md`, and `decx/AGENTS.md` with the new server/MCP architecture, package layout, error codes, Java 17 toolchain, and removed Python prerequisites.

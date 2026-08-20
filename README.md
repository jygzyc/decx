# DECX - Decompiler + X

<div align="center">

![DECX Logo](https://img.shields.io/badge/DECX-Decompiler%20%2B%20X-blue?style=for-the-badge&logo=java&logoColor=white)
![Release](https://img.shields.io/github/v/release/jygzyc/decx?style=for-the-badge&logo=github&color=green)
![License](https://img.shields.io/github/license/jygzyc/decx?style=for-the-badge&logo=gnu&color=orange)

**A JADX-based Decompiler + X - Designed for AI-assisted code analysis**

</div>

---

## Overview

DECX (Decompiler + X) is a smart code analysis platform built on the JADX decompiler, designed specifically for AI-assisted code analysis. The platform provides powerful Java code analysis capabilities to AI assistants through an HTTP API, MCP (Model Context Protocol), a standalone CLI, and workflow skills.

---

## Installation

### Prerequisites

- **Java**: JDK 17+
- **Node.js**: 22.5+ for the CLI
- **JADX**: v1.5.2+ with plugin support if you use the GUI plugin

### CLI And AI Skills

For AI-assisted CLI work, install the CLI and server JAR, then download the DECX skills for your agent:

```bash
npm install -g @jygzyc/decx-cli
decx self install
decx self skills install --client opencode --client codex
```

The CLI checks for updates in the background on startup: the result is cached under `DECX_HOME` for 24 hours and the check never blocks or breaks the command you ran. When a newer release exists, a one-line hint on stderr points you to `decx self update`. Set `DECX_NO_UPDATE_CHECK=1` to disable the check.

#### Windows `spawnSync npm.cmd EINVAL` during `self update`

CLI versions older than v4.0.1 started `npm.cmd` directly on Windows, which can return `EINVAL` with some Node.js versions. An affected CLI cannot bootstrap this fix through `self update`; update it once from PowerShell or CMD instead:

```powershell
npm.cmd install -g @jygzyc/decx-cli@latest
```

Reopen the terminal and run `decx --version` to confirm v4.0.1 or newer before using `decx self update` again. If an older version is still selected, run `where.exe decx` to check for multiple DECX CLI installations on PATH.

Skills are downloaded to `~/.decx/skills` (or `$DECX_HOME/skills`) and linked into the selected client directories:

| Agent | Link target |
|---|---|
| Claude Code | `~/.claude/skills` |
| Opencode | `~/.agents/skills` |
| Codex | `~/.codex/skills` |
| Common agent setup | `~/.agents/skills` |

The `skills/` directory contains:

| Skill | Use |
|---|---|
| `decx-cli` | DECX CLI usage, general code navigation, source lookup, xrefs, manifest/resource inspection, and workflow routing |
| `decx-vulnhunt` | Android vulnerability hunting (App + Framework tracks): exported components, WebView/Provider/Service/Receiver, Binder/system services, AIDL |
| `decx-poc` | Build a focused Android PoC app and optional helper server from one finalized finding writeup |
| `decx-report` | Generate HTML/Markdown reports from finalized finding writeups |

### JADX Plugin

Install the plugin from the JADX GUI plugin manager, or install a plugin JAR manually:

```bash
jadx plugins --install-jar <path-to-jadx_decx_plugin.jar>
```

After installation, open an APK/JAR in JADX and enable DECX. The plugin exposes the DECX HTTP API and MCP tools for the currently opened JADX project.

---

## Usage

### CLI + Skills

For agent-driven analysis, use the CLI to create a session and let the installed skills drive the detailed workflow:

```bash
decx process open target.apk --name target
decx code classes --limit 50
decx code search-global "WebView" --limit 20
decx android exported-components
decx android deep-links
decx process close target
decx process close --port 25419
```

Typical skill sequence:

- `decx-cli` for exploration, evidence gathering, and routing
- `decx-vulnhunt` for focused vulnerability hunting (App or Framework track)
- `decx-report` for generating reports from finalized finding writeups
- `decx-poc` for turning one finalized finding writeup into a buildable PoC

Vulnerability hunting keeps notes and finalized finding writeups in the working directory. Downstream report and PoC skills consume those finding writeups.

Useful command groups:

| Need | Commands |
|---|---|
| Session lifecycle | `decx process open <file>`, `decx process list`, `decx process check`, `decx process close [name] [--port <port>]` |
| Code analysis | `decx code classes`, `class-source`, `method-source`, `method-context`, `search-global`, `search-class`, `xref-method`, `xref-class`, `xref-field`, `implementations`, `subclasses` |
| APK analysis | `decx android manifest`, `launcher-activity`, `application`, `exported-components`, `deep-links`, `dynamic-receivers`, `aidl-interfaces`, `resources`, `resource-file`, `strings` |
| Framework analysis | `decx android framework collect`, `process [oem]`, `run`, `open [jar]`, plus `framework-service-implementation <interface>` |
| Live device helpers | `decx android device system-services`, `decx android device permission-info <permission>` |
| CLI/server/skills management | `decx self install`, `decx self skills install`, `decx self update` |

Notes:

- Session-backed `code` and `android` commands support `--page <n>` and can target a session with `-s, --session <name>` or a port with `--port <port>`.
- `decx code class-source` supports `--limit <n>` to return at most N source lines.
- `decx process open <file>` passes standard `jadx-cli` flags through, enables `--show-bad-code` and `--no-imports` by default, and strips `--deobf` because DECX analysis requires original names. It also defaults `--rename-flags` to `case,valid` (dropping the `printable` token) so heavily obfuscated Unicode identifiers such as `Ď锬볝觧` survive decompilation instead of being aliased to `m0`.
- `decx process open <file> --script s1.jadx.kts --script s2.jadx.kts` runs [Jadx Kotlin scripts](https://github.com/skylot/jadx/wiki/Jadx-scripts-guide) during decompilation; the server bundles the `jadx-script-kotlin` plugin, so top-level code runs at load and `afterLoad` blocks after classes load. Reuse is keyed on the target file plus the script set.
- `decx android resources` supports file-name filtering with `--include` and `--no-regex`.
- `decx android device system-services` and `permission-info` are adb-backed commands. They use `--serial` / `--adb-path`, not `--port <port>`.
- `decx android framework run` collects from the connected device, processes, packs, and opens the final framework JAR by default; `process [oem]` is for local framework dumps and can resolve OEM from `.artifact.json` or a connected device when omitted.

### Plugin + MCP

Use the plugin when you want the AI assistant to work against the project already opened in JADX GUI. The MCP server is an in-process Kotlin SDK Streamable HTTP endpoint; it is disabled by default and can be auto-started with the plugin:

1. Open the target APK/JAR in JADX.
2. Enable the DECX plugin and confirm the server is available at `http://127.0.0.1:25419`.
3. (Optional) Toggle *Auto-start MCP with DECX* in the DECX panel to start the MCP server at `http://127.0.0.1:25420/mcp` (HTTP port + 1) whenever DECX starts.
4. Connect your MCP client to DECX and call `health_check()`.
5. Use MCP tools for code search/source/xrefs, Android manifest/resources/components, framework service lookup, and JADX GUI selections.

All MCP tools support pagination with `page` where the returned content is large.

Plugin options (stored in `~/.decx/config.json`):

- `decx.port`: DECX HTTP server port, default `25419`
- `decx.mcpAutoStart`: `true`/`false`, default `false` — auto-start the MCP server with DECX
- `decx.cache`: `disk` or `memory`, default `disk`

---

## Error Codes

DECX returns the same structured error format from plugin and standalone server modes:

| Code | Description | HTTP Status |
|------|-------------|-------------|
| **INTERNAL_ERROR** | Internal server error | 500 |
| **SERVICE_ERROR** | Service error | 503 |
| **REQUEST_TIMEOUT** | Request timed out | 504 |
| **HEALTH_CHECK_FAILED** | Health check failed | 500 |
| **UNKNOWN_ENDPOINT** | Unknown endpoint | 404 |
| **INVALID_PARAMETER** | Invalid parameter | 400 |
| **METHOD_NOT_FOUND** | Method not found | 404 |
| **CLASS_NOT_FOUND** | Class not found | 404 |
| **RESOURCE_NOT_FOUND** | Resource not found | 404 |
| **MANIFEST_NOT_FOUND** | AndroidManifest not found | 404 |
| **FIELD_NOT_FOUND** | Field not found | 404 |
| **INTERFACE_NOT_FOUND** | Interface not found | 404 |
| **SERVICE_IMPL_NOT_FOUND** | Service implementation not found | 404 |
| **NO_STRINGS_FOUND** | No strings.xml resource found | 404 |
| **NO_MAIN_ACTIVITY** | No MAIN/LAUNCHER Activity found | 404 |
| **NO_APPLICATION** | Application class not found | 404 |
| **EMPTY_SEARCH_KEY** | Search key cannot be empty | 400 |
| **DECOMPILATION_SKIPPED** | Decompilation skipped (size guard) | 503 |
| **NOT_GUI_MODE** | Not in GUI mode | 503 |

**Error Response Format:**
```json
{
  "ok": false,
  "error": {
    "code": "CLASS_NOT_FOUND",
    "message": "Class not found: com.example.Foo"
  }
}
```

---

## Development

### Project Structure

| Path | Role |
|---|---|
| `decx/decx-core/` | Shared Kotlin API, HTTP + MCP transport, services, models, and utilities |
| `decx/decx-plugin/` | JADX GUI plugin: lifecycle, UI, and in-process MCP server wiring |
| `decx/decx-server/` | Standalone headless server entry point and fat JAR packaging |
| `decx-cli/` | TypeScript CLI for sessions, code analysis, Android helpers, framework processing, and self-management |
| `skills/` | AI agent skills for DECX analysis, app/framework vulnerability hunting, reporting, and PoC construction |

Core request path:

```text
CLI / MCP / HTTP
  -> DecxServer / RouteHandler
  -> DecxApi / DecxApiImpl
  -> service/* and utils/*
```

### Build

```bash
cd decx
./gradlew dist

cd ../decx-cli
npm install
npm run build
npm test
```

### Contributing

1. Fork this repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a Pull Request

---

## License

This project is licensed under [GNU License](LICENSE) - see the [LICENSE](LICENSE) file for details.

---

## Credits

- **[skylot/jadx](https://github.com/skylot/jadx)** - The foundation of this project, a powerful JADX decompiler with plugin support
- **[zinja-coder/jadx-ai-mcp](https://github.com/zinja-coder/jadx-ai-mcp)** - Provided many ideas and inspiration, excellent practices for JADX MCP integration
- **[Kotlin MCP SDK](https://github.com/modelcontextprotocol/kotlin-sdk)**: In-process MCP server implementation
- **[Ktor](https://ktor.io/)**: Streamable HTTP transport for the MCP server
- **[Javalin](https://javalin.io/)**: Lightweight web framework for the HTTP API

---

<div align="center">

**⭐ If this project helps you, please give it a Star!**

![Star History](https://img.shields.io/github/stars/jygzyc/decx?style=social)

</div>

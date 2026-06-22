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

For AI-assisted CLI work, install the CLI, install the DECX server JAR, then expose the bundled skills to your agent:

```bash
npm install -g @jygzyc/decx-cli
decx self install
git clone https://github.com/jygzyc/decx ~/.decx/source
mkdir -p ~/.agents
ln -s ~/.decx/source/skills ~/.agents/skills
```

Replace `~/.agents/skills` with the skills directory expected by your agent:

| Agent | Link target |
|---|---|
| Claude Code | `~/.claude/skills` |
| Opencode | `~/.config/opencode/skills` |
| Codex | `~/.codex/skills` |
| Common agent setup | `~/.agents/skills` |

The `skills/` directory contains:

| Skill | Use |
|---|---|
| `decx-cli` | DECX CLI usage, general code navigation, source lookup, xrefs, manifest/resource inspection, and workflow routing |
| `decx-app-vulnhunt` | APK app-layer vulnerability hunting with the SQLite blackboard workflow |
| `decx-framework-vulnhunt` | Android framework and Binder/service vulnerability hunting on processed framework bundles |
| `decx-poc` | Build a focused Android PoC app and optional helper server from one finalized blackboard finding or selected graph path |
| `decx-report` | Generate HTML/Markdown reports from finalized blackboard findings |

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
decx ard exported-components
decx ard app-deeplinks
decx process close target
decx process close --port 25419
```

Typical skill sequence:

- `decx-cli` for exploration, evidence gathering, and routing
- `decx-app-vulnhunt` or `decx-framework-vulnhunt` for focused vulnerability hunting
- `decx-report` for generating reports from finalized blackboard findings
- `decx-poc` for turning one finalized blackboard finding or selected graph path into a buildable PoC

Vulnerability hunting skills write analysis state to `.decx-analysis/<target>/decx-analysis.db`. App hunts initialize the blackboard with `--kind android_app`; framework hunts use `--kind android_framework`. The blackboard stores facts, intents, events, links, and chains that downstream report and PoC skills consume.

Useful command groups:

| Need | Commands |
|---|---|
| Session lifecycle | `decx process open <file>`, `decx process list`, `decx process check`, `decx process close [name] [--port <port>]` |
| Code analysis | `decx code classes`, `class-source`, `method-source`, `method-context`, `search-global`, `search-class`, `xref-method`, `xref-class`, `xref-field`, `implement`, `subclass` |
| APK analysis | `decx ard app-manifest`, `main-activity`, `app-application`, `exported-components`, `app-deeplinks`, `app-receivers`, `get-aidl`, `all-resources`, `resource-file`, `strings` |
| Framework analysis | `decx ard framework collect`, `process <oem>`, `run`, `open [jar]`, plus `system-service-impl <interface>` |
| Live device helpers | `decx ard system-services`, `decx ard perm-info <permission>` |
| CLI/server management | `decx self install`, `decx self update` |

Notes:

- Session-backed `code` and `ard` commands support `--page <n>` and can target a session with `-s, --session <name>` or a port with `-P, --port <port>`.
- `decx code class-source` supports `--limit <n>` to return at most N source lines.
- `decx process open <file>` passes standard `jadx-cli` flags through, enables `--show-bad-code` and `--no-imports` by default, and strips `--deobf` because DECX analysis requires original names.
- `decx ard all-resources` supports file-name filtering with `--include` and `--no-regex`.
- `system-services` and `perm-info` are adb-backed commands. They use `--serial` / `--adb-path`, not `-P <port>`.
- `decx ard framework run` collects from the connected device, processes, packs, and opens the final framework JAR by default; `process <oem>` is for local framework dumps.

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

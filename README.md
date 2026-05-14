# DECX - Decompiler + X

<div align="center">

![DECX Logo](https://img.shields.io/badge/DECX-Decompiler%20%2B%20X-blue?style=for-the-badge&logo=java&logoColor=white)
![Release](https://img.shields.io/github/v/release/jygzyc/decx?style=for-the-badge&logo=github&color=green)
![License](https://img.shields.io/github/license/jygzyc/decx?style=for-the-badge&logo=gnu&color=orange)

**A JADX-based Decompiler + X - Designed for AI-assisted code analysis**

</div>

---

## Overview

DECX (Decompiler + X) is a smart code analysis platform built on the JADX decompiler, designed specifically for AI-assisted code analysis. The platform provides powerful Java code analysis capabilities to AI assistants through HTTP API and MCP (Model Context Protocol).

---

## Installation

### Prerequisites

- **Java**: JDK 11+
- **Node.js**: 18+ for the CLI
- **JADX**: v1.5.2+ with plugin support if you use the GUI plugin
- **Python**: 3.10+ or `uv` for the plugin MCP sidecar; without `uv`, ensure `requests`, `fastmcp`, and `pydantic` are available

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
| `decxcli` | General code navigation, source lookup, xrefs, manifest, and resource inspection |
| `decxcli-app-vulnhunt` | APK attack-surface enumeration, component/WebView/IPC tracing, exploitability triage, and bilingual reports |
| `decxcli-framework-vulnhunt` | Android framework and Binder/service vulnerability hunting on the processed final framework bundle |
| `decxcli-poc` | Build a focused Android PoC app and optional helper server from one confirmed finding |

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

- `decxcli` for exploration and evidence gathering
- `decxcli-app-vulnhunt` or `decxcli-framework-vulnhunt` for focused vulnerability hunting
- `decxcli-poc` for turning one confirmed finding into a buildable PoC

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
- `decx process open <file>` passes standard `jadx-cli` flags through and enables `--show-bad-code` by default.
- `decx ard all-resources` supports file-name filtering with `--include` and `--no-regex`.
- `system-services` and `perm-info` are adb-backed commands. They use `--serial` / `--adb-path`, not `-P <port>`.
- `decx ard framework run` collects from the connected device, processes, packs, and opens the final framework JAR by default; `process <oem>` is for local framework dumps.

### Plugin + MCP

Use the plugin when you want the AI assistant to work against the project already opened in JADX GUI:

1. Open the target APK/JAR in JADX.
2. Enable the DECX plugin and confirm the server is available at `http://127.0.0.1:25419`.
3. Connect your MCP client to DECX and call `health_check()`.
4. Use MCP tools for code search/source/xrefs, Android manifest/resources/components, framework service lookup, and JADX GUI selections.

All MCP tools support pagination with `page` where the returned content is large.

Plugin options you may need:

- `decx.port`: DECX HTTP server port, default `25419`
- `decx.mcp_path`: custom MCP script path when you do not want the bundled script
- `decx.cache`: `disk` or `memory`, default `disk`

---

## Error Codes

DECX returns the same structured error format from plugin and standalone server modes:

| Code | Description | HTTP Status |
|------|-------------|-------------|
| **INTERNAL_ERROR** | Internal server error | 500 |
| **SERVICE_ERROR** | Service error | 503 |
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
| `decx/decx-core/` | Shared Kotlin API, HTTP transport, models, services, and utilities |
| `decx/decx-plugin/` | JADX GUI plugin and bundled MCP resources |
| `decx/decx-server/` | Standalone headless server entry point and fat JAR packaging |
| `decx-cli/` | TypeScript CLI for sessions, code analysis, Android helpers, framework processing, and self-management |
| `skills/` | AI agent skills for DECX analysis, app/framework vulnerability hunting, and PoC construction |

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
- **[FastMCP](https://github.com/modelcontextprotocol/servers)**: MCP protocol implementation
- **[Javalin](https://javalin.io/)**: Lightweight web framework

---

<div align="center">

**⭐ If this project helps you, please give it a Star!**

![Star History](https://img.shields.io/github/stars/jygzyc/decx?style=social)

</div>

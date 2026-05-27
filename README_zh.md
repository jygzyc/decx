# DECX - Decompiler + X

<div align="center">

![DECX Logo](https://img.shields.io/badge/DECX-Decompiler%20%2B%20X-blue?style=for-the-badge&logo=java&logoColor=white)
![Release](https://img.shields.io/github/v/release/jygzyc/decx?style=for-the-badge&logo=github&color=green)
![License](https://img.shields.io/github/license/jygzyc/decx?style=for-the-badge&logo=gnu&color=orange)

**基于 JADX 的 Decompiler + X — 为 AI 辅助代码分析而设计**

</div>

---

## 项目概述

DECX (Decompiler + X) 是一个基于JADX反编译器的智能代码分析平台，专门为AI辅助代码分析而设计。该平台通过HTTP API和MCP (Model Context Protocol) 协议，为AI助手提供强大的Java代码分析能力。

---

## 安装

### 环境要求

- **Java**: JDK 11+
- **Node.js**: 18+，用于 CLI
- **JADX**: v1.5.2+，使用 GUI 插件时需要
- **Python**: 3.10+ 或 `uv`，用于插件 MCP 伴生进程；不使用 `uv` 时需准备 `requests`、`fastmcp`、`pydantic`

### CLI 和 AI 技能

给 AI 使用时，先安装 CLI 和 DECX server JAR，再把仓库内置技能暴露给 Agent：

```bash
npm install -g @jygzyc/decx-cli
decx self install
git clone https://github.com/jygzyc/decx ~/.decx/source
mkdir -p ~/.agents
ln -s ~/.decx/source/skills ~/.agents/skills
```

如果你的 Agent 使用其他目录，把 `~/.agents/skills` 换成对应路径：

| Agent | 链接目标 |
|---|---|
| Claude Code | `~/.claude/skills` |
| Opencode | `~/.config/opencode/skills` |
| Codex | `~/.codex/skills` |
| 通用 Agent 配置 | `~/.agents/skills` |

`skills/` 目录包含：

| 技能 | 用途 |
|---|---|
| `decxcli` | DECX CLI 使用、通用代码导航、源码查看、交叉引用、Manifest/资源检查和工作流路由 |
| `decxcli-app-vulnhunt` | APK 攻击面枚举、组件/WebView/IPC 追踪、可利用性评估和中英文报告 |
| `decxcli-framework-vulnhunt` | 只面向处理后的最终 framework 包，分析 Android framework、Binder 和系统服务漏洞 |
| `decxcli-poc` | 将一个已确认漏洞转换为可构建的 Android PoC App 和可选辅助服务 |

### JADX 插件

可从 JADX GUI 插件管理器安装，也可以手动安装插件 JAR：

```bash
jadx plugins --install-jar <path-to-jadx_decx_plugin.jar>
```

安装后，在 JADX 中打开 APK/JAR 并启用 DECX。插件会把当前 JADX 项目暴露为 DECX HTTP API 和 MCP 工具。

---

## 使用

### CLI + 技能

Agent 驱动分析时，先用 CLI 创建会话，再让已安装技能接管具体分析流程：

```bash
decx process open target.apk --name target
decx code classes --limit 50
decx code search-global "WebView" --limit 20
decx ard exported-components
decx ard app-deeplinks
decx process close target
decx process close --port 25419
```

典型技能顺序：

- `decxcli` 用于探索、收集证据和工作流路由
- `decxcli-app-vulnhunt` 或 `decxcli-framework-vulnhunt` 用于聚焦漏洞挖掘
- `decxcli-poc` 用于把一个确认漏洞转换为可构建 PoC

常用命令分组：

| 需求 | 命令 |
|---|---|
| 会话管理 | `decx process open <file>`、`decx process list`、`decx process check`、`decx process close [name] [--port <port>]` |
| 代码分析 | `decx code classes`、`class-source`、`method-source`、`method-context`、`search-global`、`search-class`、`xref-method`、`xref-class`、`xref-field`、`implement`、`subclass` |
| APK 分析 | `decx ard app-manifest`、`main-activity`、`app-application`、`exported-components`、`app-deeplinks`、`app-receivers`、`get-aidl`、`all-resources`、`resource-file`、`strings` |
| Framework 分析 | `decx ard framework collect`、`process <oem>`、`run`、`open [jar]`，以及 `system-service-impl <interface>` |
| 设备辅助 | `decx ard system-services`、`decx ard perm-info <permission>` |
| CLI/server 管理 | `decx self install`、`decx self update` |

注意：

- 基于会话的 `code` 和 `ard` 命令支持 `--page <n>`，也可用 `-s, --session <name>` 或 `-P, --port <port>` 指向指定会话。
- `decx code class-source` 支持用 `--limit <n>` 最多返回 N 行源码。
- `decx process open <file>` 会透传标准 `jadx-cli` 参数，并默认启用 `--show-bad-code`。
- `decx ard all-resources` 支持用 `--include`、`--no-regex` 按文件名过滤。
- `system-services` 和 `perm-info` 是 adb 命令，使用 `--serial` / `--adb-path`，不使用 `-P <port>`。
- `decx ard framework run` 默认从已连接设备收集、处理、打包并打开最终 framework JAR；`process <oem>` 用于处理本地 framework dump。

### 插件 + MCP

当你希望 AI 直接分析 JADX GUI 中已打开的项目时，使用插件模式：

1. 在 JADX 中打开目标 APK/JAR。
2. 启用 DECX 插件，确认服务可通过 `http://127.0.0.1:25419` 访问。
3. 在 AI/MCP 客户端中连接 DECX，并调用 `health_check()`。
4. 使用 MCP 工具进行代码搜索、源码查看、交叉引用、Android Manifest/资源/组件分析、framework 服务查找和 JADX GUI 选中内容读取。

返回内容较大时，MCP 工具均可通过 `page` 参数分页。

可能需要的插件选项：

- `decx.port`：DECX HTTP 服务端口，默认 `25419`
- `decx.mcp_path`：不使用内置脚本时指定自定义 MCP 脚本路径
- `decx.cache`：`disk` 或 `memory`，默认 `disk`

---

## 错误码

插件模式和独立 server 模式都会返回同一套结构化错误格式：

| 错误码 | 描述 | HTTP 状态码 |
|--------|------|-------------|
| **INTERNAL_ERROR** | 内部服务器错误 | 500 |
| **SERVICE_ERROR** | 服务错误 | 503 |
| **HEALTH_CHECK_FAILED** | 健康检查失败 | 500 |
| **UNKNOWN_ENDPOINT** | 未知端点 | 404 |
| **INVALID_PARAMETER** | 参数无效 | 400 |
| **METHOD_NOT_FOUND** | 方法未找到 | 404 |
| **CLASS_NOT_FOUND** | 类未找到 | 404 |
| **RESOURCE_NOT_FOUND** | 资源未找到 | 404 |
| **MANIFEST_NOT_FOUND** | AndroidManifest 未找到 | 404 |
| **FIELD_NOT_FOUND** | 字段未找到 | 404 |
| **INTERFACE_NOT_FOUND** | 接口未找到 | 404 |
| **SERVICE_IMPL_NOT_FOUND** | 服务实现未找到 | 404 |
| **NO_STRINGS_FOUND** | 未找到 strings.xml 资源 | 404 |
| **NO_MAIN_ACTIVITY** | 未找到 MAIN/LAUNCHER Activity | 404 |
| **NO_APPLICATION** | 未找到 Application 类 | 404 |
| **EMPTY_SEARCH_KEY** | 搜索关键字不能为空 | 400 |
| **NOT_GUI_MODE** | 非 GUI 模式 | 503 |

**错误响应格式：**
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

## 开发

### 项目结构

| 路径 | 作用 |
|---|---|
| `decx/decx-core/` | 共享 Kotlin API、HTTP 传输、模型、服务和工具 |
| `decx/decx-plugin/` | JADX GUI 插件和内置 MCP 资源 |
| `decx/decx-server/` | 独立 headless server 入口和 fat JAR 打包 |
| `decx-cli/` | TypeScript CLI，负责会话、代码分析、Android 辅助、framework 处理和自管理 |
| `skills/` | 面向 AI Agent 的 DECX 分析、App/Framework 漏洞挖掘和 PoC 构造技能 |

核心请求链路：

```text
CLI / MCP / HTTP
  -> DecxServer / RouteHandler
  -> DecxApi / DecxApiImpl
  -> service/* and utils/*
```

### 构建

```bash
cd decx
./gradlew dist

cd ../decx-cli
npm install
npm run build
npm test
```

### 贡献

1. Fork 本仓库
2. 创建功能分支
3. 进行更改
4. 如适用，添加测试
5. 提交 Pull Request

---

## 许可证

本项目采用 [GNU许可证](LICENSE) - 详见 [LICENSE](LICENSE) 文件。

---

## 致谢

- **[skylot/jadx](https://github.com/skylot/jadx)** - 本项目的基础，强大的 JADX 反编译器，提供插件支持
- **[zinja-coder/jadx-ai-mcp](https://github.com/zinja-coder/jadx-ai-mcp)** - 为本项目提供了很多思路和灵感，关于 JADX MCP 集成的优秀实践
- **[FastMCP](https://github.com/modelcontextprotocol/servers)**: MCP协议实现
- **[Javalin](https://javalin.io/)**: 轻量级Web框架

---

<div align="center">

**⭐ 如果这个项目对您有帮助，请给一个Star！**

![Star History](https://img.shields.io/github/stars/jygzyc/decx?style=social)

</div>

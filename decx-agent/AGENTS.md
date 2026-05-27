# AGENTS.md

## 目标

`decx-agent` 是 DECX 的底层无关探索引擎。它不再内置固定
`recon -> trace -> coverage -> report -> poc` 流水线，而是维护一块
Fact / Intent / Hint 黑板：

- `Fact`：已经确认的分析事实。
- `Intent`：一个待探索方向。
- `Hint`：用户或外部输入的提示。

核心任务只有三类：

- `bootstrap`：初始推进，写入第一个事实和下一批探索方向。
- `explore`：认领一个 Intent，执行一次 DECX 分析，产出一个 Fact。
- `reason`：读取完整黑板，判断是否完成或继续添加 Intent。

DECX core 能力由 dispatcher 内化调用：worker 只在 JSON 中提交 `probes`，
例如 `get_app_manifest`、`search_global_key`、`get_method_context`；dispatcher
负责构造 `/api/decx/*` 请求、执行 HTTP 调用，并把返回观察写成 Fact。
不要让 worker 直接 shell out 到 `decx-cli`。

Python 是核心实现；OpenCode 只保留 JavaScript 薄插件，用来注册工具并在
`decx-agent/` 下调用 `uv run decx-agent`。

对外命令只保留任务级入口：`run`、`resume`、`status`、`hint`、`workers`。
不要增加 `server`、`call`、`probe` 这类底层命令；DECX server 生命周期和
HTTP API 调用都属于 dispatcher 内部实现。

## 边界

- `decx-agent/decx_agent/core/board.py` 是 Fact / Intent / Hint 黑板模型。
- `decx-agent/decx_agent/core/agent.py` 是 dispatcher 状态转换。
- `decx-agent/decx_agent/core/protocol.py` 是 worker JSON 返回协议。
- `decx-agent/decx_agent/core/config.py` 读取 agent 配置，不把 server lifecycle 暴露成 CLI 工作流。
- `decx-agent/decx_agent/core/skills.py` 只负责把 mode 映射到 `skills/*/SKILL.md` 引用。
- `decx-agent/decx_agent/decx/client.py` 是 DECX HTTP core 的内置 client。
- `decx-agent/decx_agent/decx/server.py` 是内部 managed DECX server helper，由配置驱动；只使用 GitHub release 安装的 `decx-server.jar`（`server.jar`、`DECX_SERVER_HOME`、`DECX_HOME/bin/decx-server.jar` 或 `~/.decx/bin/decx-server.jar`），不要回退到本仓库 Gradle build 产物。
- `decx-agent/decx_agent/workers/base.py` 定义 worker request/result/driver 协议。
- `decx-agent/decx_agent/workers/command.py` 负责 subprocess/env/timeout。
- `decx-agent/decx_agent/workers/` 其他文件只放 bottom adapter（`noop`、`codex`、`claude-code`、`opencode`），不放 workflow 规则。
- `.decx-analysis/<target>/run.json` 是运行状态。
- worker 后端只接收 prompt 并返回 JSON；它不直接写运行状态。
- worker request 必须携带 skill reference；命令型后端通过 prompt、`DECX_WORKER_REFERENCES` 和 `DECX_WORKER_REFERENCES_JSON` 获取这些文件路径。
- OpenCode / Claude Code / Codex 都只是 worker driver，不应该把宿主概念写进核心协议。
- 不复制 `decx-cli process/self` 的完整安装和 session 模型；server 只作为自动化任务前置条件。
- `hint` 是人工输入黑板的唯一入口；不要把提示伪装成 Fact。

# 01 — Entry Points & Root Files

> Audit scope: `decx-agent/src/index.ts`, `decx-agent/src/cli.ts`, `decx-agent/src/node-sqlite.d.ts`

---

## `src/index.ts` (94 lines)

**用途（Purpose）**
包的**公共导出入口**（barrel file）。本身不含任何运行时逻辑，仅 `export` 出 `decx-agent` 对外暴露的全部类型、常量与实现类，供 SDK 用法（`import { ... } from "@jygzyc/decx-agent"`）使用。CLI 入口是 `cli.ts`，不是这里。

**职责**
- 重新导出（re-export）所有公共符号，分组清晰：
  1. **Core types**（来自 `agent/types.js`）：`ProjectId` / `Fact` / `Intent` / `Hint` / `Directive` / `TaskConfig` / `SubagentProfile` / `Permission` / `WorkflowConfig` 等约 30 个类型别名
  2. **常量**：`DEFAULT_LIMITS`、`DEFAULT_METACOG_TRIGGERS`、`BUILTIN_ROLES`、`BUILTIN_PERMISSIONS`
  3. **Graph 层**：`Graph` 接口、`InMemoryGraph` / `SqliteGraph` / `FederatedGraph` / `FederationBus` 实现，以及辅助 `routeHash` / `now` / `newProjectId` / `newRunId`
  4. **Config 层**：`defaultConfig` / `loadConfig` / `normalizeProfile` / `PromptLoader`
  5. **Server**：`HttpServer`
  6. **Worker 层**：`WorkerPool` 接口、`NullWorkerPool` / `MockWorker` / `AgentDriverPool`
  7. **Agent 协议层**：`StageError` / `parseEnvelope` / `PermissionChecker` / `CONTRACTS` 系列 validator / `renderGraphView` / `buildDynamicContext` / `ContextLedger` / `tierFacts` / `WorkerSessionManager` / `runSubagent` / `MainAgent` / `applyMainDecision`
  8. **Session 运行时**：`SessionLoop` / `ProjectLockManager` / `MetacogSupervisor` / `GlobalSupervisor`
  9. **顶层 Runtime**：`AgentRuntime`

**关键导出** 仅 `export`，无自身符号。

**依赖** 仅本包内 `src/` 各模块，按 namespace 分组。

**审计要点（Audit Notes）**
- ✅ 纯 re-export，无副作用，无 I/O，无需测试覆盖自身。
- ⚠️ 注意：每次新增公共能力都需要在此处追加 export，否则 SDK 用户无法使用——这是一个**集中化的发布清单**，修改时易遗漏。建议在 PR 模板里加检查项。
- ⚠️ `WorkerPool` 与 `WorkerSessionManager` 名字相近但语义不同（前者是底层执行池，后者是 worker 会话生命周期管理），文档中需保持区分。

---

## `src/cli.ts` (233 lines)

**用途（Purpose）**
`decx-agent` 二进制的**命令行入口**（`#!/usr/bin/env node`，对应 `package.json` 的 `bin`）。基于 `commander` 注册命令树，自身保持 thin——只解析参数与构造 `AgentRuntime`，业务逻辑全部委托给 runtime。

**职责**
注册 7 个命令：

| 命令 | 作用 | 关键选项 |
|---|---|---|
| `run <configPath>` | 从 `task.json` 启动一个 task | `-s/--session`、`-P/--port`、`--host`、`--no-http`、`--no-metacog`、`--mock`、`--max-steps` |
| `resume <session>` | 恢复已停止的 session（重置项目为 active 并继续 `loop.run`） | `-P/--port`、`--no-http` |
| `status <session>` | 打印项目的 progress（stepsExecuted / acceptedFacts / openIntents 等） | — |
| `workers` | 打印 `workerCapabilities()` 的 JSON（已注册 backend / provider 列表） | — |
| `sessions` | 列出 `.decx-analysis` 下所有 session | `--base-dir` |
| `search <query>` | 跨 session 搜索 facts（走 `FederatedGraph.searchFactsAcrossSessions`） | `--status` / `--min-confidence` / `--limit` |
| `init [dir]` | 生成最小化 `task.json` 模板（基于 `defaultConfig()`） | — |

`run` 命令的具体流程：
1. `loadConfig(configPath, opts.session)` 解析配置并定位 `sessionDir`
2. 可选 `--max-steps` 覆盖 `config.workflow.limits.maxSteps`
3. `workerPool = opts.mock ? new MockWorker() : new AgentDriverPool()`
4. 构造 `AgentRuntime`（含 baseDir / host / port / useHttp / useMetacogSupervisor）
5. `runtime.createProject(...)` 创建项目
6. 可选启动 HTTP / Metacog
7. `runtime.run(projectId, { maxSteps })` 阻塞执行
8. 完成后打印 accepted facts 列表

**关键导出** 无（脚本级，最后调用 `program.parse()`）。

**依赖**
- `commander`（外部）
- 内部：`AgentRuntime`、`loadConfig`、`InMemoryGraph`、`SqliteGraph`、`SessionManager`、`FederatedGraph`、`SessionLoop`、`HttpServer`、`AgentDriverPool`、`MockWorker`、`workerCapabilities`、`DEFAULT_LIMITS`、`defaultConfig`
- 注意：`InMemoryGraph`、`SqliteGraph`、`SessionLoop`、`DEFAULT_LIMITS` 被 import 但在当前文件中**未被实际引用**（仅 `resume` 路径里 dynamic import `HttpServer`），属于潜在死代码。

**审计要点（Audit Notes）**
- ⚠️ **未使用的导入**：`InMemoryGraph`、`SqliteGraph`、`SessionLoop`、`DEFAULT_LIMITS` 导入后未使用。审计时建议清理或加注释说明保留意图。
- ⚠️ **`resume` 命令的硬编码 `.decx-analysis`**（line 106, 143）：与 `run` 通过 `sessionDir` 解析的路径不一致，如果用户 `--base-dir` 改了默认位置，`resume` 仍会找不到。`sessions` 命令支持 `--base-dir` 但 `resume` 不支持——不一致接口。
- ⚠️ **`resume` 内重复 dynamic import** `HttpServer`（line 127）而顶部已经静态 import（line 21）——冗余。
- ⚠️ **`status` 命令同样硬编码 `.decx-analysis`**（line 143）——同样问题。
- ⚠️ **错误处理风格不一**：`status` 用 `console.log + return`，`resume` 用 `console.error + process.exit(1)`——非致命但建议统一。
- ⚠️ **`run` 完成后只在 `opts.metacog` 为真时停止 metacog**（line 96），但 metacog supervisor 是在 `AgentRuntime` 内根据 `useMetacogSupervisor !== false` 决定是否创建的——如果调用方传 `--no-metacog`，`runtime.stopMetacog()` 是空操作（`metacogSupervisor` 为 `undefined`），逻辑无 bug，但耦合较隐晦。
- ✅ 命令体保持 thin，业务在 `AgentRuntime`——符合 AGENTS.md 的分层原则。
- ✅ `--mock` 提供零依赖测试路径，良好。

---

## `src/node-sqlite.d.ts` (14 lines)

**用途（Purpose）**
TypeScript **环境类型声明文件**（ambient declaration）。为 Node.js 22.5+ 实验性内置模块 `node:sqlite` 提供类型签名，让 `SqliteGraph` 等文件可以直接 `import { DatabaseSync } from "node:sqlite"` 而不依赖第三方 `better-sqlite3` 或 `@types/node` 的超前版本。

**职责**
仅声明 `node:sqlite` 模块的三个公开符号：
- `StatementSync` 接口：`run()` / `get()` / `all()`（与 `better-sqlite3` API 几乎一致）
- `DatabaseSync` 类：`constructor(path)`、`exec(sql)`、`prepare(sql)`、`close()`
- `run()` 返回 `{ changes, lastInsertRowid }`，`lastInsertRowid` 类型为 `number | bigint`（重要：BIGINT 主键场景需用 `Number()` 收窄）

**关键导出** `declare module "node:sqlite"`——全局增强，无 import/export。

**依赖** 无。

**审计要点（Audit Notes）**
- ⚠️ **类型与实际运行时偏差风险**：这是手写声明，不是官方 `@types/node`。如果 Node 升级后 `node:sqlite` API 变化（仍在 experimental），此文件不会自动更新。建议在 CI 中加一个最小用例调用确认 API 兼容。
- ⚠️ **未声明 `pragma()` / `transaction()` / `function()` 等扩展方法**：如果后续 `SqliteGraph` 需要这些能力，必须先扩展此声明。当前用法（见 `sqlite-graph.ts` 的 `prepare/run/get/all`）已经覆盖。
- ✅ 选择 `node:sqlite` 而非 `better-sqlite3` 减少 native 依赖，与 README "Node.js 22.5+" 要求一致。
- ✅ 文件位于 `src/` 顶层，被 `tsconfig.json` 自动包含，无需显式 `/// <reference>`。

---

## 跨文件观察（Cross-file Observations）

1. **入口分流清晰**：SDK 走 `index.ts`，CLI 走 `cli.ts`，两者不互相 import——分层干净。
2. **`cli.ts` 的 `resume` / `status` 路径管理有硬编码倾向**（`.decx-analysis`），如果未来支持自定义 baseDir 一致性会有问题，建议下一轮重构统一。
3. **未使用导入** 在 `cli.ts` 中存在，是审计时应清理的低悬果。

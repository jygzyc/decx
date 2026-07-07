# 02 — `src/app/` Composition Root

> Audit scope: `decx-agent/src/app/agent-runtime.ts`, `decx-agent/src/app/version.ts`

`app/` 目录是 **runtime 组合根（composition root）**——只做依赖装配，不放任何领域行为。AGENTS.md 明确要求："domain behavior belongs in agent stages and graph mutations belong in Graph implementations"。

---

## `src/app/agent-runtime.ts` (127 lines)

**用途（Purpose）**
`AgentRuntime` 是 SDK / CLI 共享的**顶层运行时容器**。它把 `Graph` + `SessionManager` + `WorkerPool` + `SessionLoop` + `MetacogSupervisor` + `HttpServer` 这六大组件装配成一个对象，对外暴露 `step` / `run` / `tick` / `createProject` / `addDirective` / `close` 等高层方法。

**职责**
1. **构造期组件装配**：根据 `AgentRuntimeOptions` 决定：
   - 如果传了 `baseDir`：`graph = sessionManager.open(session)`（持久化 SQLite）
   - 否则：`graph = new InMemoryGraph()`（仅内存，用于测试 / 临时）
   - `workerPool` 默认 `AgentDriverPool`，可注入
   - `sessionLoop = new SessionLoop(graph, workerPool, config)`
   - `metacogSupervisor` 默认开启（除非显式 `useMetacogSupervisor: false`），构造时传入 `sessionLoop.locks_`（注意结尾下划线——这是个内部句柄，外部访问控制较弱）
   - `httpServer` 默认开启（除非显式 `useHttp: false`）

2. **项目（Project）工厂**：`createProject(input)` 把 `TaskConfig` + session 元信息打包成 `ProjectInput`，调用 `graph.createProject(...)` 持久化。`worker` 字段从 `config.profiles.explorer.runtime.worker` 提取——隐式约定了 `explorer` profile 必须存在。

3. **执行入口代理**：`step` / `run` / `tick` / `addDirective` 全部是 `sessionLoop` / `graph` 同名方法的薄包装。

4. **生命周期管理**：`startMetacog` / `stopMetacog` / `startHttp` / `stopHttp` / `close`。`close()` 用鸭子类型检查 `graph.close` 是否存在——`SqliteGraph` 有，`InMemoryGraph` 没有，安全。

**关键导出**
- `interface AgentRuntimeOptions` — 6 个可选字段
- `class AgentRuntime` — 6 个 readonly 字段 + 9 个公开方法

**依赖**
- `node:path` 的 `join`
- 类型：`TaskConfig`、`DirectiveInput`、`ProjectId`、`Graph`、`ProjectInput`、`WorkerPool`、`RunOptions`、`StepResult`
- 实现：`SessionManager`、`InMemoryGraph`、`AgentDriverPool`、`SessionLoop`、`MetacogSupervisor`、`HttpServer`

**审计要点（Audit Notes）**
- ⚠️ **`projects` 字段写入后从不读取**（line 36, 85）：`Map<string, { config, sessionDir }>` 被填充但全文件没有 read 路径。要么是预期外未实现的查询接口（如 `getProjectConfig(id)`），要么是死代码。建议确认意图。
- ⚠️ **`sessionManager?.sessionDir(session)` 的 optional chaining 多余**（line 72）：上一行已保证 `sessionManager` 在构造期赋值，永远是 truthy。`?.` 会误导读者以为有 undefined 可能。审计建议改为 `.`。
- ⚠️ **`sessionLoop.locks_` 下划线命名穿透抽象**（line 56）：`locks_` 后缀下划线通常表示"内部不对外"，但 `AgentRuntime` 直接读了它传给 `MetacogSupervisor`。说明 `SessionLoop` 的锁机制事实上是 public 接口的一部分——建议要么改名为 `locks`（无下划线，正式公开），要么提供 accessor 方法 `getLocks()`。
- ⚠️ **`config.task.session ?? "default"` 默认 session 名**（line 46）：如果 `baseDir` 传了但 `config.task.session` 未设，会用字面量 `"default"` 作为 session 名——可能与用户既有 session 冲突。审计时应确认这个 fallback 是否符合预期。
- ⚠️ **`createProject` 隐式依赖 `profiles.explorer`**（line 78）：如果用户的 `task.json` 没声明 `explorer` profile，会抛 `Cannot read properties of undefined (reading 'runtime')`。建议在构造期或 `createProject` 入口加显式校验，给出更友好的错误信息。
- ⚠️ **`close()` 异步清理未等待**（line 123）：`void this.stopHttp()` 触发后立即返回，`close()` 是同步方法。如果调用方期望 `close()` 返回时 HTTP 已停止，会出错。建议 `close(): Promise<void>` 或文档化"close 后需自行 await stopHttp"。
- ✅ Graph / Loop / Supervisor / HttpServer 全部由本文件组合，符合"单一 composition root"原则。
- ✅ `InMemoryGraph` vs `SqliteGraph` 的选择由 `options.baseDir` 显式控制，测试友好。
- ✅ 各组件均可通过 `options.workerPool` 注入，便于 mock。

---

## `src/app/version.ts` (8 lines)

**用途（Purpose）**
导出 `VERSION` 常量，供 CLI 的 `--version` 与（潜在）HTTP `/version` 端点使用。

**实际内容**
```ts
export const VERSION = "0.1.0";
```

**审计要点（Audit Notes）**
- ⚠️ **文档注释与实现不一致（严重）**：文件头 docstring 声称 "Reads the repository root version file at build/runtime where possible so the standalone agent reports the same project version as the rest of DECX"，但实现是**硬编码字符串 `"0.1.0"`**，从未读取任何文件。这是误导性文档，应要么：
  1. 实现真正的读取（通过 `fs.readFileSync` 读 `../../version` 或在 build 期注入）
  2. 要么删除/修正 docstring，明确说明"version 由 release 流程手动同步"
- ⚠️ **版本与 `package.json` 是否同步**：`package.json` 的 `version` 字段与这里 `VERSION` 是两套来源。如果发布流程只 bump `package.json`，这里会滞后。建议审计 release 脚本。
- ⚠️ **`cli.ts` line 33 也硬编码 `"0.1.0"`**：`program.version("0.1.0")` 没有引用本文件的 `VERSION`——两处独立硬编码，更易漂移。修建议：`import { VERSION } from "./app/version.js"` 后 `program.version(VERSION)`。
- ✅ 文件本身极小、无依赖、易测试。

---

## 跨文件观察（Cross-file Observations）

1. **`AgentRuntime` 是 `cli.ts` 的实际业务核心**，CLI 几乎所有命令都依赖它；`resume` 命令却绕过 `AgentRuntime` 自己造了一个 `SessionLoop + HttpServer` 组合，是个不一致点（已在 `01-entry-points.md` 标记）。
2. **版本号三处硬编码**（`package.json`、`app/version.ts`、`cli.ts`），建议集中到一处。
3. **`app/` 目录只有 2 个文件**，符合"瘦 composition root"原则，没有领域逻辑渗透。

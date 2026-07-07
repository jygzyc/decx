# decx-agent/src 代码审计文档

> 本目录是对 `decx-agent/src/` 全部 53 个 TypeScript 文件的**逐文件用途分析与审计报告**，用于代码审计与重构决策。

## 文档结构

按目录分册，每册包含该目录下每个文件的：用途、职责、关键导出、依赖、**审计要点（含 bug、风险、不一致、死代码）**、跨文件观察。

| 文档 | 范围 | 文件数 | 关键内容 |
|---|---|---|---|
| [01-entry-points.md](./01-entry-points.md) | `src/index.ts`, `src/cli.ts`, `src/node-sqlite.d.ts` | 3 | 包入口、CLI 命令树、SQLite 类型声明 |
| [02-app.md](./02-app.md) | `src/app/` | 2 | AgentRuntime 组合根、版本常量 |
| [03-agent.md](./03-agent.md) | `src/agent/` | 11 | 协议层：types/contracts/permissions/main-agent/decision-applier/subagent-runner/context-builder/graph-view/context-ledger/fact-tiering/parse-envelope |
| [04-session.md](./04-session.md) | `src/session/` | 5 | 运行时调度：SessionLoop/GlobalSupervisor/MetacogSupervisor/ProjectLockManager/SessionManager |
| [05-worker-core.md](./05-worker-core.md) | `src/worker/`（root） | 8 | WorkerPool 抽象、driver registry、MockWorker、AgentDriverPool、WorkerSessionManager |
| [06-worker-backends.md](./06-worker-backends.md) | `src/worker/backends/` | 7 | AgentBackend 实现：subprocess 基类、codex/claude/opencode-cli/opencode-http/process、registry |
| [07-worker-providers.md](./07-worker-providers.md) | `src/worker/providers/` | 3 | ModelProvider 实现：types、registry、ConfiguredProvider |
| [08-graph.md](./08-graph.md) | `src/graph/` | 5 | 存储层：Graph 接口、InMemoryGraph、SqliteGraph、FederatedGraph、FederationBus |
| [09-config.md](./09-config.md) | `src/config/` | 7 | 配置加载：defaultConfig、task-config、profile-loader、prompt-loader、providers-config、provider-presets、utils |
| [10-server.md](./10-server.md) | `src/server/` | 1 | HTTP API + Dashboard（HttpServer） |

---

## 📊 审计关键发现汇总

### 🚨 严重 bug / 安全风险（建议立即修复）

1. **`profile-loader.ts` 忽略 `raw.permissions`** —— 自定义 profile 无法声明权限，与 AGENTS.md 承诺冲突。
2. **`provider-presets.ts` 的 `anthropic` preset 缺 `kind` 字段** —— anthropic provider 实际走 OpenAI SDK，调用必然失败。`initProvidersFile` 复制 preset 时也漏 kind/headers。
3. **`codex.ts` / `claude.ts` 默认禁用 sandbox/审批** —— `--dangerously-bypass-approvals-and-sandbox` / `--dangerously-skip-permissions` 让 LLM 输出可触发任意系统调用。结合 graph 中 attacker-controlled description 进入 prompt，构成 prompt injection → RCE 链。
4. **`http-server.ts` 无认证** —— 本地多用户场景下，同机任何用户/进程可通过 `POST /api/projects/:id/directives` 控制 agent 行为。
5. **`session/session-manager.ts` 缺路径转义保护** —— `join(baseDir, sessionId)` 若 sessionId 含 `../`，会跳出 baseDir。叠加 `config/utils.ts` 的 `safeSessionName` 不防 `..`。
6. **`dashboard.html` 缺失** —— `GET /` 必然 500。

### ⚠️ 重要不一致

1. **三套默认值常量**：`DEFAULT_LIMITS`（types.ts）+ `DEFAULT_METACOG_TRIGGERS`（types.ts，everySeconds=60）+ `defaultConfig()`（config/，everySeconds=30）——数值不一致。
2. **`SessionLoop.run` 默认 `maxSteps=100`**，但 `DEFAULT_LIMITS.maxSteps=1000`。
3. **两套 `WorkerRequest`/`WorkerResult` 同名不同形**（`worker-runtime.ts` 有 `text` vs `base.ts` 有 `stdout`，`stderr?` vs `stderr`）。
4. **`MainAgent` 自动消费所有 hints** —— 即使 planner 没显式输出 consumeHintIds，传入 hints 也被全部标记 consumed。
5. **`sessionReuse` 协议三层不一致** —— session-manager 假设复用，opencode-http 明确不复用，claude/codex/opencode-cli 不支持 `--resume`。
6. **`GlobalSupervisor.globalMaxConcurrent` 死代码** —— 构造期读取但 tick() 不用它限制并发。
7. **`AgentDriverPool` 把所有调用标 `role: "explorer"`** —— 丢失 role 上下文，影响审计/计费准确性。
8. **`SessionLoop.runOneExplorer` 的 `outputTokens = 0` 硬编码** —— SubagentRun.outputTokens 永远是 0。

### 🪦 死代码 / 未实现预留

1. `BACKENDS/types.ts` 的 `conclude` / `partialOutput` / `supportsConclude` —— 协议预留无实现。
2. `providers/types.ts` 的 `ModelCallResult.session` —— ConfiguredProvider 从不填充。
3. `agent/fact-tiering.ts` 的 `cold: []` —— 三层模型实际只用两层。
4. `app/agent-runtime.ts` 的 `projects` Map —— 写入后从不读取。
5. `worker/registry.ts` 的 `DRIVER_FACTORIES` 缺 `mock` kind —— MockWorker 走旁路。
6. `worker-runtime.ts` 的 `expectedPayload` 字段 —— 无调用点。
7. `in-memory-graph.ts` 的 `snapshots` 字段 —— 未使用。
8. `cli.ts` 的多个未使用导入（`InMemoryGraph`、`SqliteGraph`、`SessionLoop`、`DEFAULT_LIMITS`）。
9. `HttpServer` 构造参数 `sessionLoop` —— 持有但代码中完全未用。

### 🔁 重复 / 冗余

1. `stringValue` 同名不同语义（task-config.ts 支持 dot-path vs utils.ts 不支持）。
2. 三处版本硬编码（`package.json` / `app/version.ts` / `cli.ts`）。
3. `cli.ts` `resume` 命令重复 dynamic import `HttpServer`（顶部已静态 import）。
4. `SessionManager.openReadOnly` 与 `FederatedGraph` 直接 new DatabaseSync 功能重叠。

---

## 🗺️ 推荐审计顺序

1. **第一优先级（架构理解）**：
   - [03-agent.md](./03-agent.md) — 协议层是骨架，先理解 types/contracts/permissions
   - [04-session.md](./04-session.md) — SessionLoop 是核心调度器，所有运行时行为汇集于此
   - [08-graph.md](./08-graph.md) — Graph 接口定义所有状态操作契约

2. **第二优先级（执行路径）**：
   - [05-worker-core.md](./05-worker-core.md) — WorkerPool 抽象层
   - [06-worker-backends.md](./06-worker-backends.md) — 实际 backend（含安全风险点）
   - [03-agent.md §3.7 subagent-runner](./03-agent.md) — 串起协议与 worker 的引擎

3. **第三优先级（配置与边界）**：
   - [09-config.md](./09-config.md) — 配置加载（含 2 个严重 bug）
   - [01-entry-points.md](./01-entry-points.md) — CLI 入口
   - [10-server.md](./10-server.md) — HTTP API（含安全风险）

4. **第四优先级（辅助）**：
   - [02-app.md](./02-app.md) — 组合根
   - [07-worker-providers.md](./07-worker-providers.md) — Provider 层

---

## 📈 文件规模与测试覆盖

| 目录 | 文件数 | 总行数（估） | 单元测试 |
|---|---|---|---|
| `src/`（root） | 3 | ~340 | 仅 cli help 测试 |
| `src/app/` | 2 | ~135 | ✅ agent-runtime.test.ts |
| `src/agent/` | 11 | ~1500 | ⚠️ 仅 subagent-runner 有测试 |
| `src/session/` | 5 | ~830 | ❌ 无 |
| `src/worker/`（root） | 8 | ~540 | ❌ 无 |
| `src/worker/backends/` | 7 | ~370 | ❌ 无 |
| `src/worker/providers/` | 3 | ~160 | ❌ 无 |
| `src/graph/` | 5 | ~1900 | ✅ sqlite.test.ts |
| `src/config/` | 7 | ~720 | ❌ 无 |
| `src/server/` | 1 | ~190 | ❌ 无 |
| **合计** | **53** | **~6700** | 覆盖率约 15-20% |

**测试覆盖建议优先级**：
1. `SessionLoop` 全分支测试（核心调度无测试是最高风险）
2. `agent/contracts.ts` + `parse-envelope.ts`（协议正确性基础）
3. `config/profile-loader.ts`（含 permissions bug）
4. `worker/agent-driver-pool.ts`（role 标记 bug）
5. `session/project-lock.ts`（并发基础）

---

## 📝 审计方法说明

- 所有源码通过 `Read` 工具逐文件读取（行号化），结合 codegraph 探索调用关系
- 每个文件均给出：**用途 / 职责 / 关键导出 / 依赖 / 审计要点（含 bug、风险、不一致、死代码）/ 跨文件观察**
- 标记级别：
  - 🚨 = 严重 bug 或安全风险，建议立即修复
  - ⚠️ = 重要不一致或潜在问题，建议排期修复
  - ✅ = 设计良好或符合最佳实践
- 文档基于审计时点的代码状态，后续代码变更需重新审计对应文件

---

## 🔗 相关文档

- 仓库根 [AGENTS.md](../../AGENTS.md) — 仓库整体指引
- [`decx-agent/AGENTS.md`](../AGENTS.md) — decx-agent 包指引
- [`decx-agent/README.md`](../README.md) — 用户文档


# 05 — `src/worker/` Core (root files)

> Audit scope: 8 files in `decx-agent/src/worker/` (root, excluding `backends/` and `providers/` subdirs)
> `worker-runtime.ts`, `base.ts`, `registry.ts`, `agent-driver.ts`, `api-driver.ts`,
> `mock-worker.ts`, `agent-driver-pool.ts`, `session-manager.ts`

`worker/` 是**底层执行抽象**——AGENTS.md 明确："Worker adapters are bottom-layer execution only. They must not own graph state or scheduling policy." 所有 worker 都是"prompt 进，text/process result 出"。

---

## 5.1 `worker/worker-runtime.ts` (64 lines) — **高层 WorkerPool 抽象**

**用途**：定义面向 agent 层（SessionLoop/SubagentRunner）的 `WorkerPool` 接口。所有 stage 调用 `workerPool.execute()`，**永远不直接调子进程**——这层间接让 MockWorker 测试成为可能。

**核心类型**
```ts
interface WorkerRequest {
  prompt: string;
  config: WorkerConfig;
  workerName?: WorkerName;
  projectId?: ProjectId;
  expectedPayload?: string;   // ⚠️ 未在任何调用点使用
  cwd?: string;
  maxOutputTokens?: number;
  sessionId?: string;
}

interface WorkerResult {
  workerId: string;
  text: string;               // ⚠️ 注意：是 text，不是 stdout
  returncode: number;
  stderr?: string;
  timedOut?: boolean;
}

interface WorkerPool {
  execute(request): Promise<WorkerResult>;
  pickWorker(projectId, config): WorkerName;
  runningCount(projectId): number;
}
```

**`NullWorkerPool`**：永远返回 `returncode: 1` 的占位实现，用于无 worker 配置或早期 prototyping。

**审计要点**
- ⚠️ **`WorkerRequest.expectedPayload` 字段定义但从未使用**（line 21）：审计全代码库确认无调用方传该字段，建议删除。
- ⚠️ **`WorkerResult.timedOut` 字段**（line 32）：定义了但实际 backend 是否填充需查 `backends/*`。如果不填，调用方无法区分"超时"和"正常失败"。
- ⚠️ **`WorkerPool.pickWorker` 接口存在，但实际 SubagentRunner 不调用它**：runner 用 `profile.runtime.workers?.[0] ?? profile.runtime.worker` 自己选 worker（见 `subagent-runner.ts`）。pickWorker 几乎是死接口。
- ⚠️ **`NullWorkerPool` 是 class 而非单例**：每次 new 创建新对象，没必要。建议改 `export const NullWorkerPool: WorkerPool = { ... }`。
- ✅ 抽象边界清晰：stage 不接触 subprocess。
- ✅ `MockWorker` 注入点明确，单元测试基础设施良好。

---

## 5.2 `worker/base.ts` (31 lines) — **底层 WorkerDriver 契约**

**用途**：定义**比 WorkerPool 更底层**的 `WorkerDriver` 接口，被 `AgentDriver` / `ApiDriver` 实现。与 `worker-runtime.ts` 的区别：

| 维度 | `worker-runtime.ts` | `base.ts` |
|---|---|---|
| 抽象层 | 高（面向 stage） | 低（面向 driver） |
| Request | 含 `maxOutputTokens`、`sessionId` | 含 `role`、`intentId`、`sessionDir` |
| Result 字段名 | `text` | `stdout` |
| 用法 | `WorkerPool.execute` | `WorkerDriver.execute` |

**核心类型**
```ts
interface WorkerRequest {
  worker: WorkerName;
  role: string;
  projectId: string;
  sessionDir: string;
  prompt: string;
  intentId?: string;
  cwd?: string;
  config?: WorkerConfig;
}

interface WorkerResult {
  worker: WorkerName;
  returncode: number;
  stdout: string;
  stderr: string;
}

interface WorkerDriver {
  readonly name: WorkerName;
  execute(request): Promise<WorkerResult> | WorkerResult;
}
```

**审计要点**
- ⚠️ **两套 `WorkerRequest` / `WorkerResult` 类型同名不同形**（与 `worker-runtime.ts`）：极易混淆。审计建议至少重命名其一（如 `DriverRequest` / `DriverResult`），或用 namespace 隔离。
- ⚠️ **`base.ts` 的 `WorkerResult.stderr` 是必填**（line 25），而 `worker-runtime.ts` 的 `stderr` 是可选——转换时需注意。
- ⚠️ **`base.ts` 的 `WorkerRequest.role` / `intentId` / `sessionDir` 在 AgentDriver.execute 中实际未使用**（见 `agent-driver.ts` line 20-39）——只用了 `prompt`、`cwd`、`config`。这意味着 driver 层丢失了 role / intentId 上下文，无法做 role-aware 行为（如不同 prompt 模板）。
- ✅ 接口极简，3 个字段 + 1 个方法。

---

## 5.3 `worker/registry.ts` (61 lines) — **Driver 工厂注册表**

**用途**：从 `WorkerConfig.kind` 分派到具体 driver（`agent` → AgentDriver，`api` → ApiDriver）。维护内置 worker 配置表，提供 `workerCapabilities()` 给 CLI `workers` 命令。

**关键内容**
- `DRIVER_FACTORIES: Partial<Record<WorkerKind, DriverFactory>>` — `agent` + `api`（注意：没有 `mock`！）
- `BUILTIN_WORKER_CONFIGS` — 4 个内置：`claude-code` / `codex` / `opencode`（kind=agent）/ `api`
- `WORKERS` — 内置 worker 名列表
- `executeWorker(request)` — 主调度入口
- `knownWorkers(configured)` — 内置 + 配置的并集
- `workerCapabilities()` — CLI 用的能力清单

**`executeWorker` 流程**
```
1. resolveWorkerConfig(workerName, config)
   - 优先用调用方传入的 config（来自 task.json）
   - 否则 fallback 到 BUILTIN_WORKER_CONFIGS[workerName]
2. config 不存在 → return returncode=2
3. factory = DRIVER_FACTORIES[config.kind]，不存在 → return returncode=2
4. factory(name, config).execute({ ...request, config })
```

**审计要点**
- ⚠️ **`DRIVER_FACTORIES` 缺 `mock` kind**：`WorkerKind = "agent" | "api" | "mock"`，但 registry 只注册了 `agent` 和 `api`。如果用户在 task.json 配 `kind: "mock"`，会走到 `unsupported worker kind: mock`。MockWorker 走的是另一条路（直接 new，不通过 registry）——两条路径并存，易混淆。
- ⚠️ **`resolveWorkerConfig` 优先级**（line 59-60）：`configured ?? BUILTIN_WORKER_CONFIGS[worker]`——调用方传 config 时**完全覆盖**内置。但如果用户只配了 `kind` 没配 `backend`，会丢掉内置的 backend 默认值。建议改为 merge 而非覆盖。
- ⚠️ **`executeWorker` 返回 `Promise<WorkerResult> | WorkerResult`**（line 34）：union 类型，调用方需 `Promise.resolve(...)` 包一层才能 await——`agent-driver-pool.ts` line 39 就是这么做的。设计上不友好。
- ⚠️ **错误用 returncode=2 表示"配置错误"**：与 Unix 退出码语义重叠（2 通常表示 shell 语法错）。建议用专用 error 字段或抛异常。
- ✅ BUILTIN_WORKER_CONFIGS 集中化，新增 backend 改一处。
- ✅ `workerCapabilities()` 提供完整自省。

---

## 5.4 `worker/agent-driver.ts` (52 lines) — **CLI/HTTP Backend Driver**

**用途**：`AgentDriver` 实现 `WorkerDriver`，把 prompt 转发到具体的 **AgentBackend**（如 opencode CLI、codex CLI、claude-code CLI，或 HTTP transport）。

**`execute(request)` 流程**
```
1. resolveBackend() → AgentBackend | undefined
2. backend 缺失 → return returncode=2 with stderr
3. backend.invoke({ prompt, config, cwd })
4. normalize 返回：{ worker, returncode, stdout: result.text, stderr }
```

**`resolveBackend()` 优先级**
1. 如果 `config.transport === "http"`：找 `${backend ?? name}-http` 注册的 HTTP backend
2. 否则：找 `backend ?? name` 注册的 backend
3. 都没有但 `config.command` 存在 → `new ProcessBackend()`（通用进程适配器）
4. 否则 undefined

**审计要点**
- ⚠️ **`request.role` / `request.intentId` / `request.sessionDir` 未使用**（line 27-31）：AgentBackend.invoke 只接受 `{ prompt, config, cwd }`——丢失了上下文。如果未来 backend 需要 role-aware prompt 模板，需要扩展。
- ⚠️ **HTTP transport 的 backend 命名约定**（line 43）：`${backend ?? name}-http`——隐式约定，文档化不足。如果用户配 `backend: "codex"` + `transport: "http"`，会找 `codex-http`，需查 `backends/registry.ts` 确认是否存在。
- ⚠️ **`new ProcessBackend()` 每次都新建实例**（line 49）：每次 execute 创建新对象，浪费。建议复用单例。
- ⚠️ **`result.text` 转 `stdout` 字段名变换**：与 base.ts 的契约对齐，但易忘。
- ✅ 文件极薄，backend 选择逻辑清晰。

---

## 5.5 `worker/api-driver.ts` (74 lines) — **直接 LLM API Driver**

**用途**：`ApiDriver` 实现 `WorkerDriver`，跳过 agent CLI/subprocess，直接调 LLM provider（OpenAI / Anthropic / OpenAI-compatible）。适合**不需要工具/会话**的轻量调用（如 reviewer）。

**`execute(request)` 流程**
```
1. resolveProviderId(config) → provider id
2. provider = getProvider(id)，不存在 → return returncode=1 with stderr
3. provider.complete({ prompt, maxTokens, model, temperature }, config)
4. 成功 → { returncode: 0, stdout: result.text }
5. 异常 → { returncode: 1, stderr: error.message }
```

**`resolveProviderId` 优先级**（line 58-73）
1. `config.provider`（task.json 显式）
2. `process.env.DECX_AGENT_API_PROVIDER`
3. 扫描 `providers.json` + `PROVIDER_PRESETS`，找第一个 `apiKeyEnv` 在 env 中有值的
4. fallback `"openai"`

**审计要点**
- ⚠️ **`request.intentId` / `request.sessionDir` / `request.cwd` 全部忽略**：API driver 是 stateless 的，OK，但意味着同一项目的多次调用之间无会话状态——`profile.sessionReuse` 对 api worker 无意义。建议在 PromptLoader 或上游警告。
- ⚠️ **fallback `"openai"`**（line 73）：如果用户没配任何 provider 且没设环境变量，会默认 openai——但 openai 的 API key 没设，调用会失败。错误消息 `unknown model provider: openai` 会让用户困惑（"我没说要 openai 啊"）。建议改为抛 `Error("no provider configured")`。
- ⚠️ **`loadProvidersFile()` 每次调用都读盘**（line 64）：每次 executeWorker 都重新 load——高频调用下有性能问题。建议缓存。
- ⚠️ **错误消息提到不存在的命令**（line 34）：`Run 'decx-agent providers init' to set up providers.`——但 `decx-agent` CLI **没有** `providers init` 子命令（见 cli.ts）。误导用户。
- ⚠️ **`config.maxTokens` 与 `request.maxOutputTokens`**：api-driver 用 `config.maxTokens`，但 agent-driver-pool 用 `request.maxOutputTokens ?? config.maxTokens`——优先级不一致。
- ✅ Provider 解析优先级清晰（显式 > env > 扫描 > fallback）。
- ✅ 与 provider 注册表解耦。

---

## 5.6 `worker/mock-worker.ts` (74 lines) — **测试用 WorkerPool**

**用途**：实现 `WorkerPool`（**不是** WorkerDriver），按 prompt 正则匹配返回预设响应。所有 stage 单元测试和 e2e 测试都用它。

**核心 API**
- `register(pattern: RegExp, response: string | ((req) => string), returncode?)` — 注册响应（`unshift` 到队首，新注册优先）
- `reset()` — 清空
- `calls()` — 调用日志（prompt / text / workerName）
- `execute(request)` — 遍历 entries，第一个匹配的胜出；全不匹配 → returncode=1
- `markRunning(projectId, workerId)` — 手动标记（测试用）

**审计要点**
- ⚠️ **`register` 用 `unshift`**（line 27）：新注册的优先匹配。这个语义合理（测试中后注册的覆盖前面的），但需文档化，否则用户可能以为是 append。
- ⚠️ **`pickWorker` 的 fallback 是 `"mock"`**（line 59）：如果 `config.workers` 为空，返回 `"mock"`——但实际 mock-worker 的 workerName 不一定是 "mock"，可能与 mock 注册的 pattern 不匹配。
- ⚠️ **`runningPerProject` 字段维护靠手动 `markRunning`**：execute 不自动维护，与 `AgentDriverPool` 的自动维护不一致。Mock 测试需要测试代码主动调 markRunning，否则 `runningCount` 永远 0。
- ⚠️ **`callLog` 记录 prompt 全文**（line 47）：长 prompt 下内存占用大。建议加 max length 或抽样。
- ✅ 实现极简，测试用足够灵活。
- ✅ Response 支持 function 形式，可基于 request 动态生成。

---

## 5.7 `worker/agent-driver-pool.ts` (91 lines) — **生产 WorkerPool 实现**

**用途**：`AgentDriverPool` 是**生产环境**的 `WorkerPool` 实现，包装 `executeWorker`（registry）。维护 per-project running worker 集合，提供异构引擎偏好（pickWorker）。

**`execute(request)` 流程**
```
1. 从 request.config 构造 backendConfig（kind=mock 时强制改为 "agent"）
2. workerName = request.workerName ?? `agent-${counter++}`
3. markRunning(projectId, workerName)
4. executeWorker({ worker, role: "explorer", projectId, sessionDir, prompt, config, cwd })
   .finally(unmarkRunning)
5. 返回 { workerId, text: result.stdout, returncode, stderr }
```

**`pickWorker(projectId, config)`**
1. candidates = Object.keys(config.workers)，空则 "noop"
2. 找一个当前未 running 的 candidate
3. 否则 round-robin: `candidates[counter % length]`

**审计要点**
- ⚠️ **`role: "explorer"` 硬编码**（line 42）：所有调用都被标记为 explorer role，无论实际是 planner/explorer/evaluator/metacog。这丢失了 role 上下文——前面提到的 base.ts `request.role` 字段在这里被强制覆盖。**严重 bug**：evaluator 调用被记为 explorer，影响日志/计费/审计。
- ⚠️ **`sessionDir: request.cwd ?? process.cwd()`**（line 43）：用 cwd 当 sessionDir，语义混淆。sessionDir 应该是项目专属目录，cwd 是 worker 进程工作目录——两者不应混用。
- ⚠️ **`request.maxOutputTokens ?? config.maxTokens` → `backendConfig.maxTokens`**（line 32）：与 api-driver 不一致（api-driver 只看 config.maxTokens）。
- ⚠️ **`config.kind === "mock"` 强制改 "agent"**（line 22）：意味着 task.json 配 `kind: "mock"` 走 agent 路径会失败（registry 不识别）——`--mock` CLI 选项实际走的是 `new MockWorker()`，根本不进入 AgentDriverPool。这条转换代码是死路径。
- ⚠️ **`workerCallCounter` 单调递增不回收**（line 17, 37）：长跑任务下 counter 会很大，但不会回绕（Number.MAX_SAFE_INTEGER 足够）。OK，但 workerName 永远不同——`pickWorker` 的 round-robin 用 `counter % length` 是 OK 的，但 `markRunning` 用的 workerName 是 execute 内独立生成的 `agent-${counter}`，与 pickWorker 的返回值**不一致**——意味着 pickWorker 的输出几乎没人用（runner 自己选 worker）。
- ⚠️ **`backendConfig` 用 `as const` 但同时 `as WorkerConfig` 隐式断言**：类型不严谨，建议显式构造 WorkerConfig 对象。
- ✅ Per-project running set 维护正确。
- ✅ Heterogeneous preference 设计良好（不同 worker 轮转，避免单点过载）。

---

## 5.8 `worker/session-manager.ts` (76 lines) — **Worker 会话生命周期**

**用途**：当 `profile.sessionReuse === true` 时，管理 `(projectId, profileId) → sessionId` 映射。让 opencode-http / codex --resume / claude --resume 等支持会话的 backend 复用上下文，从而启用 delta-only prompt。

**核心 API**
- `get(projectId, profileId)` — 查询
- `acquire(projectId, profileId, factory)` — 取或创建（callCount +1，lastUsedAt 更新）
- `rotate(projectId, profileId, factory)` — 强制新建（替换旧 session）
- `release(projectId, profileId)` — 删除单个
- `releaseProject(projectId)` — 删除该项目所有 session
- `list()` — 全部 session 列表

**`WorkerSession` 形状**
```ts
{ sessionId: string; createdAt: number; callCount: number; lastUsedAt: number }
```

**审计要点**
- ⚠️ **`acquire` 与 `rotate` 的 factory 命名混淆**：两者都接 `factory: () => string`。acquire 在已存在时不调用 factory（直接返回旧 session + callCount++）——意味着 factory 创建 session id 失败时（factory 抛错）会被静默吞，因为 factory 只在第一次执行。**潜在 bug**：factory 实现复杂时不可见。
- ⚠️ **不持久化**：进程重启后所有 session 丢失，对应 backend 的 session 仍在但本地映射没了——会触发新建 session，旧 session 在 backend 端成孤儿。
- ⚠️ **没有 LRU / TTL**：session 永不淘汰。长跑任务下，如果 profile 切换频繁，sessions map 会无限增长。
- ⚠️ **sessionId 不透明但也不验证**：factory 返回的 sessionId 直接存——如果 factory 返回空字符串或非法值，下游 backend 会失败。建议加校验。
- ⚠️ **`rotate` 不释放旧 session 资源**：替换前不调用 backend 的 session close（如果有的话）——只删本地映射，backend 端 session 仍存在。需要 backend 配合。
- ⚠️ **`list()` 暴露所有 session**：跨项目可见，安全敏感场景需注意。
- ✅ 实现简单，与 ledger 设计对称（都是 Map<string, T>）。
- ✅ `releaseProject` 前缀扫描正确。

---

## 跨文件观察（Cross-file Observations）

1. **两套同名类型混淆**：`worker-runtime.ts` 和 `base.ts` 都定义 `WorkerRequest` / `WorkerResult`，字段不同（`text` vs `stdout`，`stderr?` vs `stderr`）。**强烈建议重命名**。
2. **`AgentDriverPool` 把所有调用标 `role: "explorer"`**——丢失 role 上下文，影响审计/计费/日志的准确性。
3. **`pickWorker` 接口存在但几乎不用**：SubagentRunner 自己选 worker，AgentDriverPool 内部 execute 也自己生成 workerName——pickWorker 实际是 MockWorker 测试用。
4. **Provider 解析在多处分散**：`api-driver.ts` 的 `resolveProviderId` 与 `providers/registry.ts` 的 `getProvider` 是两层，需结合阅读。
5. **错误消息提到不存在的 CLI 命令**（`decx-agent providers init`）——文档/实现不同步。
6. **`sessionReuse` 只在特定 backend 有意义**（opencode-http/codex/claude），但 api-driver 和 mock-worker 永远无 session——profile 配 `sessionReuse: true` + api worker 时静默无效，应警告。
7. **`mock` kind 在 registry 中无 factory**——MockWorker 走旁路，task.json 配 `kind: "mock"` 实际不可用。

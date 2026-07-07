# 03 — `src/agent/` Protocol Layer

> Audit scope: 11 files in `decx-agent/src/agent/`
> `types.ts`, `contracts.ts`, `parse-envelope.ts`, `permissions.ts`, `main-agent.ts`,
> `decision-applier.ts`, `subagent-runner.ts`, `context-builder.ts`, `graph-view.ts`,
> `context-ledger.ts`, `fact-tiering.ts`

`agent/` 是**协议层**——定义 worker 输出 → graph 状态之间的所有形状契约、权限模型、上下文组装与决策执行。AGENTS.md 把这一层明确描述为"profile-driven subagent control plane"。

---

## 3.1 `agent/types.ts` (424 lines) — **核心数据模型**

**用途**：整个包的**类型单一来源（single source of truth）**。定义所有 graph 实体、配置形状、profile 规格、内置常量。

**关键内容**
- **ID 类型别名**：`ProjectId` / `FactId` / `IntentId` / `HintId` / `LinkId` / `DirectiveId` / `RunId` / `RoleId`（全部是 `string`，branded type 风格但未真正 brand）
- **内置角色常量**：`BUILTIN_ROLES = { planner, explorer, evaluator, metacog, system }`，注释强调 `RoleId` 实际允许任意字符串
- **Graph 实体**：`Project` / `Fact`（状态：candidate/accepted/rejected/blocked）/ `Intent`（状态：open/claimed/chained/done/failed，含 lease 租约 + chain）/ `Hint`（kind：direction/warning/stop-explorer）/ `Link` / `GraphEvent` / `Directive`
- **Verdict**：`accept | reject | demote | block` 四种决策
- **Progress**：聚合统计（stepsExecuted / stagnationLevel 等）
- **ChainRequest / SubIntentSpec**：把一个 intent 拆分为多个 sub-intents，支持 `waitMode: "all" | "any"`
- **SubagentRun**：可观察、可取消、可配额的一次 profile 执行（pending → running → completed/failed/cancelled）
- **Worker 类型**：`WorkerConfig`（kind: agent/api/mock，含 backend/command/model/apiKeyEnv 等）
- **Profile 规格**：`SubagentProfile` = `role` + `runtime`（worker + 可选 model/provider） + `prompt`（file + rules + knowledge + instructions） + `context`（graphView + maxFacts + rotateOnContextFull 等） + `permissions` + `output.contract` + `maxActive` + `intervalSeconds` + `sessionReuse` + `maxOutputTokens` + `promptCache`
- **TaskConfig**：`task` + `profiles` + `workers` + `workflow` + 可选 `control`
- **WorkflowConfig**：`limits`（maxSteps/maxConcurrent/refillPerTick/workerLeaseMs/maxStagnation/plannerCooldownSteps） + 可选 `metacog.triggers` + 可选 `stopGate`
- **常量**：`DEFAULT_LIMITS`（maxSteps=1000、maxConcurrent=3、refillPerTick=1、workerLeaseMs=300_000、maxStagnation=8）、`DEFAULT_METACOG_TRIGGERS`（everySteps=5、everySeconds=60、stagnationLevel=3）、`BUILTIN_PERMISSIONS`（planner 6 项 / explorer 1 项 / evaluator 1 项 / metacog 1 项）

**审计要点**
- ⚠️ **`Project.worker: string` 字段语义模糊**（line 51）：含义是"该项目默认 explorer profile 用的 worker 名"，但字段名太通用。注释应明确。
- ⚠️ **`Intent.lease.expiresAt: ISOTime`** 是字符串，但没有 UTC 强制约束——如果调用方写入非 UTC 时间，租约比较会有 bug。建议加 invariant 注释。
- ⚠️ **`Permission` 联合类型**没有 `read_*` 类权限——意味着 profile 输出**不能**触发纯读操作（这通常没问题，但应在文档中说明：所有读取都在 prompt 组装期由框架完成，profile 不能主动读）。
- ⚠️ **`WorkerConfig` 同时有 `apiKeyEnv` 和 `apiKey`**（line 247-248）：前者从环境变量取，后者明文。后者是危险路径，建议审计时检查所有使用点，确保明文 apiKey 不进入日志/事件。
- ⚠️ **`OutputContract` 6 种与 `CONTRACT_KIND_MAP`（subagent-runner.ts）映射不一致**：types 把 contract 当"输出契约名"（`main_decision/candidate_fact/verdict/hints/stop/chain`），但实际 worker 输出 envelope.kind 用动词形式（`decisions/fact/chain/verdict/hints/stop`）。两套命名要小心同步。
- ✅ Graph-first + domain-neutral 设计良好，没有硬编码 Android/DECX 业务术语。
- ✅ `BUILTIN_PERMISSIONS` 集中定义，便于审计。

---

## 3.2 `agent/contracts.ts` (148 lines) — **输出契约验证器**

**用途**：每种 `OutputContract` 对应一个 validator，把 `WorkerEnvelope` 转成强类型 payload。失败抛 `StageError`。这是**集中化的输出执行点**——所有 worker 输出必须经过 contract 验证才能影响 graph。

**导出的 validators**
- `validateMainDecision(envelope)` → `MainDecision`（createIntents / failIntents / consumeHintIds / concludeRun?）
- `validateCandidateFact(envelope, stage)` → `CandidateFact`（description / evidence / confidence，默认 0.7）
- `validateVerdict(envelope, stage)` → `Verdict`（decision 四选一，reject/demote 也允许）
- `validateHints(envelope, stage, creator)` → `{ hints: HintInput[] }`
- `validateStop(envelope, stage)` → `{ reason }`
- `validateChain(envelope, stage)` → `ChainRequest`

**契约注册表**：`CONTRACTS: Record<OutputContract, (envelope, stage) => unknown>`

**审计要点**
- ⚠️ **`validateMainDecision` 把 `data.from` 当作 `parentFactIds`**（line 50）：字段名是 `from`（worker 输出端），但 `MainDecisionIntent.parentFactIds` 是内部名——隐式契约。应在 prompt 模板里强制要求 worker 输出 `from` 字段，并在文档中显式声明。
- ⚠️ **`validateCandidateFact` 的默认 confidence 是 0.7**（line 81）：如果 worker 漏写 confidence 字段，candidate 会被静默赋 0.7 进入 graph。这个 fallback 值需要慎重——是否应改为必填以避免模型偷懒？
- ⚠️ **`validateHints` 的 creator 类型断言**（line 113）：`creator as HintInput["creator"]` 是 unsafe cast，假设调用方传合法值。建议加 runtime 校验。
- ⚠️ **`validateChain` 的 waitMode fallback**（line 135）：默认 `"all"` 而非抛错——宽容设计，可接受但需文档化。
- ✅ 所有 validator 共享 `parse-envelope.ts` 的 `expectKind` / `asArray` / `asString` / `asNumber`，避免重复。
- ✅ `CONTRACTS` 注册表是开放扩展点，自定义 contract 可加新 key。

---

## 3.3 `agent/parse-envelope.ts` (160 lines) — **JSON 信封提取**

**用途**：worker 输出是带 prose 包裹的 JSON 文本（可能是 ```` ```json ... ``` ```` fenced，也可能是裸 JSON）。本模块负责**从自由文本中稳健提取 `{ kind, data }` 信封**并提供小型类型访问器。

**核心导出**
- `class StageError extends Error`：携带 `stage` 字段，所有协议错误统一用此类
- `interface WorkerEnvelope { kind: string; data: unknown }`
- `parseEnvelope(text, stage)` — 三步提取：fenced code block → 末行回溯 → 失败抛错
- `expectKind(envelope, expected, stage)` — kind 校验 + data 必须是对象
- `asArray / asString / asOptionalString / asNumber` — 字段访问器，失败抛 `StageError`

**提取策略**（`extractBestJson`）
1. 先匹配 ```` ```json {...} ``` ```` fenced 块
2. 失败则从最后一行往上回溯，找包含 `{` 的行，尝试 `JSON.parse` 子串
3. `validateJsonEnvelope` 校验必须有 `kind` 和 `data` 字段

**审计要点**
- ⚠️ **`extractBestJson` 优先匹配 fenced，但 fenced 内 JSON 也可能不合法**——会回退到回溯搜索，行为复杂。建议加单元测试覆盖各种 worker 输出形态（pure JSON / fenced / prose + JSON / 多 JSON）。
- ⚠️ **`findJsonFromLine` 的复杂度**：最坏情况下 O(n²) on lines。如果 worker 输出非常大（数千行 prose），可能性能瓶颈。审计建议加输入长度上限。
- ⚠️ **`asNumber` 接受 `fallback`**（line 154）但其它 accessor 不接受——不对称设计。
- ⚠️ **没有 `asBoolean` / `asObject` accessor**：未来扩展 contract 时会需要，建议预留。
- ⚠️ **`extractBestJson` 不防 JSON injection**：worker 输出理论上可以是任意文本，`JSON.parse` 安全（不会执行代码），但如果 worker 写了带 `__proto__` 的对象，下游解构时可能出问题。建议审计下游对 parsed 对象的使用。
- ✅ 集中化提取逻辑，所有 stage 共享，避免每个 contract 自己 parse。

---

## 3.4 `agent/permissions.ts` (52 lines) — **能力令牌检查**

**用途**：`PermissionChecker` 包装 `SubagentProfile.permissions`，决策应用前用 `require(...)` / `requireAny(...)` 校验。失败抛 `PermissionDeniedError`。

**核心 API**
- `constructor(profile)` → 内部 `Set<Permission>`
- `has(permission)` → boolean
- `require(permission)` → throws if missing
- `requireAny(...permissions)` → 至少有一个即可（空数组直接通过——潜在隐患）
- `role` getter
- `class PermissionDeniedError extends Error`

**审计要点**
- ⚠️ **`requireAny(...permissions)` 空数组直接 return**（line 33）：注释虽说明"无可选项则通过"，但这意味着调用方传 `requireAny()` 不传参也会通过——可能掩盖 bug。建议至少 warn。
- ⚠️ **`permissions[0]!` 非空断言**（line 35）：此处 TypeScript 的 `!` 是合理的（前面 `length > 0` 已保证），但仍属审计关注点。可读性 OK。
- ⚠️ **`PermissionChecker` 不暴露 granted 列表**：调用方无法 introspect，对调试不友好。建议加 `get granted(): readonly Permission[]`。
- ✅ 设计极简，单一职责，无副作用，易测试。
- ✅ `PermissionDeniedError` 携带 `role` + `permission`，错误信息友好。

---

## 3.5 `agent/main-agent.ts` (83 lines) — **Planner 包装器**

**用途**：session-local 的 **planner（MainAgent）**。`SessionLoop` 每个 planner tick 调用 `MainAgent.run(input)`，得到 `MainDecision + PermissionChecker`，再交给 `DecisionApplier`。

**关键流程**（`run(input)`）
1. 取 `config.control?.mainProfile ?? "planner"` 对应的 profile
2. 调用 `runSubagent({ profile, promptExtra: plannerExtra(hints, recentVerdicts), ... })`
3. 校验 `output.kind === "decisions"`，否则抛 `StageError`
4. 若 `input.hints` 非空，把所有 hint ID 写入 `output.decision.consumeHintIds`（**重要**：planner 默认消费所有传入 hints，即使它没在输出里显式声明）
5. 返回 `{ decision, permissions: new PermissionChecker(profile) }`

**审计要点**
- ⚠️ **自动消费所有 hints**（line 77-79）：即使 planner 没在 `consumeHintIds` 里输出，MainAgent 也会强制填入所有传入 hint ID。这意味着**只要 planner 看到了 hint，就被视为已处理**。如果 planner 实际只是"看到但忽略"，hints 仍被标记 consumed——可能丢失关键人类指令。建议改为：planner 必须显式输出 `consumeHintIds`，未声明的 hints 保留为 unconsumed。
- ⚠️ **`config.control?.mainProfile ?? "planner"`** 默认值：如果 task.json 没声明 `planner` profile，会抛 `StageError`——但错误消息是 "main profile not found: planner"，可能让用户误以为需要加 `control.mainProfile` 字段。建议消息更具体。
- ✅ 文件极薄，符合"domain behavior belongs in agent stages"原则——所有执行细节都在 `subagent-runner.ts`。
- ✅ 输入/输出类型清晰（`MainAgentRunInput` / `MainAgentResult`）。

---

## 3.6 `agent/decision-applier.ts` (88 lines) — **决策 → Graph 状态**

**用途**：把 `MainDecision` 翻译成 graph 突变，**所有突变包裹在单个事务中**保证原子性。Permission 校验失败 → 事务回滚。**不调用 worker**。

**`applyMainDecision(ctx)` 流程**
```
graph.transaction(() => {
  for each createIntents[i]:
    permissions.require("create_intent")
    if graph.isDeadEnd(description): log "planner.dead_end_skipped", continue
    graph.addIntent({ description, creator: "planner", parentFactIds, priority })
    result.intentsCreated++

  for each failIntents[i]:
    permissions.require("fail_intent")
    try graph.failIntent(...) catch { /* already concluded */ }
    log "planner.kill_explorer"
    result.intentsFailed++

  for each consumeHintIds[i] (fallback: ctx.hintIdsToConsume):
    try graph.consumeHint(...) catch { /* already consumed */ }

  if decision.concludeRun:
    permissions.require("conclude_run")
    graph.updateProjectStatus(projectId, "completed")
    log "planner.conclude"
})
```

**审计要点**
- ⚠️ **`for (const spec of decision.createIntents) { permissions.require("create_intent"); ... }`**（line 42-43）：在循环内每次都 require 同一权限，多余但无害。建议提到循环外只 require 一次。
- ⚠️ **`try { graph.failIntent(...) } catch { /* intent may already be concluded */ }`**（line 59-63）：**静默吞所有异常**——如果 `failIntent` 因别的原因抛错（如 db 错误），也会被忽略。建议至少 log。审计时确认 `failIntent` 的可能异常是否仅"已 concluded"一种。
- ⚠️ **`for (const hintId of decision.consumeHintIds.length > 0 ? decision.consumeHintIds : (ctx.hintIdsToConsume ?? []))`**（line 66）：三元嵌套可读性差，且与 `MainAgent` 自动填充 consumeHintIds 的逻辑（见 3.5）重叠。如果 MainAgent 已填充，则 `ctx.hintIdsToConsume` 永远不会被用到——死代码。
- ⚠️ **事务边界**：`graph.transaction(() => { ... })` 假设 graph 实现支持嵌套事务或 savepoint。需确认 `SqliteGraph` 的事务实现（见 graph/sqlite-graph.ts）。
- ✅ 文件头注释明确："The applier does NOT call workers; it only mutates the graph."——职责清晰。
- ✅ 原子性保证：permission 失败时整个 decision 回滚，不会留下半成品状态。

---

## 3.7 `agent/subagent-runner.ts` (285 lines) — **通用执行引擎**

**用途**：**所有 profile（planner/explorer/evaluator/metacog/自定义）共用的执行引擎**。组装 prompt → 调 worker → parse envelope → 根据 profile.output.contract 验证。返回 discriminated union `SubagentOutput`。

**核心导出**
- `runSubagent(req)` — 简单包装，返回 `SubagentOutput`
- `runSubagentWithText(req)` — 完整版，额外返回 `rawText` / `prompt` / `usedDelta`
- `plannerExtra(hints, recentVerdicts)` / `explorerExtra(intentId, ...)` / `evaluatorExtra(candidate)` / `metacogExtra(trigger)` — 各角色的 promptExtra 构造器

**执行流程**（`runSubagentWithText`）
1. 取 worker name（`workerNameOverride ?? profile.runtime.workers?.[0] ?? profile.runtime.worker`）
2. 取 worker config（`config.workers[workerName]`），缺失抛错
3. 用 `PromptLoader` 加载 profile.prompt.file，缺失抛 "prompt file not loaded"
4. **Delta 优化**：如果 `profile.sessionReuse === true`，先尝试 `ledger.computeDelta(...)`；delta 体积 < 30% 用 delta，否则走 full context
5. 拼接 prompt：`[preamble, contextBlock, promptExtra].filter(Boolean).join("\n\n")`
6. `workerPool.execute({ prompt, config, workerName, projectId, maxOutputTokens, sessionId })`
7. `result.returncode !== 0` 抛 `StageError`
8. 若用了 ledger，调 `ledger.sync(...)`
9. `parseEnvelope(result.text, profile.role)` → `validateOutput(envelope, profile, profileId)`

**`validateOutput` 双重校验**：
1. `CONTRACT_KIND_MAP[contract]` 决定该 contract 允许哪些 envelope.kind（如 main_decision 只允许 "decisions"）
2. 按 envelope.kind 分派到对应 validator

**`CONTRACT_KIND_MAP`**
```
main_decision → { decisions }
candidate_fact → { fact, chain }    // explorer 可输出 fact 或 chain
verdict       → { verdict }
hints         → { hints, stop }     // metacog 可输出 hints 或 stop
```

**审计要点**
- ⚠️ **`prompt file not loaded` 错误消息**（line 98-101）：建议消息里包含实际尝试的文件路径，便于诊断。
- ⚠️ **`profile.runtime.workers?.[0] ?? profile.runtime.worker`**（line 88-89）：如果有 `workers: []` 空数组，`?.[0]` 返回 undefined，会 fallback 到 `worker`——可能不是用户意图（用户可能想完全用 workers 数组）。建议显式处理空数组。
- ⚠️ **`sessionId: useSession && req.sessionManager ? req.sessionManager.get(...)?.sessionId : undefined`**（line 141-143）：长链式 optional，可读性差。
- ⚠️ **Delta fallback 阈值硬编码 0.3**（在 `context-ledger.ts`，不在本文件）：本文件无法配置。建议把阈值放到 profile.context 或 workflow 配置中。
- ⚠️ **`result.returncode !== 0` 抛错时只看 stderr**（line 146-150）：如果 worker 把错误写在 stdout 的 JSON 里（returncode=0 但内容是错误），不会被检测。建议同时 parse envelope 看是否有 error 字段。
- ⚠️ **`plannerExtra` 自动列出 hints 让 planner 必须响应**（line 217-225）：与 `MainAgent` 自动 consume 配合，可能导致 hints 被过度消费（详见 3.5）。
- ✅ Discriminated union 设计良好，调用方 `switch (output.kind)` 可被 TypeScript 穷举检查。
- ✅ `plannerExtra / explorerExtra / evaluatorExtra / metacogExtra` 集中化 prompt 模板逻辑，避免散落各处。

---

## 3.8 `agent/context-builder.ts` (133 lines) — **动态上下文组装**

**用途**：把 `ContextSpec` + graph 状态组装成 prompt 的"上下文块"部分。决定 token 预算、相关性过滤、视图选择。

**关键功能**
- `buildDynamicContext(options)` — 主入口，根据 spec.graphView 选择渲染策略
- **`relevanceScope: "chain"`**（line 44）：只保留与当前 intent/candidate 在 graph 上 ≤2 跳的 facts（基于 `links` 关系图）
- `collectRootFactIds(options)` — 从 intent.parentFactIds / candidate.parentIntentId / enrichedContext 收集种子
- `filterRelevantFacts(graph, projectId, allFacts, rootFactIds, maxHops=2)` — BFS 扩展
- `estimateContextTokens(text)` — `Math.ceil(text.length / 4)`（粗略估算）
- `isContextNearFull(text, threshold=8000)` — 阈值检查

**审计要点**
- ⚠️ **`filterRelevantFacts` 的 BFS 复杂度**（line 88-108）：`for hop in maxHops { for link in links { ... } }`，O(maxHops × links)。如果 links 数量大（>1000），有性能问题。建议先建 adjacency map。
- ⚠️ **`filterRelevantFacts` 的兜底逻辑**（line 113-117）：如果 filter 后等长（无过滤），追加最近 5 个 fact。意图不明——是因为 BFS 失败？还是想保证总有最近 5 个？建议加注释。
- ⚠️ **`estimateContextTokens` 的 4 chars/token 估算**（line 128）：对中文/日文严重低估（约 1-2 chars/token）。如果任务涉及 CJK，token 预算会超。建议增加语种检测或参数化。
- ⚠️ **`isContextNearFull` 默认 8000** tokens（line 131）：硬编码，但实际 worker 的 context window 可能远小于此（如 4096）。建议从 workerConfig 或 profile 读。
- ✅ Relevance scope 设计良好，能显著降低 token 占用。
- ✅ 与 graph-view.ts 的分离清晰：本文件做"选哪些 facts"，graph-view 做"如何渲染"。

---

## 3.9 `agent/graph-view.ts` (206 lines) — **Graph 渲染器**

**用途**：把 facts/intents/hints/progress 等 graph 状态渲染成 markdown 文本，4 种视图策略。

**视图策略**
| view | 包含内容 | 用途 |
|---|---|---|
| `full` | 所有 accepted + rejected（top10）+ blocked（top10）+ intents + hints + verdicts | planner（需要全局视野） |
| `focused` | accepted + enrichedContext（合并）+ rejected dead-ends（top10） | explorer（聚焦当前任务） |
| `evidence-only` | 仅 accepted 中 evidence.length > 0 的，附 evidence 列表 | evaluator（review 时只看证据） |
| `summary` | 仅 progress 数字 + 最近 5 个 verdict | metacog / 节省 token |

**关键阈值**
- `TIER_THRESHOLD = 15`：超过则用 `tierFacts` 分层渲染
- `cap(items, max)`：保留最后 max 项（最新的）

**审计要点**
- ⚠️ **`renderFull` 渲染 intents 时只列出 3 种状态**（line 105-107）：open/claimed/chained——但 types 定义了 5 种 IntentStatus（还有 done/failed）。这是合理的（done/failed 不需要给 planner 看），但建议加注释。
- ⚠️ **`cap` 保留尾部**（line 56-59）：意味着总是丢最老的——对"事实重要性 ≠ 时间"的场景可能不合适。`tierFacts` 已经在 fact-tiering 里做了更精细的处理，cap 是粗粒度 fallback。
- ⚠️ **`renderFocused` 把 `enrichedContext` 与 acceptedFacts 合并**（line 131）：可能重复（enrichedContext 本身就是 accepted facts 的子集）。建议去重。
- ⚠️ **`renderSummary` 的 fallback**（line 173-177）：如果没传 progress，自己算 `rejectedCount`，但没算 accepted/blocked——输出不对等。
- ✅ 4 种视图策略覆盖典型场景。
- ✅ 与 `fact-tiering.ts` 解耦——超过阈值才调用 tier 逻辑。

---

## 3.10 `agent/context-ledger.ts` (171 lines) — **Delta 同步账本**

**用途**：跟踪每个 `(projectId, profileId)` 已见的 fact/intent/verdict 集合，让 SubagentRunner 只发送 delta（典型节省 90% token）。**仅在 `profile.sessionReuse === true` 时启用**。

**核心 API**
- `get(projectId, profileId)` — 取账本条目
- `computeDelta(projectId, profileId, graph, recentVerdicts, deltaThreshold=0.3)` — 计算 delta
- `sync(projectId, profileId, graph, recentVerdicts, progress)` — 更新账本到当前状态
- `reset(projectId, profileId)` / `resetProject(projectId)` — 清除

**Delta 决策**
1. 没有账本 → 返回 fullResult（isDelta=false，调用方走 full context）
2. 计算 newAccepted / newRejected / newIntents / newVerdicts
3. 若 `deltaItems / totalItems > deltaThreshold (0.3)` → 返回 fullResult
4. 若全部为空 → 返回 `"No changes since last call."`
5. 否则渲染 delta block

**审计要点**
- ⚠️ **`verdictSig(v) = "${factId}:${decision}"`**（line 169-170）：只看 factId + decision，不看 reason。如果 evaluator 对同一 fact 多次 review 但 reason 变了，不会触发 delta——可能导致 planner 看不到 reason 更新。建议加入 reason hash。
- ⚠️ **`ledger` 是内存对象，不持久化**：进程重启后所有 delta 状态丢失，第一次调用必走 full context。对于长跑任务（如 metacog 30s tick），重启代价可接受；但对于 worker session 跨进程的场景（如 codex CLI），session 重连后 ledger 失效——可能与 `sessionReuse` 的预期不符。
- ⚠️ **`computeDelta` 不接受自定义阈值覆盖**（除了 default 0.3）：调用方无法针对敏感 profile 调整。建议加参数。
- ⚠️ **`sync` 不返回是否触发过 full sync 的统计**：可观察性不足。
- ✅ Delta 协议设计精巧：30% 阈值是经验值，超过则承认"变化太大，不如全量"。
- ✅ 内存实现，零 I/O，性能极佳。

---

## 3.11 `agent/fact-tiering.ts` (121 lines) — **Fact 分层压缩**

**用途**：把 accepted facts 分为 hot/warm/cold 三层，warm 超过阈值时压缩为"Findings Summary"。用于长跑任务的 token 控制。

**分层规则**（默认 `hotSteps=10, warmMaxFacts=20, compressThreshold=30`）
- **hot**：`fact.stepDiscovered >= currentStep - 10`（最近 10 步内发现）
- **warm**：其余，但若总数超过 `compressThreshold (30)`，最老的 `warm.length - warmMaxFacts` 个被压缩为 summary
- **cold**：实际未使用（`cold: []`，line 74）——预留概念，未实现

**渲染**（`renderTieredFacts`）
- 若有 summary → `## Earlier Findings (compressed)`
- 若有 warm → `## Prior Findings`（每条 truncate 到 60 字符）
- 若有 hot → `## Recent Findings`（含 confidence %，完整 description）

**审计要点**
- ⚠️ **`cold` 永远是空数组**（line 74）：三层模型实际只用了两层。要么实现 cold（如完全不渲染），要么删除字段。当前是死代码。
- ⚠️ **`factStep` fallback**（line 77-80）：如果 `fact.stepDiscovered` 不是数字，用 `Math.max(0, fallback - offset)`——`offset` 是 `sorted.length - i`，即按插入顺序倒推。这个 fallback 假设 facts 按时间顺序传入，但 `tierFacts` 已经按 `createdAt` 排序，所以 OK。但逻辑链隐晦，建议加注释。
- ⚠️ **`compressFacts` 把 description truncate 到 50 字符**（line 83），但 `renderTieredFacts` 的 warm 是 60 字符——不一致。
- ⚠️ **`sort by createdAt.localeCompare`**（line 50）：`createdAt` 是 ISOTime 字符串，lexicographic sort 对 ISO8601 同格式有效，但若时间精度不一致（毫秒 vs 秒）会出错。
- ✅ 分层压缩机制对长跑任务（>30 facts）有效。
- ✅ 默认参数合理，可通过 `TierOptions` 覆盖。

---

## 跨文件观察（Cross-file Observations）

1. **协议层分层清晰**：
   - `types.ts`（形状） → `parse-envelope.ts`（提取） → `contracts.ts`（验证） → `permissions.ts`（授权） → `decision-applier.ts`（执行）
   - `subagent-runner.ts` 是编排核心，串起所有上述模块
2. **Hint 消费链有缺陷**：`MainAgent` 自动填充 `consumeHintIds` + `DecisionApplier` 的 fallback `ctx.hintIdsToConsume`——两套机制叠加，hints 可能被静默消费。审计建议**统一为 planner 显式输出 consumeHintIds**。
3. **Token 控制三层冗余**：`graph-view.maxFacts` + `context-builder.relevanceScope` + `fact-tiering.compressThreshold`——三个机制叠加，调试时不易定位 token 超额原因。建议统一配置入口。
4. **Delta 账本不持久化**：跨进程 worker session 场景下，sessionReuse 的预期可能与实际不符。
5. **Cold tier 是死代码**：fact-tiering 预留未实现。
6. **没有单元测试覆盖**：根据 codegraph 的 blast radius 标记，`MainAgent` / `DecisionApplier` / `SubagentRunner` 都没有覆盖测试（只有 `subagent-runner.test.ts` 存在），是审计重要关注点。

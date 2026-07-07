# 04 — `src/session/` Session Runtime

> Audit scope: 5 files in `decx-agent/src/session/`
> `session-loop.ts`, `supervisor.ts`, `metacog-supervisor.ts`, `project-lock.ts`, `session-manager.ts`

`session/` 是**运行时调度层**——包含 per-session 主循环、跨 session 全局调度、wall-clock 元认知循环、项目级互斥、session 文件系统管理。

---

## 4.1 `session/session-loop.ts` (482 lines) — **Per-Session 主循环（核心）**

**用途**：单 session 内**最核心的调度文件**。驱动一个项目的 step 循环：directives → planner → explorers → evaluators → chains → termination。所有 SubagentRun 生命周期管理与角色分派都在这里。

**核心状态**
- `locks: ProjectLockManager` — per-project 异步互斥
- `contextLedger: ContextLedger` — delta 同步账本（profile.sessionReuse=true 时启用）
- `sessionManager: WorkerSessionManager` — worker 会话生命周期
- `stepVerdicts: Map<ProjectId, Array<...>>` — 当前 step 内 evaluator 输出的 verdict 缓存，传给下一轮 planner
- `lastPlannerStep: Map<ProjectId, number>` — planner 冷却步数追踪
- `promptLoader: PromptLoader` — 共享 prompt 加载器

**`StepResult` 4 种**
- `stepped` — 推进了 intents/facts
- `idle` — 无事可做（paused / 无 open intents）
- `completed` — 项目完成
- `failed` — 项目失败

**执行入口**
- `step(projectId)` — 单步，加 project 锁
- `tick()` — 遍历所有 active 项目各跑一步（`Promise.allSettled`）
- `run(projectId, options)` — 阻塞循环直到 completed/failed 或 maxSteps（默认 100，**注意：不是 DEFAULT_LIMITS.maxSteps 的 1000**）

**`stepLocked(projectId)` 流程**
```
1. project = graph.getProject(projectId)  // 不存在 → failed
2. graph.sweepExpiredLeases()              // 清理过期 worker 租约
3. consumeDirectives(projectId)            // 处理人类/系统指令
4. 若项目状态非 active：
   - completed/stopped → return completed
   - failed → return failed
   - 其他 → return idle
5. factsBefore = facts(accepted).length
6. maybeRunPlanner(projectId)              // 触发条件性调用 planner
7. dispatched = dispatchExplorers(projectId)
8. runEvaluators(projectId)
9. resolveChains(projectId)                // 处理 chained intent 的 sub-intents 完成后的 resume
10. checkTermination(projectId)            // maxSteps / stopGate / stagnation 检测
11. return stepped(intentsDispatched, factsAfter - factsBefore)
```

**`consumeDirectives` 支持的指令**
- `stop` → updateProjectStatus(stopped)
- `pause` → updateProjectStatus(paused)
- `resume` → updateProjectStatus(active)
- `hint` → addHint({ creator: "human" })
- `kill-intent` → failIntent(payload, "killed by directive")
- `spawn-intent` → addIntent({ description: payload, creator: "human" })

**`maybeRunPlanner` 触发条件**
- `intents.length === 0`（空），或
- 有 `direction` / `stop-explorer` 类型的 unconsumed hint，或
- 上一 step 的 verdict 含 reject/demote

**冷却**：`plannerCooldownSteps`（默认 3）——如果上次 planner 调用距今不够，且不满足强制条件，则跳过。

**`dispatchExplorers` 调度**
1. 过滤 dead-end intents（直接 failIntent 并 log）
2. 计算可用 slot：`min(maxConcurrent - claimedCount, refillPerTick, dispatchable.length)`
3. 若 `explorerProfile.maxActive` 设定，再裁剪到 `maxActive - inFlight`
4. `Promise.allSettled(batch.map(runOneExplorer))`

**`runOneExplorer` 单 intent 执行**
1. 创建 SubagentRun
2. claimIntent（设租约 leaseMs）
3. 调用 `runSubagentWithText` with explorerExtra
4. 输出 `chain` → `graph.chainIntent`
5. 输出 `fact` → `graph.addFact + concludeIntent`
6. 异常 → failIntent + log

**`runEvaluators`**
- 取 `pendingCandidates`（status=candidate 的 facts）
- 每个 candidate 调用 evaluator profile
- 输出 verdict → `graph.resolveFact`
- **异常时强制 reject**：`resolveFact(candidate, { decision: "reject", reason: "evaluator error: ..." })`——evaluator 失败等于 reject，不会留 candidate

**`resolveChains`**
- 取 status=chained 的 intents
- 检查 sub-intents 是否达到 waitMode 条件（all/any）
- 收集 done 状态 sub-intents 的 concludedFactId 作为 enrichedContext
- `resumeChainedIntent` + 重新 claimIntent + 再跑 explorer profile（isResume=true）

**`checkTermination` 终止条件**
1. 项目状态非 active → completed/failed/idle
2. `stepsExecuted >= maxSteps` → failed
3. `stopGate.requireNoOpenIntents && openIntents == 0 && chainedIntents == 0`：
   - 若设了 `minFactConfidence`，计算 accepted 平均 confidence，不达标则继续；达标则 completed
4. `stagnationLevel >= maxStagnation && openIntents == 0 && chainedIntents == 0` → paused（等 directive resume）

**审计要点**
- ⚠️ **`run` 默认 maxSteps=100**（line 75），但 `DEFAULT_LIMITS.maxSteps=1000`——两个默认值不一致。`AgentRuntime.run` 不传 maxSteps 时会用 `config.workflow.limits.maxSteps`，而 `SessionLoop.run` 直接调用时会用 100。建议统一。
- ⚠️ **`locks` 和 `locks_` 同时存在**（line 43, 47, 55）：`locks_ = locks`，两份引用指向同一对象。`locks_` 是给 `MetacogSupervisor` 用的（见 `agent-runtime.ts` line 56），但下划线命名让人困惑。建议合并为单一 `locks` 字段并文档化"外部组件可读"。
- ⚠️ **`runOneExplorer` 的 `outputTokens = 0`**（line 265）：硬编码 0，从未实际计算。SubagentRun.outputTokens 字段永远是 0——审计 / 计费场景会失真。建议从 `result` 拿（worker result 是否含 token 统计需查 worker 层）。
- ⚠️ **`inputTokens = Math.ceil(prompt.length / 4)`**（line 264）：与 context-builder 一样的 4 chars/token 估算，CJK 任务会偏低。
- ⚠️ **`maybeRunPlanner` 的 try/catch 静默吞所有异常**（line 178-200）：planner 抛错只 log event，不向上传播——意味着 planner 挂掉项目继续跑（可能空转）。如果 planner 持续失败，会消耗 maxSteps 而无进展。建议加连续失败计数器，超过阈值 fail 项目。
- ⚠️ **`consumeDirectives` 在 `stop`/`pause` 后 `return`**（line 124, 128）：意味着一次只处理一个 stop/pause directive，后续未处理 directive 留在队列里下次 step 处理——但此时项目已停，永远不会处理。**潜在 directive 积压 bug**：如果同时入队 stop + spawn-intent，spawn-intent 永远不会执行。建议改为：循环处理 directives，遇到 stop/pause 时记录但继续处理完所有 directive。
- ⚠️ **`dispatchExplorers` 的 explorer profile 隐式依赖**（line 223）：`this.config.profiles.explorer` 未做存在性检查，缺失会 NPE。
- ⚠️ **`runEvaluators` 异常 → 强制 reject**（line 354-358）：evaluator worker 故障（网络/超时）会把 candidate 直接 reject，等于"评审失败即否决"。这对 evaluator 偶发故障的项目过于严苛。建议改为：保留 candidate 状态 + 重试 N 次后再 reject。
- ⚠️ **`resolveChains` 没有死代码保护**：`chainIntent` 后的 chained intent，sub-intents 由谁调度？看代码 sub-intents 通过 `graph.chainIntent` 创建后是 open 状态，会被下一轮 `dispatchExplorers` 调度。但 `resolveChains` 本身不创建 SubagentRun for sub-intents——逻辑分散在两处，审计时需追踪完整链路。
- ⚠️ **`checkTermination` 的 stagnation pause**（line 470-474）：stagnation 触发 paused 后，只能通过 `resume` directive 恢复——但如果 stagnation 是因为 evaluator 持续 reject 导致，pause 后 resume 又会立刻 stagnation。需要 metacog 介入产生 hint。审计时确认这个反馈环路是否健康。
- ✅ ProjectLockManager 保证同项目内串行，跨项目并发——调度模型清晰。
- ✅ `Promise.allSettled` 用于并发分派，单个 explorer/evaluator 失败不影响其他。
- ✅ Dead-end 自动跳过（line 207-210）防止无谓重试。
- ✅ Stop gate 设计良好（requireNoOpenIntents + minFactConfidence 双重条件）。

---

## 4.2 `session/supervisor.ts` (95 lines) — **跨 Session 全局调度**

**用途**：`GlobalSupervisor` 管理多个 `SessionLoop`，提供全局 tick 和跨 session 并发配额。**不拥有** per-session planning/graph mutation/metacog 调度——这些留在 session-local。

**核心 API**
- `register(id, loop)` — 注册（重复 id 抛错）
- `unregister(id)` / `get(id)` / `listSessions()`
- `tick()` — 并发 step 所有 active session 的所有 active project
- `stepSession(sessionId, projectId)` — 单次单 session 单 project

**构造选项**
- `globalMaxConcurrent`（默认 `Infinity`）——审计重点：实际**没有**生效的代码路径
- `federationBus`（默认 `new FederationBus()`）

**审计要点**
- ⚠️ **`globalMaxConcurrent` 是死代码**（line 41, 45）：构造期读取并存为 readonly 字段，但 `tick()` 内**没有任何代码**用它限制并发。`Promise.allSettled(active.map(...))` 是无限并发。AGENTS.md 说"Enforce a global worker concurrency quota across all sessions"——**承诺未兑现**。建议要么实现（如 Semaphore），要么删除字段。
- ⚠️ **`tick` 内只取 `stepResults[0]`**（line 77）：`loop.tick()` 返回数组（一个 session 可能有多个 active project），但 supervisor 只报告第一个——其他 project 的结果丢失。建议改为返回扁平结构 `GlobalTickResult[]` 或 aggregate。
- ⚠️ **`active[idx]!.id` 非空断言**（line 81）：依赖 `Promise.allSettled` 保持顺序，正确但脆弱。
- ✅ 设计原则正确：session-local 自治，supervisor 只做并发调度。
- ✅ FederationBus 注入点清晰。

---

## 4.3 `session/metacog-supervisor.ts` (140 lines) — **Wall-Clock 元认知循环**

**用途**：独立的 wall-clock 定时器（默认 30s），按 trigger 条件触发 metacog profile 产生 hints 或 stop。**与 SessionLoop 的 step 节奏解耦**——metacog 可以在 step 间隙运行。

**核心状态**
- `timer: setInterval` 句柄
- `running: boolean`
- `intervalMs`（默认 30000，可被 `workflow.metacog.triggers.everySeconds` 覆盖）
- `contextLedger: ContextLedger`（与 SessionLoop 的 ledger **不同实例**——独立 delta 追踪）
- `sessionManager: WorkerSessionManager`（同样独立实例）

**`start()` 流程**：立即跑一次 tick + 设定时器。

**`runForProject(projectId)` 流程**
1. acquire project lock（**与 SessionLoop 共享同一个 ProjectLockManager**——避免冲突）
2. 计算 trigger：
   - `stagnationLevel >= triggers.stagnationLevel (3)`，或
   - `stepsExecuted > 0 && stepsExecuted % everySteps (5) === 0`，或
   - `openIntents == 0 && chainedIntents == 0 && candidateFacts == 0 && acceptedFacts > 0`（"似乎完成了"）
3. 取 metacog profile（`control.metacogProfile ?? "metacog"`），不存在则静默返回
4. 检查 `maxActive`（默认 1）
5. 创建 SubagentRun + 调用 `runSubagent` with `metacogExtra("scheduled")`
6. 输出 `hints` → 批量 `graph.addHint`
7. 输出 `stop` → `updateProjectStatus(stopped)` + log
8. 其他 kind → 标记 completed 但 log "unexpected kind"

**审计要点**
- ⚠️ **`start()` 不等待第一次 tick 完成**（line 43）：`this.tick()` 是 async 但没 await，立即 setInterval。第一次 tick 可能与定时器触发的下一次 tick 重叠——`running` 标志只防 `start` 重复调用，不防 tick 重叠。`locks.acquire` 会串行化，但 SubagentRun 会重复创建。建议加 `if (this.tickRunning) return;` 守卫。
- ⚠️ **`stop()` 不等待进行中的 tick 完成**（line 47-53）：只清 timer，已在跑的 `runForProject` 会继续到结束。如果 `stop()` 后立即 `close()`，可能产生孤儿 SubagentRun。
- ⚠️ **trigger 第 3 条件**（line 79）：`openIntents == 0 && chainedIntents == 0 && candidateFacts == 0 && acceptedFacts > 0`——这个组合实际上等价于"planner 没活干但有成果"，与 SessionLoop 的 stopGate 重叠。可能导致 metacog 与 SessionLoop 竞争判断完成：metacog 产生 stop hint，SessionLoop 同时跑 stopGate。需要确认两者顺序。
- ⚠️ **`output.kind` 不是 hints/stop 时**（line 127-131）：标记 completed 但 outputSummary 是 "unexpected kind: ..."——metacog worker 行为不合规被静默接受。建议加 logEvent 或 fail run。
- ⚠️ **`runForProject` 的 catch 不抛错**（line 133-137）：metacog worker 失败只 log，不影响 supervisor 状态——但也没重试机制。连续失败的 metacog 不会被察觉。
- ⚠️ **`intervalMs` 优先级**（line 35-36）：`intervalMs ?? (cfg ? cfg * 1000 : DEFAULT_METACOG_INTERVAL_MS)`——构造期显式参数优先于配置，对于运行时改配置不友好。但 metacog supervisor 一般构造一次，OK。
- ✅ 独立 ledger / sessionManager 实例避免与 SessionLoop 状态污染。
- ✅ 与 SessionLoop 共享 ProjectLockManager，避免 lock 竞争。
- ✅ Trigger 三选一设计合理（stagnation / 步数节奏 / 完成检测）。

---

## 4.4 `session/project-lock.ts` (53 lines) — **项目级异步互斥**

**用途**：基于 Promise chain 的 per-project FIFO 互斥。同项目串行，跨项目并行。

**算法**
```ts
acquire(projectId, fn):
  pending[projectId]++
  previous = chains[projectId] ?? resolved
  next = new Promise(release => ...)
  chains[projectId] = previous.then(() => next)
  try:
    await previous
    return await fn()
  finally:
    release()
    pending[projectId]--
    if pending == 0: delete chains[projectId] + pending[projectId]
```

**审计要点**
- ⚠️ **不支持重入**（line 18-20 注释明确说明）：同一 async chain 内二次 acquire 会死锁。如果 metacog `runForProject` 在持锁时调用其他需要同 project 锁的代码，会卡住。审计时确认调用图无重入。
- ⚠️ **`fn()` 抛错时 release 仍执行**（finally）——OK。但 `fn()` 返回 rejected promise 时，`await fn()` 会抛，被 acquire 调用方接到——OK。
- ⚠️ **内存泄漏风险**：`chains.delete` 只在 `pending == 0` 时执行。如果某次 `previous` 永远不 resolve（理论上不可能，因为 release 总在 finally 调用），会泄漏。当前实现安全。
- ⚠️ **没有超时**：如果一个 fn 卡住 1 小时，所有后续 acquire 都会等 1 小时。建议加可选 timeout。
- ⚠️ **没有取消机制**：`acquire` 后无法中途取消——一旦排队就必须等到 fn 完成。
- ✅ 实现极简，无外部依赖。
- ✅ FIFO 保证（previous.then(() => next) 顺序明确）。
- ✅ `pendingCount(projectId)` 提供可观察性。

---

## 4.5 `session/session-manager.ts` (64 lines) — **Session 文件系统管理**

**用途**：session id ↔ 文件系统路径的双向映射。创建/open SQLite graph 文件，list/delete session。**不持有运行时状态**。

**目录结构约定**
```
<baseDir>/<sessionId>/
  analysis.db   ← SQLite 文件
```

**核心 API**
- `sessionDir(id)` / `dbPath(id)` / `info(id)` — 路径查询
- `listSessions()` — 扫描 baseDir 子目录，过滤有 `analysis.db` 的
- `open(id)` — mkdir + new SqliteGraph(dbPath)
- `openReadOnly(id)` — 不创建目录，db 不存在则抛
- `delete(id)` — `rmSync(dir, { recursive: true, force: true })`

**审计要点**
- ⚠️ **`openReadOnly` 名不副实**（line 53-58）：函数名说"只读"，但 `new SqliteGraph(info.dbPath)` 与 `open()` 用同一构造——`SqliteGraph` 是否真的以 read-only 模式打开？需要查 `sqlite-graph.ts`。如果构造期不区分 RO/RW，`openReadOnly` 实际可写——审计重要关注点。
- ⚠️ **`delete` 用 `rmSync(recursive: true, force: true)`**（line 62）：`force: true` 意味着不存在也不抛错，但 `recursive: true` 删整个目录——如果用户误传 session id = ".." 或绝对路径，可能误删。建议加路径校验（不允许 `/`, `..`, 绝对路径）。
- ⚠️ **没有路径转义保护**：`join(this.baseDir, sessionId)` 如果 sessionId 含 `../`，会跳出 baseDir。**安全漏洞**——CLI 用户输入的 session 名需要上游 sanitization。建议在 `sessionDir` 加校验：`if (sessionId.includes("..") || path.isAbsolute(sessionId)) throw`。
- ⚠️ **`listSessions` 的过滤条件**（line 43）：必须有 `analysis.db` 才算 session——如果用户的 session 目录结构变了（如未来改名为 `decx-analysis.db`），全部 session 隐形。建议加配置或常量。
- ⚠️ **没有 lock 文件**：多进程同时 open 同一 session 不会冲突检测（SQLite WAL 模式下并发 OK，但仍可能 schema migration 竞争）。
- ✅ 文件极简，职责单一。
- ✅ `mkdirSync(recursive: true)` 保证目录存在。

---

## 跨文件观察（Cross-file Observations）

1. **`SessionLoop` 是核心调度器**，是审计的**最高优先级文件**。其中 directives 处理 / planner 触发 / chain resolve / termination 每一个分支都有边界情况。
2. **`GlobalSupervisor.globalMaxConcurrent` 是死代码**——AGENTS.md 的承诺未兑现，重要功能 gap。
3. **`SessionLoop.locks_` 命名不规范**——下划线后缀的"内部"标识实际是 public 接口的一部分。
4. **`SessionManager.openReadOnly` 可能名不副实**——需结合 `SqliteGraph` 实现确认。
5. **`SessionManager` 缺路径转义保护**——CLI 输入直接进入 join，潜在安全风险。
6. **Directive 处理在 stop/pause 后中断**——可能积压未处理 directive。
7. **`run` 默认 maxSteps=100 与 `DEFAULT_LIMITS.maxSteps=1000` 不一致**——两个默认值的来源需要统一。
8. **Metacog 与 SessionLoop 共享 ProjectLockManager 但 ledger/sessionManager 实例独立**——状态隔离设计良好。

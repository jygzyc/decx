# 08 — `src/graph/` Storage Layer

> Audit scope: 5 files in `decx-agent/src/graph/`
> `graph.ts`, `in-memory-graph.ts`, `sqlite-graph.ts`, `federated-graph.ts`, `federation-bus.ts`

`graph/` 是 **状态持久化层**——定义 `Graph` 接口（session-local 单一来源真相）+ 两个实现（InMemoryGraph 测试用 / SqliteGraph 生产用）+ 跨 session 只读联邦（FederatedGraph / FederationBus）。

---

## 8.1 `graph/graph.ts` (151 lines) — **Graph 接口与辅助函数**

**用途**：定义所有存储后端必须实现的 `Graph` 接口，以及 ID 生成 / 时间戳 / route hash 辅助函数。所有 stage 通过此接口操作状态，**不直接依赖具体实现**。

**核心导出**
- 输入类型：`HintInput` / `ProjectInput` / `FactInput` / `IntentInput` / `LinkInput`
- `Graph` 接口（30+ 方法）：覆盖 project / fact / intent / hint / directive / link / subagentRun / event / progress / transaction 全生命周期
- `routeHash(description)`：djb2 hash → `rh_<hex>`（用于 dead-end 去重）
- `now()` / `newProjectId()` / `newRunId()`：ID/时间戳生成器

**Graph 方法分组**
1. **Project**: createProject / getProject / listProjects / updateProjectStatus / touchProject
2. **Fact**: addFact / getFact / facts(status?) / pendingCandidates / resolveFact(verdict)
3. **Intent**: addIntent / getIntent / intents(status?) / claimIntent(workerId, leaseMs) / releaseIntent / concludeIntent(factId?) / failIntent(reason, recordDeadEnd, killedBy) / chainIntent(chain) / resumeChainedIntent / isDeadEnd(description) / sweepExpiredLeases
4. **Hint**: addHint / unconsumedHints / consumeHint
5. **Directive**: addDirective / unconsumedDirectives / consumeDirective
6. **Link**: addLink / links
7. **SubagentRun**: createSubagentRun / updateSubagentRun(patch) / getSubagentRun / subagentRuns(filter?)
8. **Event**: logEvent(type, payload) / events(sinceSeq?, limit?)
9. **Progress**: progress → { totalFacts, acceptedFacts, candidateFacts, rejectedFacts, blockedFacts, openIntents, claimedIntents, chainedIntents, stepsExecuted, lastActivityAt, stagnationLevel }
10. **Transaction**: transaction<T>(fn) — 必须支持嵌套（实现可忽略内层）

**审计要点**
- ⚠️ **`routeHash` 用 djb2 算法**（line 132-138）：32-bit hash，理论上可能冲突（不同 description 映射到同一 hash），导致 false-positive dead-end 匹配。description 截断到 120 字符后 hash，进一步增加冲突可能。审计建议：对关键场景（如 planner 决策），加 description 完全相等二次校验。
- ⚠️ **`newProjectId` 用 `Math.random`**（line 146）：8 字符 hex，碰撞概率 ~1/16M。生产环境长跑可能撞——建议加 `Date.now()` 维度或用 UUID。
- ⚠️ **`newRunId` 用 `Date.now().toString(36)` + 4 字符 random**：高并发（同毫秒多 run）下可能撞——4 字符 random 只有 ~1M 空间。
- ⚠️ **接口方法多但没有 readonly 区分**：`getProject` / `facts` 等读方法与 `addFact` / `resolveFact` 写方法在接口上混在一起——`FederatedGraph` 应该只暴露读，但 `Graph` 接口本身没有 `ReadOnlyGraph` 子接口。
- ⚠️ **`updateSubagentRun` 的 patch 类型很长**（line 118-120）：用 `Partial<Pick<SubagentRun, ...>>`——维护时增删字段易遗漏。
- ⚠️ **`failIntent` 默认 `recordDeadEnd = true`**：但 SessionLoop 的 directive kill 路径传 `false`（line 139 of session-loop.ts），planner kill 也传 `false`（line 60 of decision-applier.ts）——只有 explorer 失败才记 dead-end。语义合理但需文档化。
- ⚠️ **没有 `addEvidence` / `appendFactDescription` 等增量更新 API**：fact 一旦创建不可修改（除了 status/confidence/reviewer）。如果需要补充 evidence，必须新创 fact。设计选择 OK 但限制明确。
- ✅ 接口完整，覆盖所有 graph 实体。
- ✅ 嵌套 transaction 通过 `if (this.inTx) return fn();` 实现（sqlite-graph.ts line 668）——简洁。

---

## 8.2 `graph/in-memory-graph.ts` (721 lines) — **内存 Graph 实现**

**用途**：测试和轻量场景的 Graph 实现，用 `Map<ProjectId, Map<Id, Entity>>` 组织。**通过 `structuredClone` 实现事务快照**——比 SQLite 慢但无 I/O。

**关键架构**
- 顶层 `state: InMemoryState` 包含 16 个 Map：projects / facts / intents / hints / directives / links / events / runs / 各种 counter
- `transaction(fn)` 用 `structuredClone(state)` 备份，失败时恢复
- 所有写方法都用 `this.transaction(() => ...)` 包裹

**ID 生成**：与 SQLite 一致——`f001` / `i001` / `h001` / `d001` / `l001`，前缀 + 3 位数字（`padStart(3, "0")`）

**关键状态转换**
- `addFact` → status: candidate（初始）
- `resolveFact(verdict)`：
  - `decision: reject` → status: rejected
  - `decision: block` → status: blocked, confidence = min(原值, 0.35)
  - `decision: accept | demote` → status: accepted
- `claimIntent` → status: claimed + lease
- `chainIntent` → status: chained + 创建 sub-intents（status: open）
- `concludeIntent(factId?)` → status: done + bumpStep
- `failIntent` → status: failed + （可选）记录 dead-end + bumpStagnation（如果之前不是 done）

**审计要点**
- ⚠️ **`structuredClone(state)` 事务快照成本**（line 650-652）：每次事务 deep clone 整个 state——大 graph（1000+ facts）下单次事务可能几 MB 内存 + 几十毫秒。测试场景 OK，但不应误用于生产。
- ⚠️ **`fact.status !== "candidate" && fact.status !== "blocked"` 抛错**（line 218-220）：意味着只能从 candidate/blocked 转 resolved——但已 accepted 的 fact 不能再次 review。如果需要"重新评审"，必须先回到 candidate（无 API）。**设计限制**。
- ⚠️ **`resolveFact` 的 stagnation 重置**（line 231-233）：只有 accept/demote 重置 stagnation 为 0，reject/block 不重置——意味着连续 reject 会让 stagnation 累积。这是设计意图（连续 reject = 项目停滞），但可能与 metacog trigger 冲突。
- ⚠️ **`failIntent` 的 `wasDone` 检查**（line 324, 338-341）：如果 intent 已经 done，再 fail 不 bumpStep/stagnation——避免双重计数。但 status 仍改为 failed，意味着 done → failed 转换会发生，这违反"done 是终态"的直觉。建议加注释。
- ⚠️ **`unconsumedHints` 用 `now()` 比较 expiresAt**（line 433-434）：ISOTime 字符串 lex 比较，依赖时间格式一致（都是 ISO8601）——OK。
- ⚠️ **`progress` 用 `facts(projectId)` 全量加载再过滤**（line 600-622）：每次 progress 调用扫描所有 facts——大 graph 下慢。SQLite 版本用 `SELECT status FROM facts` 投影，但内存版本仍是全量。
- ⚠️ **没有 `reset()` 或 `clear()` 方法**：测试间清理只能 new 新实例。
- ⚠️ **`snapshots` 字段定义但未使用**（line 71）：死字段。
- ✅ 与 SQLite 实现行为一致（接口同实现），便于测试可信度。
- ✅ structuredClone 是 Node 17+ 的内置 API，无外部依赖。

---

## 8.3 `graph/sqlite-graph.ts` (835 lines) — **SQLite Graph 实现（生产）**

**用途**：基于 `node:sqlite` 的生产级 Graph 实现。所有状态持久化到 `<session>/analysis.db`。

**Schema 设计**
- 9 张表：projects / facts / intents / intent_sources / hints / directives / links / subagent_runs / events / dead_ends / meta
- 所有表 PRIMARY KEY 复合 `(project_id, id)`——一个 DB 文件可存多 project
- PRAGMA：`journal_mode=WAL`（并发读不阻塞写）+ `busy_timeout=5000`（写竞争等待 5s）+ `foreign_keys=ON`
- 索引：`idx_runs_project_status` / `idx_runs_project_profile` / `idx_events_project`

**关键常量**
- WAL 模式：写不阻塞读
- busy_timeout 5s：跨进程并发写竞争容忍
- meta 表存 `steps:<projectId>` / `stagnation:<projectId>` 计数器

**Transaction 实现**（line 667-681）
```
if (this.inTx) return fn();   // 嵌套直接执行
this.inTx = true;
this.db.exec("BEGIN");
try { result = fn(); this.db.exec("COMMIT"); return result; }
catch (err) { this.db.exec("ROLLBACK"); throw err; }
finally { this.inTx = false; }
```

**Migration**（line 182-188）：try/catch ALTER 添加 `required_conditions_json` 列——幂等。

**审计要点**
- ⚠️ **`events` 表 seq 是 AUTOINCREMENT 全局**（line 148）：不是 per-project——所有 project 共享一个 seq 序列。`events(projectId, sinceSeq)` 过滤时 OK，但跨 project 排序时 seq 数字混在一起。
- ⚠️ **`migrate()` 只处理一个 ALTER**（line 182-188）：如果未来加更多列/表，需要扩展。当前 schema 与 `SCHEMA` 常量中 `CREATE TABLE IF NOT EXISTS` 配合——首次创建是新 schema，老 DB 升级靠 migrate。
- ⚠️ **`addFact` 的 stepDiscovered 从 meta 读 `steps:<projectId>`**（line 251-252）：意味着 fact 创建时如果 meta 没初始化，stepDiscovered=0。新 project 第一个 fact 总是 stepDiscovered=0。
- ⚠️ **`nextId` 用 `COUNT(*)`**（line 697-700）：删 fact 后再添加，会复用旧 ID——潜在 ID 冲突。虽然 InMemoryGraph 也用 count，但 SQLite 通常更持久。建议用 auto-increment 或单独 counter 表。
- ⚠️ **`updateProjectStatus` 不检查 project 是否存在**（line 233-238）：UPDATE 不存在的 id 静默无影响，没抛错——与 `addFact` 等抛 `project not found` 不一致。
- ⚠️ **`sweepExpiredLeases` 是公开方法**（line 451-460）：但 SessionLoop 主动调用它——如果忘记调用（如自定义 supervisor），过期 lease 一直挂着。
- ⚠️ **`events` 查询默认 `ORDER BY seq DESC LIMIT ?` 然后 reverse**（line 638-639）：取最后 N 条按正序返回。但 `sinceSeq` 路径是 `seq > ? ORDER BY seq LIMIT ?`——两个路径语义略不同。
- ⚠️ **`progress` 多次 SELECT**（line 644-663）：5+ 次查询（facts status / intents status / events last / steps / stagnation）。可以聚合为一次查询（用 subquery 或 view）。
- ⚠️ **`logEvent` 直接 INSERT**（line 626-633）：不在 transaction 内时，事件可能丢失（如果调用方在事务中后续抛错）。所有公开 API 都包 transaction，OK；但如果调用方误用 logEvent 在事务外，可能不一致。
- ⚠️ **`fact.confidence ?? 1.0` 默认 1.0**（line 256）：与 contracts.ts 的 `validateCandidateFact` 默认 0.7 不一致——explorer 不输出 confidence 时，contracts 给 0.7，但若 caller 跳过 contracts 直接 addFact，会拿到 1.0。
- ⚠️ **WAL 模式下文件管理**：每个 session 一个 .db + .db-wal + .db-shm 文件。session 删除时（session-manager.ts `rmSync recursive`）会清理。但 WAL checkpoint 失败时可能留下 wal 文件。
- ⚠️ **没有 vacuum / 清理 API**：长跑任务下 events 表会无限增长。建议加 `pruneEvents(keepLastN)`。
- ⚠️ **JSON 字段（`evidence_json` / `payload_json` / `parent_fact_ids_json` 等）存为 TEXT**：查询时无法用 SQL 直接 filter，必须全表扫 + JSON.parse。对 events.payload 这种半结构化数据 OK，但对 fact.evidence 这种可能需要查询的不友好。
- ⚠️ **`config_json` 字段存整个 TaskConfig**（line 215）：每个 project 重复存储 task.json 内容——多 project 共享 config 时浪费空间。但设计上是 per-project config 隔离，OK。
- ✅ WAL + busy_timeout 处理并发读写的标准方案。
- ✅ Migration 幂等设计。
- ✅ 索引覆盖热查询路径。
- ✅ row mapper 函数集中化，便于维护。
- ✅ 与 InMemoryGraph 行为对齐。

---

## 8.4 `graph/federated-graph.ts` (144 lines) — **跨 Session 只读联邦**

**用途**：跨 session 查询 facts / intents / events，**只读**——所有写入必须回 owning session。

**核心 API**
- `searchFactsAcrossSessions(sessionIds, opts)` — 多 session SQL 查询 facts
- `searchIntentsAcrossSessions(sessionIds, query?, limit)` — 多 session 查询 intents
- `recentEventsAcrossSessions(sessionIds, limit)` — 多 session 取最新 events
- `allSessions()` — 委托给 SessionManager.listSessions()

**实现**：对每个 session 直接 `new DatabaseSync(info.dbPath)` 只读打开，执行 SQL，关闭。**不复用 SqliteGraph 实例**——绕过 Graph 接口直接 SQL。

**审计要点**
- ⚠️ **直接 `new DatabaseSync` 而非用 SessionManager.openReadOnly**（line 45, 85, 120）：意味着 SessionManager 的 openReadOnly 方法在联邦场景未使用——死代码？或者 FederatedGraph 应该用 SessionManager？设计上分离但功能重叠。
- ⚠️ **`searchFactsAcrossSessions` 的 SQL 拼接**（line 47-54）：用 `?` 参数化，安全。但 `opts.query` 用 LIKE `%query%`——SQL LIKE 注入（用户输入 `%` `_` 通配符）会影响结果。建议 escape。
- ⚠️ **每个 session 一次 db open/close**（line 45-75）：N 个 session → 2N 次 syscall。可优化为连接池或共享 handle。
- ⚠️ **`recentEventsAcrossSessions` 在客户端排序**（line 138）：`results.sort((a, b) => b.event.seq - a.event.seq).slice(0, limit)`——但每个 session 的 seq 是独立计数（AUTOINCREMENT 全局，但跨 session 仍可比）。如果两个 session 同时启动，seq 接近——排序 OK。但若 session A 比 session B 早创建很多，A 的 seq 永远远大于 B——排序结果倾向 A。
- ⚠️ **`Fact.source` 类型断言 `as Fact["source"]`**（line 63）：信任 DB 数据，无校验。如果 DB 被外部修改（custom SQL），可能返回非法 source。
- ⚠️ **没有错误处理**：单个 session 查询失败会传播到调用方，导致整体失败。建议 Promise.allSettled 模式或单 session try/catch。
- ⚠️ **`LIMIT ?` 应用在每个 session 内**（line 53-54）：N session × limit 总结果，不是全局 limit。如果 limit=10，N=5，返回 50 条。
- ✅ 只读语义清晰。
- ✅ 与 SessionManager 解耦（直接 SQL 而非走 Graph 接口）。

---

## 8.5 `graph/federation-bus.ts` (80 lines) — **跨 Session Insight 总线**

**用途**：进程内 EventEmitter，让一个 session 发布 `GlobalInsight`（高价值 fact / dead-end / hint 的摘要），其他 session 订阅并转化为本地 hint。**绝不传完整 fact body**——只传 summary + ref。

**核心 API**
- `publishInsight(source: GlobalInsightRef, summary, confidence)` — 发布
- `subscribeInsights(listener)` → 返回 unsubscribe
- `recentInsights(limit)` — 全部最近 insight
- `insightsForSession(sessionId, limit)` — 排除自己的 insight
- `clear()` — 清空

**关键限制**
- `MAX_GLOBAL_INSIGHTS = 500` — 环形缓冲，超过自动丢弃最老的
- `setMaxListeners(100)` — 防 Node.js EventEmitter 内存泄漏警告

**审计要点**
- ⚠️ **`publishInsight` 同步 emit**（line 58）：listener 同步执行，长 listener 会阻塞 publish。建议 `setImmediate` 异步。
- ⚠️ **没有持久化**：进程重启 insight 全丢——只对运行中的 supervisor 有意义。
- ⚠️ **`counter` 简单递增**（line 39, 46）：进程重启后从 0 开始，可能撞旧 ID（如果有持久化）——当前没持久化所以 OK。
- ⚠️ **`id: gi_${counter}`**：未包含时间戳或随机——理论上可预测。
- ⚠️ **`insightsForSession` 用 `filter` + `slice(-limit)`**（line 71-75）：性能 O(n)——500 条 OK，但若 MAX 改大需注意。
- ⚠️ **没有速率限制**：恶意/异常 session 可 spam insight，挤掉其他 session 的高价值 insight（环形丢弃）。
- ⚠️ **`GlobalInsight.summary` 字段无长度限制**：长 summary 浪费内存。
- ✅ EventEmitter 模式经典可靠。
- ✅ 环形缓冲 + MAX 限制防内存爆炸。
- ✅ "只传 summary + ref"原则防止跨 session 状态污染。

---

## 跨文件观察（Cross-file Observations）

1. **InMemoryGraph vs SqliteGraph 行为对齐度**：两个实现都遵循同一接口，但实现细节有差异（如 progress 查询效率）。测试用 InMemoryGraph 通过，生产用 SqliteGraph 可能因性能问题失败——边界 case。
2. **routeHash 冲突风险**：djb2 32-bit + 120 字符截断，理论上有冲突可能。dead-end false-positive 会让 planner 跳过合法 intent。
3. **FederatedGraph 绕过 Graph 接口直接 SQL**：与 SessionManager.openReadOnly 功能重叠——架构不优雅。
4. **events 表无清理机制**：长跑任务下 events 增长无上限。
5. **JSON 字段不能 SQL 查询**：evidence / payload / parent_fact_ids 等，影响未来 analytics 需求。
6. **Graph 接口没有 ReadOnlyGraph 子接口**：FederatedGraph 应该实现 ReadOnlyGraph，但当前只能直接 SQL。
7. **`config_json` 全量序列化 TaskConfig**：每个 project 重复存储，多 project 浪费。
8. **`SessionManager.openReadOnly` 与 SqliteGraph 不区分模式**：见 04-session.md 4.5 节。

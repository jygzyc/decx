# 10 — `src/server/` HTTP API & Dashboard

> Audit scope: 1 file in `decx-agent/src/server/`
> `http-server.ts`

`server/` 目录当前只有 1 个文件——`HttpServer`。它是一个**只读 + directives 写入**的 HTTP 适配器，外加嵌入式 dashboard HTML 服务。AGENTS.md 注释明确："The server is an adapter over Graph state and should not duplicate loopestration policy."

---

## 10.1 `server/http-server.ts` (190 lines) — **HTTP API 与 Dashboard 服务器**

**用途**：基于 `node:http` 的轻量 HTTP 服务器，暴露 5 个 JSON API 端点 + 1 个 dashboard HTML + 1 个 SSE 流。**不依赖任何 web 框架**（无 Express/Fastify），全部手写。

**核心 API**
- `class HttpServer`
  - `constructor(graph: Graph, sessionLoop?: SessionLoop)`
  - `start(options): Promise<void>` — 默认 host `127.0.0.1`, port `25429`
  - `stop(): Promise<void>`
  - `get port(): number` — 实际绑定端口（端口 0 时由 OS 分配）

**端点清单**

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` | 返回 dashboard HTML（`loadDashboard()`） |
| GET | `/api/projects` | 列出所有项目（含所有状态） |
| GET | `/api/projects/:id` | 取项目详情（project + facts + intents + hints + directives + links + progress） |
| POST | `/api/projects/:id/directives` | 写入 directive（body: `DirectiveInput`） |
| GET | `/api/projects/:id/stream` | SSE 流，实时推送 events |
| GET | `/api/projects/:id/events?since=<seq>` | 取 events（默认最近 500 条） |

**Dashboard 加载**（`loadDashboard()`）
- 候选路径：`<MODULE_DIR>/dashboard.html` 或 `<MODULE_DIR>/server/dashboard.html`
- 找不到抛 `dashboard.html not found in: ...`
- ⚠️ **dashboard.html 文件在仓库中不存在**（src/server/ 目录只有 http-server.ts）——意味着 `GET /` 调用必然抛错。需要构建流程从别处拷贝 dashboard.html 到 dist/。

**SSE 实现**（`handleSSE`）
- 初始：写入 `: connected\n\n` 注释行
- 重放：取最近 10 条 events 一次性发给客户端
- 轮询：`setInterval` 每 1s 查询 `graph.events(projectId, lastSeq, 100)`，增量推送
- 客户端断开：`close` / `error` 事件清理

**`handle(req, res)` 路由流程**
1. 解析 URL
2. 依次尝试匹配：`/` → `/api/projects` → `/api/projects/:id` → directives → stream → events
3. 全不匹配 → 404 `{ error: "not found", path }`
4. 任何异常 → 500 `{ error: err.message }`

**审计要点**
- 🚨 **`dashboard.html` 缺失**（line 19-28）：`loadDashboard()` 找不到文件直接抛错——`GET /` 必然 500。说明 dashboard HTML 还未实现，或在 build 流程中拷贝（需查 package.json scripts）。**功能性 bug**：dashboard 当前不可用。
- 🚨 **没有任何认证 / 鉴权**：HTTP 服务器默认监听 `127.0.0.1`，但 `POST /api/projects/:id/directives` 允许任意本地进程写入 directive——同机任何用户/进程都能操控 agent 行为（stop/pause/kill-intent/spawn-intent）。如果用户改 `--host 0.0.0.0` 暴露外网，**远程任意人可控制 agent**。审计建议：默认启用 token 鉴权或仅监听 unix socket。
- ⚠️ **`POST /directives` 不校验 body schema**（line 100-108）：`JSON.parse(body) as DirectiveInput` 直接断言——用户传 `{ kind: "INVALID", payload: "x" }` 会被存入 graph，consumeDirectives 时 switch 不命中静默丢弃。建议加 schema 校验。
- ⚠️ **`:id` 路径参数 `decodeURIComponent` 但不校验**（line 88, 103, 112, 118）：projectId 是 `proj_xxxx` 形式，理论上无特殊字符，但 decode 后含 `..` / `/` 也不会被拦——graph 层会用其做 SELECT WHERE，OK（参数化查询无注入），但若 graph 内部 join path 会出问题。
- ⚠️ **SSE 用 setInterval 1s 轮询**（line 155, 163）：不是真正的 push——每秒查 graph.events。多个客户端连接时，每客户端一个 timer，N 个客户端 N 次/秒查询。建议改为 graph 层的 emitter 模式（Graph.logEvent 时通知）。
- ⚠️ **SSE 重放最近 10 条 events**（line 148）：客户端连接晚时会丢失更多历史；连接早时 lastSeq 起点可能跳过中间事件（如果重放后 lastSeq=10，但实时查询用 `events(..., lastSeq=10, ...)`——OK）。
- ⚠️ **`sseClients` Map 维护但不读取**（line 37, 165-167）：注册了 client Set，但 graph 层没有"广播" API 用它。意味着 SSE 是 pull 模式（轮询），push 模式预留但未实现。
- ⚠️ **`stop()` 不关闭 SSE 连接**（line 61-69）：`server.close()` 等待所有连接结束——SSE 长连接会阻塞 stop。需要先 `clients.forEach(c => c.destroy())`。
- ⚠️ **`start()` 不处理 EADDRINUSE**（line 47-58）：端口被占用时 listen 回调不触发，Promise 永远 pending——agent 启动会 hang。建议监听 `server.on('error', reject)`。
- ⚠️ **`port: 25429` 硬编码默认**（line 49）：与 cli.ts 的 `--port "25429"` 一致，但与 DECX 主服务（25419/25420）不连续，文档应说明。
- ⚠️ **CORS 未设**：dashboard 与 API 同源时 OK，但若用户从别的 origin 调用 API 会被浏览器拦。当前未设 CORS 头。
- ⚠️ **没有 rate limiting**：本地 OK，外网暴露时易被 DDoS。
- ⚠️ **没有 `/health` 端点**：容器化部署不便。
- ⚠️ **`sessionLoop` 构造参数未使用**（line 42）：HttpServer 持有 sessionLoop 引用但代码中**完全没用到**——可能是预留未来 API（如 `POST /api/projects/:id/step` 触发 SessionLoop.step）。死字段。
- ⚠️ **`readBody` 无大小限制**（line 182-189）：大请求体撑爆内存。建议加 max body size。
- ⚠️ **`handle` 方法 `async` 但没用 await**（line 71）：除了 `readBody` 路径，其他都是同步——OK，但 `async` 关键字多余。
- ✅ 用 `node:http` 零依赖，启动快。
- ✅ JSON 输出统一 helper（`json(res, data, status)`）。
- ✅ 错误兜底 try/catch 转 500。
- ✅ SSE 实现基础正确（content-type / cache-control / connection headers）。

---

## 跨文件观察（Cross-file Observations）

1. **`server/` 目录的孤立性**：HttpServer 是 Graph 与外部的薄适配器，不依赖 SessionLoop（虽然签名接受），不写业务策略——符合分层原则。
2. **Dashboard HTML 缺失**：`GET /` 当前不可用，需补充 dashboard.html 或文档说明。
3. **无鉴权是默认配置的严重安全风险**：本地 127.0.0.1 + 同机多用户场景下，任何用户都能控制 agent。
4. **SSE 是轮询而非真 push**：未来可结合 graph 层的 EventEmitter 改为真正事件驱动。
5. **`sessionLoop` 参数死字段**：HttpServer 持有但不用，预留扩展或清理。
6. **与 `decx-cli` 的 HTTP server 完全独立**：decx-cli 的 server 是 JADX GUI 暴露的 API（25419），decx-agent 的 server 是 agent dashboard（25429）——两者不冲突但命名易混。

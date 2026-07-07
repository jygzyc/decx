# 06 — `src/worker/backends/` Agent CLI/HTTP Backends

> Audit scope: 7 files in `decx-agent/src/worker/backends/`
> `types.ts`, `registry.ts`, `subprocess.ts`, `process.ts`, `codex.ts`, `claude.ts`,
> `opencode-cli.ts`, `opencode-http.ts`

`backends/` 是 **AgentBackend 实现层**——把 prompt 翻译成具体 agent CLI（codex/claude/opencode）的子进程调用，或 opencode HTTP API 调用，或用户自定义命令。AGENTS.md："Backends should stay thin: prompt in, text/process result out."

---

## 6.1 `backends/types.ts` (30 lines) — **AgentBackend 契约**

**用途**：定义 backend 层接口，是 `worker/base.ts` 的下一层。

**核心类型**
```ts
interface AgentBackend {
  readonly id: string;
  invoke(input): Promise<BackendInvokeResult> | BackendInvokeResult;
  supportsConclude?: boolean;
}

interface BackendInvokeInput {
  prompt: string;
  config: WorkerConfig;
  cwd?: string;
  conclude?: boolean;       // ⚠️ 任何 backend 都未使用
  partialOutput?: string;   // ⚠️ 任何 backend 都未使用
}

interface BackendInvokeResult {
  text: string;
  returncode: number;
  stderr?: string;
  timedOut?: boolean;
}
```

**审计要点**
- ⚠️ **`BackendInvokeInput.conclude` 与 `AgentBackend.supportsConclude`** 是协议预留但**无实现**——查遍所有 backend，没有任何代码读取 `conclude` 或声明 `supportsConclude = true`。属于"死接口"。
- ⚠️ **`BackendInvokeInput.partialOutput`** 同样未使用——可能是为 streaming 预留，但当前 backend 都是 batch 模式。
- ⚠️ **`BackendInvokeResult.stderr` 是可选**（line 28），但 `worker/base.ts` 的 `WorkerResult.stderr` 是必填——转换处需保证 fallback 到 `""`。
- ✅ 字段集最小化（id + invoke），扩展点清晰。

---

## 6.2 `backends/registry.ts` (47 lines) — **Backend 注册表**

**用途**：模块级 singleton `Map<id, AgentBackend>`，启动时注册 5 个内置 backend，提供 `registerAgentBackend`（带 undo）、`getAgentBackend`、`listAgentBackendIds`。

**内置注册**
- `claude-code` (ClaudeBackend)
- `codex` (CodexBackend)
- `opencode` (OpencodeCliBackend)
- `opencode-http` (OpencodeHttpBackend)
- `process` (ProcessBackend)

**审计要点**
- ⚠️ **模块加载时立即 new 5 个 backend 实例**（line 18-26）：side effect at import time。如果某个 backend 构造抛错，整个模块加载失败——破坏性大。建议改为 lazy 或在 main 中显式初始化。
- ⚠️ **`registerAgentBackend` 的 undo 函数**（line 28-37）：用 `REGISTRY.get(id) === backend` 严格比较，防止"我注册后被别人覆盖又撤销"。逻辑正确，但用户可能不期望"覆盖后再注册再撤销"的语义。建议文档化。
- ⚠️ **没有 unregister 直接 API**：必须保存 undo 函数才能撤销，丢失 undo 就无法清理——内存泄漏风险。
- ⚠️ **`re-export ProcessBackend`**（line 47）：从本文件再导出一次（`agent-driver.ts` 也从这里 import），存在双重导出路径。
- ✅ 注册/查询 API 简洁。
- ✅ Undo 函数设计良好。

---

## 6.3 `backends/subprocess.ts` (96 lines) — **子进程执行基类**

**用途**：`SubprocessBackend` 抽象类，处理 `spawn` / stdin / stdout / stderr / 超时 / 大输出保护。各 CLI backend 只需实现 `buildArgv(config, prompt)`。

**核心常量**
- `SPAWN_ERROR_RETURNCODE = 127`（与 Unix "command not found" 一致）
- `DEFAULT_TIMEOUT_MS = 600_000`（10 分钟）
- `MAX_STDOUT_BYTES = 10 MB`

**`invoke(input)` 流程**
1. `built = buildArgv(config, prompt)` → `{ argv, env?, input? }`
2. `timeoutMs = config.timeoutMs ?? 600_000`
3. `spawn(argv[0], argv.slice(1), { cwd, stdio, env: { ...process.env, ...built.env, DECX_AGENT_ACTIVE: "1" } })`
4. 若 `built.input`：写入 stdin 后 end
5. 监听 stdout `data`：累加，超过 10MB 则 SIGTERM
6. 监听 stderr `data`：累加，超过 10MB 静默丢弃
7. setTimeout 超时 → SIGTERM + 标记 timedOut
8. `close` 事件 → 拼接 stdout/stderr，返回 `{ text, returncode, stderr, timedOut? }`

**审计要点**
- ⚠️ **`DECX_AGENT_ACTIVE: "1"` 注入到子进程 env**（line 30）：所有子进程都看到此变量。可用于 backend 自检"我是被 decx-agent 调起来的"，但需文档化用途。
- ⚠️ **`child.kill("SIGTERM")` 后未等子进程实际退出**（line 55, 69）：直接继续，依赖 `close` 事件回调返回结果。SIGTERM 后子进程可能不退出（拦截信号），需要 SIGKILL 升级。建议加 SIGKILL 升级 timer。
- ⚠️ **stdout 超 10MB 后 SIGTERM**（line 54-57）：returncode 仍是 `code`（来自 close 事件），不是专用错误码。调用方难以区分"超限"与"正常完成"。
- ⚠️ **stderr 超 10MB 静默丢弃**（line 62-64）：用户可能丢失关键错误信息。建议至少 log 一条警告到父进程 stderr。
- ⚠️ **`finish` 函数的 `settled` 检查**（line 40-45）：防重复 resolve，但 `child.removeAllListeners()` 在 try/catch 中——如果 child 已经 gc，可能无效。当前 OK。
- ⚠️ **`code ?? SPAWN_ERROR_RETURNCODE`**（line 90）：如果 close 时 code 是 null（信号终止），returncode 设为 127——但实际可能是超时（应返回 timeout 错误）。逻辑顺序：先检查 timedOut（line 79-86），所以 timeout 路径有专门 returncode=127 + stderr 提示，OK。
- ⚠️ **没有 stdin 大小限制**：`built.input` 直接 write，如果 prompt 极大（如完整 graph 渲染 + enrichedContext），可能撑爆 pipe buffer。建议加长度检查。
- ✅ 10 分钟默认超时合理（LLM agent 调用可能慢）。
- ✅ 10MB stdout 上限防 OOM。
- ✅ `finish` 单次 settle 保证。

---

## 6.4 `backends/process.ts` (20 lines) — **通用命令后端**

**用途**：`ProcessBackend` 是 escape hatch——用户在 task.json 配 `command: "my-cli"` + `args: [...]` 时使用。prompt 通过 stdin 传入。

**`buildArgv` 实现**
```ts
{
  argv: [config.command ?? "echo", ...(config.args ?? [])],
  input: prompt,   // stdin
}
```

**审计要点**
- ⚠️ **默认 `command = "echo"`**（line 16）：如果用户漏配 command，prompt 会被 echo 出来——returncode=0 但 stdout 就是 prompt 本身，下游 `parseEnvelope` 会失败抛"no JSON object"。错误消息不直观。建议缺失 command 时直接抛错。
- ⚠️ **`args` 数组直接展开**（line 17）：未做 shell 注入防护。但 subprocess.ts 用 `spawn(argv[0], argv.slice(1), { shell: false })`（默认）——不走 shell，无注入风险。OK。
- ⚠️ **prompt 通过 stdin**（line 18 `input: prompt`）：与 codex/claude/opencode-cli 不同（它们把 prompt 作为 argv 末尾参数）。如果用户自定义 CLI 不读 stdin，会 hang。
- ⚠️ **prompt 不在 argv 中**：意味着 `ps aux` 看不到 prompt 内容——隐私友好，但调试不友好。
- ✅ 文件极简，作为 escape hatch 合理。
- ✅ 默认走 SubprocessBase 的 stdin pipe 路径。

---

## 6.5 `backends/codex.ts` (51 lines) — **Codex CLI Backend**

**用途**：调用 `codex exec` 子命令。

**`buildArgv` 输出**
```
codex exec --dangerously-bypass-approvals-and-sandbox
  [--model <model>]               # 来自 config.model 或 CODEX_MODEL
  [-c model_provider="decx" -c model_providers.decx.name="decx" -c ...]
  -- <prompt>
```

**provider 配置**（当 `config.baseUrl` 或 `CODEX_BASE_URL` 设定时）
- `model_provider="decx"`
- `model_providers.decx.name="decx"`
- `model_providers.decx.wire_api="responses"`
- `model_reasoning_effort="high"`
- `model_providers.decx.base_url="<baseUrl>"`
- `model_providers.decx.env_key="OPENAI_API_KEY"`

**env 注入**：`OPENAI_API_KEY` 来自 `process.env[config.apiKeyEnv ?? "OPENAI_API_KEY"]`。

**审计要点**
- 🚨 **`--dangerously-bypass-approvals-and-sandbox`**（line 19）：完全跳过 Codex 的审批与沙箱——**严重安全风险**。Codex 在此模式下可执行任意 shell 命令、读写任意文件。AGENTS.md 的 worker 设计假设 prompt 来自受信源（task.json），但用户 prompt 仍可能从 graph 状态衍生（attacker-controlled description 进入 prompt 时）。审计建议：**生产环境必须用更受限的 flag**，或至少在文档中明确警告。
- ⚠️ **`model_reasoning_effort="high"` 硬编码**（line 41）：用户无法配置 reasoning effort。建议加 config 字段。
- ⚠️ **`env_key="OPENAI_API_KEY"` 硬编码**（line 43）：与 `envFor` 函数把任意 apiKeyEnv 的值写到 `OPENAI_API_KEY` 配合——意味着即使用户配 `apiKeyEnv: "MY_KEY"`，最终也走 `OPENAI_API_KEY`。这对非 OpenAI 兼容 provider 不工作。建议用 `model_providers.decx.env_key="<config.apiKeyEnv>"`。
- ⚠️ **prompt 作为 argv 参数**（line 22 `--`, prompt）：长 prompt 会撞 ARG_MAX（macOS ~256KB，Linux ~2MB）。建议改为 stdin。
- ⚠️ **`-c` 配置参数的引号处理**（line 38-43）：用单引号包裹双引号，shell 不参与（spawn shell=false），但 codex 内部解析时可能仍按 shell 规则——需测试带特殊字符的 baseUrl。
- ✅ 模型/baseURL/apiKey 都支持 env fallback，配置灵活。
- ✅ baseUrl 不设时不加 provider 配置（保持 codex 默认行为）。

---

## 6.6 `backends/claude.ts` (31 lines) — **Claude Code CLI Backend**

**用途**：调用 `claude` (Claude Code CLI) 子进程。

**`buildArgv` 输出**
```
claude --dangerously-skip-permissions -p -- <prompt>
```

**env 注入**
- `ANTHROPIC_MODEL` ← config.model
- `ANTHROPIC_BASE_URL` ← config.baseUrl
- `ANTHROPIC_AUTH_TOKEN` ← process.env[config.apiKeyEnv ?? "ANTHROPIC_API_KEY"]

**审计要点**
- 🚨 **`--dangerously-skip-permissions`**（line 17）：与 codex 的 bypass 同样危险——Claude Code 在此模式下可执行任意命令、读写任意文件。**同样的安全警告适用**。
- ⚠️ **`-p` flag**（line 17）：claude 的 print/headless 模式标志。但 claude CLI 的 flag 体系在版本间变动，需文档化兼容版本。
- ⚠️ **prompt 作为 argv**（line 17）：同样 ARG_MAX 限制。
- ⚠️ **没有支持 `claude --resume <sessionId>`**：与 OpencodeHttpBackend 一样，每次调用新建会话——`profile.sessionReuse` 对 claude-code worker 无效。
- ⚠️ **`ANTHROPIC_AUTH_TOKEN` vs `ANTHROPIC_API_KEY`**：claude CLI 实际认哪个？文档需明确。当前代码统一写 AUTH_TOKEN。
- ⚠️ **`baseUrl` 不验证**：用户配错 baseUrl（如指向非 anthropic 兼容服务），claude 会失败但错误消息可能不直观。
- ✅ 文件极简。
- ✅ env 注入条件性（无 key 时不设）。

---

## 6.7 `backends/opencode-cli.ts` (33 lines) — **OpenCode CLI Backend**

**用途**：调用 `opencode run` 子进程。

**`buildArgv` 输出**
```
opencode run [--model <model>] --print [config.args...] <prompt>
```

**env 注入**
- `OPENCODE_BASE_URL` ← config.baseUrl
- `OPENCODE_API_KEY` ← process.env[config.apiKeyEnv ?? "OPENCODE_API_KEY"]

**审计要点**
- ⚠️ **`config.args` 直接 push 到 argv**（line 19）：用户可在 task.json 注入任意 opencode flag——强大但需文档化安全考虑。
- ⚠️ **`--print` 模式**：opencode 的非交互输出模式，但版本兼容性需确认。
- ⚠️ **没有支持 `opencode --resume <sessionId>`**：与 claude 一样，sessionReuse 无效。
- ⚠️ **prompt 作为 argv**（line 20）：ARG_MAX 限制。
- ⚠️ **`OPENCODE_BASE_URL`** 是 opencode 的 server URL 还是 LLM provider URL？文档需明确（opencode 有两层 URL）。
- ✅ 支持 config.args 透传，灵活。
- ✅ 文件极简。

---

## 6.8 `backends/opencode-http.ts` (94 lines) — **OpenCode HTTP Backend**

**用途**：通过 HTTP API 调用 opencode server（`opencode serve` 启动的 daemon）。每次 invoke 创建新 session（无跨调用复用）。

**流程**
1. `POST {baseUrl}/session` with `{ title: "decx-agent-<ts>" }` → 拿 `sessionId`
2. `POST {baseUrl}/session/{sessionId}/message` with `{ parts: [{ type: "text", text: prompt }] }`
3. `extractAssistantText(result)` → 从 `result.parts[]` 提取 type=text 或 content 字符串

**配置**
- `baseUrl`（默认 `http://127.0.0.1:4096`）
- `password`（来自 config.password 或 `OPENCODE_SERVER_PASSWORD`，HTTP Basic auth）
- 超时：session 创建 10s，message 调用 `maxTokens * 1000` ms 或默认 300_000

**审计要点**
- ⚠️ **"每次调用新建 session"**（line 21-23 注释明确）：与 `profile.sessionReuse` 设计冲突——即使 profile 启用 sessionReuse，opencode-http backend 不复用 session。注释解释为"Cairn model，每轮完整 prompt"——但前面 worker/session-manager.ts 又明确支持 sessionReuse，**协议不一致**。
- ⚠️ **`maxTokens * 1000` ms 超时**（line 63）：用 token 数当秒数——粗略估算。如果 maxTokens=100，超时只有 100s，对长 LLM 调用不够。如果 maxTokens=100000，超时 27 小时。建议用专用 timeoutMs 配置。
- ⚠️ **`sessionResp.ok` 检查但未 catch 网络异常**（line 47-49）：`fetch` 抛错（DNS 失败、连接拒绝）会被外层 try/catch（line 52-54）兜住，错误消息友好。OK。
- ⚠️ **未释放 session**：每次创建新 session，但完成后不调用 opencode 的 session close/delete API——server 端 session 累积成垃圾。
- ⚠️ **`extractAssistantText` 只看 parts[]**（line 79-90）：如果 opencode 改 API 返回 nested content，会丢失文本。
- ⚠️ **`result.info?.role` 解构但未使用**（line 70）：定义了但代码里没看 role 字段，只看 parts。死字段。
- ⚠️ **认证用 HTTP Basic**（line 35-37）：明文 password base64——非加密 HTTP 下不安全。建议至少推荐 HTTPS。
- ⚠️ **没有重试**：网络抖动一次就失败。
- ✅ 错误消息友好（"Is 'opencode serve' running?"）。
- ✅ AbortSignal.timeout 使用现代 API。

---

## 跨文件观察（Cross-file Observations）

1. **`--dangerously-bypass-approvals-and-sandbox` / `--dangerously-skip-permissions` 是严重安全风险**：codex 和 claude backend 都默认禁用 sandbox/审批。这意味着 LLM 输出可以触发任意系统调用——结合 graph 中存的 attacker-controlled 描述进入 prompt，构成 prompt injection → RCE 链。**生产部署必须配合 OS 级隔离（容器/沙箱）**。
2. **sessionReuse 协议不一致**：
   - `worker/session-manager.ts` 假设 backend 复用 session
   - `opencode-http.ts` 明确不复用（每次新建）
   - `claude.ts` / `opencode-cli.ts` / `codex.ts` 都不支持 `--resume`
   - 实际只有理论上的 backend 才能复用 session，但代码库里**没有这样的 backend**
3. **`BackendInvokeInput.conclude` / `partialOutput` / `supportsConclude` 全是死接口**——预留但未实现。
4. **prompt 作为 argv 参数**（codex/claude/opencode-cli）：受 ARG_MAX 限制，长 prompt（graph view + enriched context）可能撞限。`process.ts` 用 stdin 不受限。
5. **5 个 backend 都在模块加载时实例化**（registry.ts）——side effect at import，潜在初始化失败风险。
6. **错误消息好**：opencode-http 的 "Is 'opencode serve' running?" 是良好实践。
7. **backend 都极薄**（20-100 行），符合"thin adapter"原则。

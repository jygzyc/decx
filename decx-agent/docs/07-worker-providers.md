# 07 — `src/worker/providers/` Model Provider Layer

> Audit scope: 3 files in `decx-agent/src/worker/providers/`
> `types.ts`, `registry.ts`, `configured.ts`

`providers/` 是 **直接 LLM API 调用层**——与 `backends/`（agent CLI 子进程）平行。`backends/` 走 codex/claude/opencode CLI，`providers/` 直接调 OpenAI/Anthropic SDK。两层都通过 `worker/registry.ts` 的 `kind` 字段切换：`kind: "agent"` 走 backend，`kind: "api"` 走 provider。

---

## 7.1 `providers/types.ts` (28 lines) — **ModelProvider 契约**

**用途**：定义 provider 层接口——`complete(input, config) → { text, session? }`。

**核心类型**
```ts
interface ModelCallInput {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

interface ModelCallResult {
  text: string;
  session?: string;   // ⚠️ ConfiguredProvider 从未填充
}

interface ModelProvider {
  readonly id: string;
  complete(input, config): Promise<ModelCallResult>;
}
```

**审计要点**
- ⚠️ **`ModelCallResult.session` 字段未被任何实现填充**（见 configured.ts）：预留会话返回，但当前 providers 都是无状态单次调用——`sessionReuse` 在 provider 层完全无效。死字段。
- ⚠️ **`ModelCallInput.system`**：System prompt 字段，但 `ApiDriver.execute`（`api-driver.ts`）构造 ModelCallInput 时**不传 system**——意味着 system prompt 不会从 WorkerConfig 进入 provider，浪费了字段。
- ⚠️ **接口只暴露 complete，无 stream / embed / tool-call**：当前用例足够，但未来扩展受限。
- ✅ 接口最小化，`config: WorkerConfig` 透传让 provider 自己取所需字段。

---

## 7.2 `providers/registry.ts` (34 lines) — **Provider 注册表**

**用途**：模块级 singleton `Map<id, ModelProvider>`，启动时从 `providers.json` + 预设构建。提供 `registerProvider`（带 undo）、`getProvider`、`listProviderIds`、`reloadProviders`。

**关键内容**
- `let REGISTRY: Map<string, ModelProvider> = buildProvidersFromConfig(undefined)` — **模块加载时立即构建**
- `registerProvider(provider)` → 返回 undo 函数（与 backends/registry 设计一致）
- `reloadProviders(explicit?)` → 重建 REGISTRY（测试或热重载用）

**审计要点**
- ⚠️ **`let REGISTRY` 而非 `const`**（line 13）：因为 `reloadProviders` 要整体替换。但 `registerProvider` 持有的 undo 函数仍指向**旧** REGISTRY（闭包捕获）——reload 后调用旧 undo 会修改旧 map，对当前 REGISTRY 无效。**潜在 bug**：reload 后旧 undo 函数失效但不报错。
- ⚠️ **模块加载时调用 `buildProvidersFromConfig(undefined)`**（line 13）：会立即读盘 `~/.decx/agent/providers.json`——如果该文件损坏或权限错误，整个 registry 模块加载失败，影响所有依赖（包括 mock 测试）。建议改为 lazy 或 try/catch。
- ⚠️ **`reloadProviders` 的类型断言**（line 31）：`explicit as Record<string, never> | undefined`——`never` 用得不正确，应该是 `Record<string, UserProviderConfig>`。当前类型断言绕过了类型检查，调用方传错类型不报错。
- ⚠️ **没有 unregister API**：只能通过 undo 函数删除，丢失 undo 后无法清理。
- ✅ 与 backends/registry.ts 设计一致，对称美。
- ✅ `reloadProviders` 支持热重载。

---

## 7.3 `providers/configured.ts` (96 lines) — **配置驱动的 Provider 工厂**

**用途**：用 `@ai-sdk/openai` + `@ai-sdk/anthropic` + Vercel `ai` 库的 `generateText`，从 `providers.json` 配置构建 `ConfiguredProvider` 实例。**取代**了原 OpenAIProvider / AnthropicProvider / DeepSeekProvider 等静态类。

**`ConfiguredProvider.complete(input, config)` 流程**
```
1. resolveApiKey(userConfig, workerConfig)
   - keyEnv = workerConfig.apiKeyEnv ?? userConfig.apiKeyEnv
   - key = process.env[keyEnv]
   - 缺失抛 "${keyEnv} is required for provider ${name}"
2. model = config.model ?? userConfig.model
3. baseURL = config.baseUrl ?? userConfig.baseURL
4. kind = userConfig.kind ?? "openai"
5. if kind === "anthropic":
   - createAnthropic({ apiKey, baseURL })
   - generateText({ model: anthropic(model), prompt, system, temperature, maxOutputTokens: input.maxTokens ?? config.maxTokens ?? 4096 })
   - 如果有 system：附加 ephemeral cache control
6. else (openai / openai-compatible):
   - createOpenAI({ apiKey, baseURL, headers: userConfig.headers })
   - generateText({ model: openai(model), prompt, system, temperature, maxOutputTokens: input.maxTokens ?? config.maxTokens })
7. return { text }
```

**`buildProvidersFromConfig(explicit?)` 流程**
1. file = explicit ?? loadProvidersFile()
2. 第一轮：遍历 `PROVIDER_PRESETS`，每个 preset 在 file 中找到匹配则构建 ConfiguredProvider
3. 第二轮：遍历 file 中自定义 id，preset 未覆盖的构建 ConfiguredProvider
4. 返回 Map

**审计要点**
- ⚠️ **Anthropic 路径默认 `maxOutputTokens: 4096`**（line 42），OpenAI 路径不设默认（line 54，依赖 SDK 默认）——**不一致**。Anthropic 模型如果未设 maxTokens 会用 4096，OpenAI 会用 SDK 默认（通常 4096 或 model 最大）。建议统一。
- ⚠️ **Anthropic 的 `cacheControl: { type: "ephemeral" }` 只在有 system 时启用**（line 43）：设计意图是缓存 system prompt，但 cacheControl 应附加在 system message 上，而非整个 metadata。Vercel ai-sdk 的具体语义需确认。
- ⚠️ **OpenAI 路径不传 `headers`**（line 48）：`createOpenAI({ apiKey, baseURL, headers })`——但 headers 来自 `userConfig.headers`，没经过 workerConfig。如果用户想 task-level 覆盖 headers，无法做到。
- ⚠️ **`resolveApiKey` 错误消息含 userConfig.name**（line 63）：`?? "?"` fallback 太弱。如果 userConfig 没设 name，错误消息变成 `"OPENAI_API_KEY is required for provider ?"`——不友好。
- ⚠️ **`process.env[keyEnv]` 直接读**（line 62）：不做 trim，如果环境变量值前后有空格会算"已设"。一般 OK，但严格场景需注意。
- ⚠️ **`generateText` 异常未包装**：SDK 抛错会直接传播给 ApiDriver，由其 catch 转 WorkerResult。错误消息可能含 SDK 内部细节，对用户不直观。
- ⚠️ **`ConfiguredProvider.complete` 不返回 `session`**：与 `ModelCallResult.session` 字段定义不符（详见 7.1）。
- ⚠️ **`maxTokens ?? config.maxTokens ?? 4096` 三级 fallback**（line 42）：层级深，调试时不易判断实际生效值。
- ⚠️ **依赖外部包 `@ai-sdk/openai` / `@ai-sdk/anthropic` / `ai`**：这些是 Vercel AI SDK，版本变化频繁。需在 package.json 锁版本。
- ✅ Provider 工厂模式让"加新 provider = 改 providers.json + 加 preset"，无需源码改动。
- ✅ 通过 `kind` 区分 anthropic vs openai 协议，覆盖大部分主流 LLM。
- ✅ `buildProvidersFromConfig` 的两轮遍历保证 preset 优先 + 自定义补充。

---

## 跨文件观察（Cross-file Observations）

1. **三层抽象的"上下文丢失"问题**：
   - `worker-runtime.WorkerRequest` 有 `maxOutputTokens`、`sessionId`
   - `base.WorkerRequest` 有 `role`、`intentId`、`sessionDir`
   - `providers.ModelCallInput` 有 `system`、`temperature`
   - 这三层互不透传——例如 worker-runtime 的 sessionId 永远到不了 provider，base 的 role 永远到不了 backend。审计时若需要传新字段，必须**逐层穿透**修改。
2. **`sessionReuse` 在 provider 层完全无效**：types.ts 的 `session?` 字段无人填充；configured.ts 不返回 session id。
3. **`reloadProviders` 与 `registerProvider` 的 undo 函数交互有 bug**：reload 后旧 undo 失效但不报错。
4. **模块加载时 side effect**：providers/registry.ts 与 backends/registry.ts 都在 import 时执行 I/O（读 providers.json / 实例化 backend），失败会导致整个进程无法启动。
5. **AI SDK 依赖**：`@ai-sdk/openai` / `@ai-sdk/anthropic` / `ai` 必须在 package.json 锁定版本，否则 upstream breaking change 直接破坏 provider 层。
6. **`ConfiguredProvider` 是唯一的具体实现**——类型层预留了多 provider 实现，但实际只有这一个。设计灵活但当前用例单一。

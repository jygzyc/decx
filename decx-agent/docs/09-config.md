# 09 — `src/config/` Configuration Layer

> Audit scope: 7 files in `decx-agent/src/config/`
> `default-config.ts`, `task-config.ts`, `profile-loader.ts`, `prompt-loader.ts`,
> `providers-config.ts`, `provider-presets.ts`, `utils.ts`

`config/` 是 **配置加载与归一化层**——从 `task.json` / `providers.json` 读入，合并默认值，产出强类型 `TaskConfig`。AGENTS.md："Source implements mechanism only — no hardcoded role semantics. Roles, prompts, models, workers, permissions, and context policies come from configuration."

---

## 9.1 `config/default-config.ts` (51 lines) — **默认 TaskConfig 工厂**

**用途**：`defaultConfig()` 返回最小可运行的 `TaskConfig`。所有 task.json 字段缺省时都从这里取。

**默认内容**
- **task**: `{ target: "", goal: "" }`（必须由 task.json 覆盖）
- **profiles**：4 个 builtin
  - `planner` → prompt: `agent/prompts/planner.md`, view: `full`, contract: `main_decision`
  - `explorer` → prompt: `agent/prompts/explorer.md`, view: `focused`, contract: `candidate_fact`
  - `evaluator` → prompt: `agent/prompts/evaluator.md`, view: `evidence-only`, contract: `verdict`
  - `metacog` → prompt: `agent/prompts/metacog.md`, view: `summary`, contract: `hints`
  - 全部 runtime.worker = `"opencode"`
- **workers**: `{ opencode: { kind: "agent", backend: "opencode" } }`
- **workflow.limits**: `{ maxSteps: 1000, maxConcurrent: 3, refillPerTick: 1, maxStagnation: 8 }`
  - ⚠️ **未设 `workerLeaseMs` / `plannerCooldownSteps`**——用 DEFAULT_LIMITS 的 300_000 / undefined
- **workflow.metacog.triggers**: `{ everySteps: 5, everySeconds: 30, stagnationLevel: 3 }`
  - ⚠️ **`everySeconds: 30` 与 `DEFAULT_METACOG_TRIGGERS.everySeconds: 60` 不一致**——两处默认值！
- **control**: `{ mainProfile: "planner", metacogProfile: "metacog", metacogIntervalSeconds: 30 }`

**审计要点**
- ⚠️ **默认 worker 是 `opencode`**（line 39）：意味着用户不配 workers 时，所有 profile 都用 opencode CLI backend——必须本机装 opencode。文档应明确。
- ⚠️ **`metacog.triggers.everySeconds` 与 `agent/types.ts` 的 `DEFAULT_METACOG_TRIGGERS` 不一致**（30 vs 60）：两套默认值，谁优先？`metacog-supervisor.ts` line 35-36 优先取 `config.workflow.metacog?.triggers?.everySeconds`（30），fallback 到 `DEFAULT_METACOG_INTERVAL_MS`（30_000）——实际上 defaultConfig 与 MetacogSupervisor 默认值都是 30s，`DEFAULT_METACOG_TRIGGERS.everySeconds=60` 是死值。
- ⚠️ **prompt 路径 `agent/prompts/planner.md` 是相对路径**：实际解析时基于 task.json 所在目录（`PromptLoader` 的 baseDir）。如果用户把 task.json 放在 `.decx/agent_tasks/<session>/` 下，prompt 文件应在 `.decx/agent_tasks/<session>/agent/prompts/planner.md`——但仓库里**没有这些 prompt 文件**。意味着 defaultConfig 直接运行会失败（prompt 文件缺失）。`init` 命令只是创建 task.json，不创建 prompts。
- ⚠️ **`maxSteps: 1000` 与 `SessionLoop.run` 默认 `maxSteps: 100` 不一致**：两个来源（DEFAULT_LIMITS=1000 / run=100），用户难判断。
- ⚠️ **BUILTIN_PERMISSIONS 的引用**（line 24）：`BUILTIN_PERMISSIONS[role]` 用 role 取，但 `normalizeProfile` 是 profileId——如果 role 与 profileId 不一致（如自定义 role），permissions 取不到。defaultConfig 用 `BUILTIN_ROLES.planner` 等保证两者一致，OK。
- ✅ 默认值合理（4 个 builtin profile + 1 个 worker + 标准限制）。
- ✅ 通过 `builtinProfile(...)` helper 减少重复。

---

## 9.2 `config/task-config.ts` (189 lines) — **task.json 加载器**

**用途**：`loadConfig(configPath, sessionOverride?)` 读 task.json，深合并 defaultConfig，校验必填字段，归一化 profiles，返回 `LoadedConfig`。

**核心 API**
- `loadConfig(configPath, sessionOverride?)` → `{ config, session, sessionDir, configPath }`

**`loadConfig` 流程**
1. resolve + existsSync 校验文件存在
2. JSON.parse 失败 → 抛 "task config is not valid JSON"
3. **检测已废弃字段 `agents`** → 抛 "use profiles instead"
4. `mergeConfig(defaultConfig(), parsed)` 深合并
5. 校验 `task.target` / `task.goal` 必填
6. session = `sessionOverride ?? config.task.session ?? deriveSessionName(absPath)`
7. sessionDir = `dirname(absPath)`

**合并策略**（`mergeConfig`）
- **profiles**：union of `{ planner, explorer, evaluator, metacog }` 与 `parsed.profiles` keys，每个都过 `normalizeProfile`
- **task**：parsed 覆盖 base，字段级
- **workers**：`mergeWorkers` 按 worker name 覆盖
- **workflow**：`mergeWorkflow` 按 limits/metacog/stopGate 分组覆盖
- **control**：`mergeControl` 字段级覆盖

**`deriveSessionName`**：取路径倒数第二级目录名，sanitize 非字母数字为 `-`。

**审计要点**
- ⚠️ **检测废弃 `agents` 字段**（line 37-39）：友好迁移提示，但只检测一个字段——其他可能的废弃字段（如 `stages`、`phase`）未检测。
- ⚠️ **`profilesRaw ?? base.profiles[id]` 的 fallback**（line 68）：如果用户在 task.json 完全删除某个 builtin profile（如不想要 metacog），合并逻辑仍会从 base 取——**无法禁用 builtin profile**。用户只能通过 control.metacogProfile 改名间接禁用，体验差。
- ⚠️ **`mergeWorkflow` 不处理 `plannerCooldownSteps`**（line 131-137）：DEFAULT_LIMITS 有这个字段，但 mergeWorkflow 没读 override——用户无法通过 task.json 配置 planner 冷却。**功能缺失**。
- ⚠️ **`mergeWorkflow` 不处理 `workerLeaseMs` 时…实际上有处理**（line 136）——OK，看错了。但 `plannerCooldownSteps` 确实缺失。
- ⚠️ **`stringValue` 的 dot-path 支持**（line 165-173）：`stringValue(override, "task.target")` 用 `.` 分割取 nested——但 `mergeWorkers` 内的 `stringValue(w, "kind")` 是单字段，**两套语义混用同一函数**——前面 dot-path，后面 plain key。如果用户在 worker config 配 `"kind": "a.b"` 不会被解析为 path（line 103 直接 `stringValue(w, "kind")`），OK，但易混淆。
- ⚠️ **`mergeWorkers` 把 `kind` 默认为 `"agent"`**（line 103）：如果用户漏配 kind，静默变 agent worker——可能与意图不符。建议必填。
- ⚠️ **`deriveSessionName` 取路径倒数第二级**（line 187）：意味着推荐的目录结构是 `<session>/task.json`，session 名取目录名。如果用户把 task.json 直接放在 `.`，session 名会变成当前目录的父目录名——不直观。
- ⚠️ **不校验 profile 数量下限**：理论上可以 profiles = {}（mergeConfig 会从 base 填），但如果未来 base 改了，行为会变。
- ⚠️ **没有 schema 校验**：用 `as` 断言绕过类型检查（line 103, 105），未知字段静默丢弃。
- ✅ 废弃字段检测友好。
- ✅ profileLoader 集中归一化。
- ✅ sessionDir 自动派生，符合 .decx/agent_tasks 约定。

---

## 9.3 `config/profile-loader.ts` (116 lines) — **SubagentProfile 归一化**

**用途**：`normalizeProfile(profileId, raw)` 把 task.json 里的 raw profile 对象（可能字段不全）转成强类型 `SubagentProfile`。**严格 profiles-only**，无 legacy field mapping。

**归一化流程**
1. `role = str(raw.role) ?? profileId`
2. `runtime`：必填 `worker`，可选 `workers/model/provider`
3. `prompt`：必填 `prompt.file`，可选 `rules/knowledge/instructions`
4. `context`：默认 `graphView = "full"`，可选 maxFacts/includeDeadEnds/includeProgress/rotateOnContextFull/relevanceScope
5. `permissions`：**不读 raw.permissions**，而是 `BUILTIN_PERMISSIONS[role] ?? BUILTIN_PERMISSIONS[profileId] ?? []`
6. `output`：默认 `contract = "candidate_fact"`
7. 可选 `maxActive` / `intervalSeconds`

**审计要点**
- 🚨 **`normalizePermissions` 完全忽略 `raw.permissions`**（line 95-97）：用户在 task.json 配的 `permissions: [...]` 被静默丢弃！只能用 BUILTIN_PERMISSIONS——**自定义权限集需要新 role 名才能命中**。这是严重设计限制，与 AGENTS.md 的"custom profiles declare their own permissions"承诺**不符**。**审计重点**：建议改为 `raw.permissions ?? BUILTIN_PERMISSIONS[role] ?? []`。
- ⚠️ **`normalizeOutput` 默认 `candidate_fact`**（line 102）：意味着不显式配 contract 时，所有 profile 都按 candidate_fact 验证输出——planner 输出 main_decision 会失败 contract 校验。但 defaultConfig 显式配了所有 4 个 builtin，所以 OK；自定义 profile 不配 contract 会出问题。
- ⚠️ **`normalizeContext` 的 graphView 默认 `full`**（line 83）：如果用户配 context 但漏了 graphView，得到 full——可能 token 爆炸。建议按 profile 角色默认（explorer→focused, evaluator→evidence-only）。
- ⚠️ **`runtime` 可以从 `raw.runtime` 或 `raw` 直接取 worker**（line 44-45）：兼容两种写法（`{ runtime: { worker } }` vs `{ worker }`），但 docstring 说"Strict profiles-only normalization. No legacy field mapping"——**注释与实现不一致**。
- ⚠️ **`maxActive` / `intervalSeconds` 直接 num 转换**（line 34-35）：无范围校验，用户配 `maxActive: -1` 会接受。
- ⚠️ **不校验 `prompt.file` 是否存在**：归一化期不读盘，留给 PromptLoader。但意味着 task.json 写错路径，运行时才报错。
- ✅ 类型守卫函数（`str` / `num` / `strArr`）简洁。
- ✅ 必填字段缺失立即抛错。

---

## 9.4 `config/prompt-loader.ts` (74 lines) — **Prompt 文件加载器**

**用途**：从 `PromptSpec`（file + rules + knowledge + instructions）组装静态 role preamble。动态 graph context 由 ContextBuilder 另外加。

**`load(spec)` 流程**
1. 读 `spec.file`，失败返回 `{ preamble: "", fromConfig: false }`
2. 读 `spec.rules[]`：每个尝试当路径读，失败当文本
3. 读 `spec.knowledge[]`：同上
4. 追加 `spec.instructions`（如果存在）
5. 全部用 `\n\n---\n` 风格拼接

**`tryReadFile(pathOrText)`**
- `looksLikePath(s)` 判断：含 `/` `\` 或末尾有 `.[a-z0-9]+` 或以 `.` / `~/` 开头
- 是路径则 `resolve(baseDir, path)` + existsSync + readFileSync
- 否则返回 undefined（让 caller 当文本用）

**审计要点**
- ⚠️ **`looksLikePath` 启发式不准**（line 72-74）：纯文件名如 `planner.md` 匹配（末尾 `.md`），但 `planner` 不匹配（无扩展名）——后者被当文本，永远读不到盘。建议总是先尝试当路径，失败再当文本。
- ⚠️ **`fromConfig: false` 不抛错**（line 31）：用户配的 prompt.file 不存在时静默返回空 preamble——SubagentRunner 在 `runSubagentWithText` line 97-102 显式检查 `resolved.fromConfig`，抛 "prompt file not loaded"。OK，但错误消息没说哪个文件没找到。
- ⚠️ **rules / knowledge 文件不存在时 fallback 当文本**（line 37, 44）：可能用户写错路径，结果整段路径字符串被当 prompt——LLM 收到 `"path/to/rule.md"` 字面文本，行为诡异。
- ⚠️ **没有缓存**：每次 `load(spec)` 都重新读盘——长跑任务下，profile 多次执行都重复 I/O。建议按 `(spec.file, mtime)` 缓存。
- ⚠️ **没有大小限制**：大 prompt 文件直接读入内存。
- ⚠️ **`baseDir` 默认 `process.cwd()`**（line 68）：但 SessionLoop 里 `new PromptLoader()`（无 baseDir）——意味着用 cwd 解析 prompt 路径，可能与 task.json 目录不一致。MainAgent/SubagentRunner 传的 promptLoader 来自 SessionLoop 的 `new PromptLoader()`——**全部相对 cwd**。但 defaultConfig 的 prompt 路径是 `agent/prompts/planner.md`——用户必须从特定目录启动 decx-agent。建议 SessionLoop 改用 `new PromptLoader({ baseDir: sessionDir })`。
- ✅ 模块化设计：file + rules + knowledge + instructions 拼接，灵活。
- ✅ `looksLikePath + tryReadFile` 双模式让 rules 既能是路径也能是文本。

---

## 9.5 `config/providers-config.ts` (143 lines) — **providers.json 管理**

**用途**：加载/保存/初始化 `~/.decx/agent/providers.json`，提供 `findProvider` / `listKnownProviders` 等查询。

**关键 API**
- `defaultProvidersPath()` — `~/.decx/agent/providers.json`（或 `DECX_AGENT_PROVIDERS`）
- `loadProvidersFile(filePath?)` — 带缓存的读取
- `saveProvidersFile(file, filePath?)` — 写入并清缓存
- `initProvidersFile(filePath?, presets?)` — 用 preset 种子首次创建
- `findProvider(id, file, presets?)` — user 优先，preset 兜底
- `listKnownProviders(file, presets?)` — user 覆盖同 id 的 preset
- `presetToUserConfig(preset)` — 类型转换

**审计要点**
- ⚠️ **模块级 `cachedFile` / `cachedPath` 缓存**（line 36-37）：进程内单例缓存，多个 loadProvidersFile 调用共享。但**没有缓存失效机制**——外部修改 providers.json 后，必须 saveProvidersFile 或重启才能刷新。对运行中的 agent，热重载需要 reloadProviders。
- ⚠️ **`loadProvidersFile` 静默吞 JSON 解析错误**（line 55-57）：返回空对象——用户写错 JSON 完全无感知。建议 log 警告。
- ⚠️ **`saveProvidersFile` 写入用 `JSON.stringify(file, null, 2) + "\n"`**（line 66）：格式化输出方便人工编辑，但**原子性差**——大文件写入中途 crash 会留下半个文件。建议用 temp file + rename。
- ⚠️ **`initProvidersFile` 复制 preset 时丢字段**（line 78-86）：只复制 `name/baseURL/apiKeyEnv/model`，丢失 `kind/headers`——意味着从 preset 初始化的 providers 全部默认 `kind: "openai"`，anthropic preset 也变 openai 处理——**bug**。
- ⚠️ **`UserProviderConfig` 没字段校验**：用户可以在 providers.json 写任意字段，未知字段被忽略。
- ⚠️ **没有 schema 版本字段**：未来 UserProviderConfig 字段变更，老文件兼容性靠 try/catch JSON parse 兜底，不优雅。
- ✅ 缓存层避免重复 I/O。
- ✅ Preset + User config 分层，user 优先级高。

---

## 9.6 `config/provider-presets.ts` (99 lines) — **9 个内置 Provider 预设**

**用途**：开箱即用的 9 个 LLM API preset，用户复制到 providers.json 填 key 即可用。

**预设列表**
| id | name | model | kind |
|---|---|---|---|
| openai | OpenAI | gpt-5.5 | (openai) |
| anthropic | Anthropic | claude-4.8-opus | (需用户配 kind) |
| deepseek | DeepSeek | deepseek-v4-pro | (openai) |
| glm | Zhipu GLM | glm-5.2 | (openai) |
| minimax | MiniMax | MiniMax-M3 | (openai) |
| kimi | Moonshot Kimi | moonshot-v1-8k | (openai) |
| qwen | Alibaba Qwen | qwen-turbo | (openai) |
| openrouter | OpenRouter | anthropic/claude-4.6-sonnet | (openai) |
| ollama | Ollama (local) | llama3.2 | (openai) |

**审计要点**
- 🚨 **`ProviderPreset` interface 没有 `kind` 字段**（line 17-24）：但 `ConfiguredProvider.complete` 用 `userConfig.kind ?? "openai"` 决定走 OpenAI 还是 Anthropic SDK——意味着 anthropic preset 实际上**永远走 OpenAI SDK**！initProvidersFile 也不复制 kind（见 9.5）——**anthropic preset 不可用**。审计建议：给 ProviderPreset 加 `kind: "openai" | "anthropic"` 字段，所有相关函数透传。
- ⚠️ **`baseURL` 硬编码**（line 30 等）：API 端点变化时需重新发布版本。建议允许 env 覆盖。
- ⚠️ **`ollama` 的 `apiKeyEnv: "OLLAMA_API_KEY"`**（line 95）：Ollama 本地无 key，但代码强制要求 env 存在——用户必须设 `OLLAMA_API_KEY=ollama`（任意值）。文档应在 description 里说明（实际上 line 97 description 提到了）。
- ⚠️ **`openrouter` 的 model 是 `anthropic/claude-4.6-sonnet`**（line 88）：包含 `/` 字符，可能在某些 SDK 路径场景下出问题。OK 但需测试。
- ⚠️ **预设的 model 字段会过期**：`gpt-5.5` / `claude-4.8-opus` / `glm-5.2` 等是预测值，实际 API 可能不识别。建议用相对稳定的 model id。
- ⚠️ **没有中国境外 provider 的地域优化**：openai / anthropic 在中国境内访问需代理——文档应说明。
- ✅ 9 个 preset 覆盖国际 + 中国主流。
- ✅ id 命名简洁（openai / glm / kimi 等）。

---

## 9.7 `config/utils.ts` (48 lines) — **共享解析工具**

**用途**：跨 config / 协议 / HTTP 共用的类型守卫与转换函数，避免在每个模块重复定义。

**导出函数**
- `isRecord(value)` — 类型守卫，排除 null/array
- `stringValue(value)` — trim 后非空字符串或 undefined
- `stringArray(value)` — 字符串数组（trim + 过滤空），空则 undefined
- `positiveInt(value)` — 正整数，支持 number 或 string 输入
- `safeSessionName(value)` — sanitize 为合法目录名（非字母数字 → `-`，去前后 `-`，空则 `"session"`）
- `utcnow()` — `new Date().toISOString()`
- `parseJson(value, fallback)` — try/catch JSON.parse

**审计要点**
- ⚠️ **`stringValue` 与 `task-config.ts` 内的 `stringValue` 不同**：task-config.ts 的版本支持 dot-path（"task.target"），utils.ts 的不支持。**同名不同语义**——若开发者误用 utils 的版本，会丢 dot-path 功能。
- ⚠️ **`safeSessionName` 不防 `..` 转义**（line 33）：`".."` 经过 replace 后仍是 `".."`（regex 不匹配 `.`）——配合 `path.join(baseDir, sessionId)` 可能跳出 baseDir。**安全漏洞**：与 session/session-manager.ts 的 path traversal 风险叠加（见 04-session.md 4.5）。
- ⚠️ **`positiveInt` 接受字符串输入**（line 27）：`Number.parseInt(String(value ?? ""))` ——如果 value 是 object 或 array，String() 转 `[object Object]`，parseInt 失败返回 NaN——OK，但未明确文档化。
- ⚠️ **`parseJson(value, fallback)` 不区分"JSON null"与"解析失败"**：`parseJson("null", [])` 返回 null（合法 JSON），`parseJson("invalid", [])` 返回 []（fallback）——调用方需注意。
- ⚠️ **没有 `asBoolean` / `asNumber`**：与 agent/parse-envelope.ts 的 accessor 不重叠，但风格类似——建议统一到一处。
- ✅ 函数式，无副作用，易测试。
- ✅ 集中化避免散乱重复。

---

## 跨文件观察（Cross-file Observations）

1. **三套默认值常量**：`DEFAULT_LIMITS`（agent/types.ts）+ `DEFAULT_METACOG_TRIGGERS`（agent/types.ts）+ `defaultConfig()`（config/default-config.ts）——它们之间有重叠且**数值不一致**（如 metacog everySeconds 60 vs 30）。建议统一为单一来源。
2. **`normalizeProfile` 忽略 raw.permissions**——自定义 profile 无法声明权限，与 AGENTS.md 承诺冲突。**审计最高优先级 bug**。
3. **`anthropic` preset 缺 `kind` 字段**——anthropic preset 实际走 OpenAI SDK，调用必然失败。**审计最高优先级 bug**。
4. **`safeSessionName` 不防 `..`**——叠加 session-manager 的 join，构成 path traversal 风险。
5. **prompt 文件路径默认相对 cwd**——SessionLoop 应传 `{ baseDir: sessionDir }` 给 PromptLoader。
6. **`task-config.ts` 不支持配 `plannerCooldownSteps`**——配置层功能缺失。
7. **`stringValue` 同名不同语义**（task-config dot-path vs utils plain）——易混淆。
8. **`initProvidersFile` 丢字段**：从 preset 复制时漏 kind/headers，与 9.6 的 anthropic kind 缺失 bug 共同导致 anthropic provider 不可用。

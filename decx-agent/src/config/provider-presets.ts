/**
 * Built-in provider presets for common Chinese and international LLM APIs.
 *
 * Each preset is a complete provider config that the user copies into their
 * ~/.decx/agent/providers.json and fills in the API key. This mirrors the
 * "50+ presets" approach of cc-switch but as simple JSON, no GUI needed.
 *
 * Preset fields:
 *   id          — provider id used in task.json `worker.provider`
 *   name        — human-readable label
 *   baseURL     — OpenAI-compatible API endpoint
 *   apiKeyEnv   — env var holding the API key (user sets this)
 *   model       — default model id
 *   description — short note shown by `decx-agent providers list`
 */

export interface ProviderPreset {
  id: string;
  name: string;
  baseURL: string;
  apiKeyEnv: string;
  model: string;
  description: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    model: "gpt-5.5",
    description: "OpenAI official API (GPT-5.5, etc.)",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseURL: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    model: "claude-4.8-opus",
    description: "Anthropic official API (Claude)",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    model: "deepseek-v4-pro",
    description: "DeepSeek (deepseek-v4-flash, deepseek-v4-pro)",
  },
  {
    id: "glm",
    name: "Zhipu GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "GLM_API_KEY",
    model: "glm-5.2",
    description: "Zhipu AI GLM (glm-5.1, glm-5.2, glm-5-turbo)",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseURL: "https://api.minimax.chat/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
    model: "MiniMax-M3",
    description: "MiniMax China ",
  },
  {
    id: "kimi",
    name: "Moonshot Kimi",
    baseURL: "https://api.moonshot.cn/v1",
    apiKeyEnv: "KIMI_API_KEY",
    model: "moonshot-v1-8k",
    description: "Moonshot Kimi (moonshot-v1-8k, kimi-k2)",
  },
  {
    id: "qwen",
    name: "Alibaba Qwen",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    model: "qwen-turbo",
    description: "Alibaba DashScope (qwen-turbo, qwen-plus, qwen-max)",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    model: "anthropic/claude-4.6-sonnet",
    description: "OpenRouter aggregator (300+ models)",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    model: "llama3.2",
    description: "Local Ollama server (set OLLAMA_API_KEY=ollama)",
  },
];

/**
 * OpenAI provider. Wraps the official `openai` SDK.
 *
 * Config knobs (all optional, with sensible env-based defaults):
 *   - `provider`:   "openai" or "openai-compatible"
 *   - `apiKeyEnv`:  env var name holding the API key (default: OPENAI_API_KEY)
 *   - `baseUrl`:    override the SDK base URL (proxies / Azure / vLLM / etc.)
 *   - `model`:      model name (default: $DECX_AGENT_API_MODEL or gpt-4o-mini)
 *   - `maxTokens`:  forwarded (chat.completions does not cap by default)
 *   - `temperature`: forwarded as-is
 */

import OpenAI from "openai";
import type { WorkerConfig } from "../../core/types.js";
import type { ModelCallInput, ModelCallResult, ModelProvider } from "./types.js";

export class OpenAIProvider implements ModelProvider {
  readonly id = "openai";

  async complete(input: ModelCallInput, config: WorkerConfig): Promise<ModelCallResult> {
    const client = createOpenAIClient(config);
    const completion = await client.chat.completions.create({
      model: resolveModel(config),
      messages: messagesFromInput(input),
      temperature: input.temperature,
    });
    return { text: completion.choices[0]?.message.content ?? "" };
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";

  async complete(input: ModelCallInput, config: WorkerConfig): Promise<ModelCallResult> {
    if (!config.baseUrl) {
      throw new Error("openai-compatible provider requires worker.baseUrl");
    }
    const client = createOpenAIClient(config);
    const completion = await client.chat.completions.create({
      model: resolveModel(config),
      messages: messagesFromInput(input),
      temperature: input.temperature,
    });
    return { text: completion.choices[0]?.message.content ?? "" };
  }
}

function createOpenAIClient(config: WorkerConfig): OpenAI {
  const apiKeyEnv = config.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`openai provider requires ${apiKeyEnv}`);
  return new OpenAI({ apiKey, baseURL: config.baseUrl });
}

function resolveModel(config: WorkerConfig): string {
  return config.model ?? process.env.DECX_AGENT_API_MODEL ?? "gpt-4o-mini";
}

function messagesFromInput(input: ModelCallInput): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: input.prompt });
  return messages;
}

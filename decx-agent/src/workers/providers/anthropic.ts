/**
 * Anthropic provider. Wraps the official `@anthropic-ai/sdk` SDK.
 *
 * Config knobs:
 *   - `apiKeyEnv`:  env var holding the API key (default: ANTHROPIC_API_KEY)
 *   - `baseUrl`:    override the SDK base URL
 *   - `model`:      model name (default: $DECX_AGENT_API_MODEL or claude-3-5-haiku-latest)
 *   - `maxTokens`:  forwarded (default: $DECX_AGENT_API_MAX_TOKENS or 4096)
 *   - `temperature`: forwarded as-is
 */

import Anthropic from "@anthropic-ai/sdk";
import type { WorkerConfig } from "../../core/types.js";
import type { ModelCallInput, ModelCallResult, ModelProvider } from "./types.js";

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";

  async complete(input: ModelCallInput, config: WorkerConfig): Promise<ModelCallResult> {
    const client = createAnthropicClient(config);
    const message = await client.messages.create({
      model: resolveModel(config),
      max_tokens: resolveMaxTokens(config, input),
      messages: [{ role: "user", content: input.prompt }],
      system: input.system,
      temperature: input.temperature,
    });
    return { text: extractText(message) };
  }
}

function createAnthropicClient(config: WorkerConfig): Anthropic {
  const apiKeyEnv = config.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) throw new Error(`anthropic provider requires ${apiKeyEnv}`);
  return new Anthropic({ apiKey, baseURL: config.baseUrl });
}

function resolveModel(config: WorkerConfig): string {
  return config.model ?? process.env.DECX_AGENT_API_MODEL ?? "claude-3-5-haiku-latest";
}

function resolveMaxTokens(config: WorkerConfig, input: ModelCallInput): number {
  if (typeof input.maxTokens === "number") return input.maxTokens;
  if (typeof config.maxTokens === "number") return config.maxTokens;
  const env = Number(process.env.DECX_AGENT_API_MAX_TOKENS ?? 4096);
  return Number.isFinite(env) && env > 0 ? env : 4096;
}

function extractText(message: Anthropic.Messages.Message): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

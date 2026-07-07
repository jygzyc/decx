/**
 * Dynamic provider factory: builds ModelProvider instances from the user's
 * providers.json (or preset defaults). Replaces the static registration of
 * OpenAI/Anthropic/DeepSeek classes with a single entry point that reads
 * config from disk and constructs the right SDK-backed provider.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { WorkerConfig } from "../../agent/types.js";
import type { ModelCallInput, ModelCallResult, ModelProvider } from "./types.js";
import {
  findProvider,
  loadProvidersFile,
  type UserProviderConfig,
} from "../../config/providers-config.js";
import { PROVIDER_PRESETS } from "../../config/provider-presets.js";

export class ConfiguredProvider implements ModelProvider {
  readonly id: string;
  private readonly userConfig: UserProviderConfig;

  constructor(id: string, userConfig: UserProviderConfig) {
    this.id = id;
    this.userConfig = userConfig;
  }

  async complete(input: ModelCallInput, config: WorkerConfig): Promise<ModelCallResult> {
    const apiKey = resolveApiKey(this.userConfig, config);
    const model = config.model ?? this.userConfig.model;
    const baseURL = config.baseUrl ?? this.userConfig.baseURL;
    const kind = this.userConfig.kind ?? "openai";

    if (kind === "anthropic") {
      const anthropic = createAnthropic({ apiKey, baseURL });
      const { text } = await generateText({
        model: anthropic(model),
        prompt: input.prompt,
        system: input.system,
        temperature: input.temperature,
        maxOutputTokens: input.maxTokens ?? config.maxTokens ?? 4096,
        ...(input.system ? { experimental_providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } } } : {}),
      });
      return { text };
    }

    const openai = createOpenAI({ apiKey, baseURL, headers: this.userConfig.headers });
    const { text } = await generateText({
      model: openai(model),
      prompt: input.prompt,
      system: input.system,
      temperature: input.temperature,
      maxOutputTokens: input.maxTokens ?? config.maxTokens,
    });
    return { text };
  }
}

function resolveApiKey(userConfig: UserProviderConfig, workerConfig: WorkerConfig): string {
  const keyEnv = workerConfig.apiKeyEnv ?? userConfig.apiKeyEnv;
  const key = process.env[keyEnv];
  if (!key) throw new Error(`${keyEnv} is required for provider ${userConfig.name ?? "?"}`);
  return key;
}

/**
 * Build ModelProvider instances from providers.json + presets, keyed by id.
 * Called once on registry init. Built-in class providers (OpenAIProvider etc.)
 * are replaced by ConfiguredProvider instances built from the matching preset.
 */
export function buildProvidersFromConfig(
  explicit: Record<string, UserProviderConfig> | undefined,
): Map<string, ModelProvider> {
  const file = explicit ?? loadProvidersFile();
  const seen = new Set<string>();
  const out = new Map<string, ModelProvider>();

  for (const preset of PROVIDER_PRESETS) {
    if (seen.has(preset.id)) continue;
    seen.add(preset.id);
    const match = findProvider(preset.id, file);
    if (!match) continue;
    out.set(preset.id, new ConfiguredProvider(preset.id, match.config));
  }

  for (const id of Object.keys(file)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const match = findProvider(id, file);
    if (!match) continue;
    out.set(id, new ConfiguredProvider(id, match.config));
  }

  return out;
}

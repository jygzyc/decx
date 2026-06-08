/**
 * Provider registry. The three built-in providers (openai, openai-compatible,
 * anthropic) are registered on first import. External code can call
 * `registerProvider` to add a custom adapter without touching this file —
 * that's the configured-extension surface the worker layer is missing.
 */

import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider, OpenAIProvider } from "./openai.js";
import type { ModelProvider } from "./types.js";

const REGISTRY = new Map<string, ModelProvider>();

for (const provider of [new OpenAIProvider(), new OpenAICompatibleProvider(), new AnthropicProvider()]) {
  REGISTRY.set(provider.id, provider);
}

export function registerProvider(provider: ModelProvider): () => void {
  REGISTRY.set(provider.id, provider);
  return () => {
    if (REGISTRY.get(provider.id) === provider) REGISTRY.delete(provider.id);
  };
}

export function getProvider(id: string): ModelProvider | undefined {
  return REGISTRY.get(id);
}

export function listProviderIds(): string[] {
  return [...REGISTRY.keys()];
}

export type { ModelProvider, ModelCallInput, ModelCallResult } from "./types.js";

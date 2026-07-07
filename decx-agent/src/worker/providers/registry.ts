/**
 * Provider registry. Built dynamically from providers.json + built-in presets.
 *
 * On first import, the registry loads ~/.decx/agent/providers.json (or path
 * from DECX_AGENT_PROVIDERS env), merges with presets, and registers a
 * ConfiguredProvider for each entry. External code can still call
 * `registerProvider` to add custom adapters programmatically.
 */

import { buildProvidersFromConfig } from "./configured.js";
import type { ModelProvider } from "./types.js";

let REGISTRY: Map<string, ModelProvider> = buildProvidersFromConfig(undefined);

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

export function reloadProviders(explicit?: Record<string, unknown>): void {
  REGISTRY = buildProvidersFromConfig(explicit as Record<string, never> | undefined);
}

export type { ModelProvider, ModelCallInput, ModelCallResult } from "./types.js";

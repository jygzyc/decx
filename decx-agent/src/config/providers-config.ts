/**
 * User-defined provider configuration loaded from ~/.decx/agent/providers.json
 * (override path via DECX_AGENT_PROVIDERS env).
 *
 * Schema mirrors the on-disk JSON structure. Each provider entry is keyed by
 * id and holds baseURL, apiKeyEnv, model, plus optional overrides. The id
 * matches the `worker.provider` field in task.json.
 *
 * Built-in presets (provider-presets.ts) provide defaults for common APIs;
 * users only need to copy a preset into this file and fill in the API key.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { PROVIDER_PRESETS, type ProviderPreset } from "./provider-presets.js";

export interface UserProviderConfig {
  /** API base URL (OpenAI-compatible endpoint). */
  baseURL: string;
  /** Env var name holding the API key. */
  apiKeyEnv: string;
  /** Default model id. */
  model: string;
  /** Optional human-readable label. */
  name?: string;
  /** Optional provider kind: "openai" (default) or "anthropic". */
  kind?: "openai" | "anthropic";
  /** Optional extra fields forwarded to the underlying SDK. */
  headers?: Record<string, string>;
}

export type ProvidersFile = Record<string, UserProviderConfig>;

const DEFAULT_FILENAME = "providers.json";
let cachedFile: ProvidersFile | undefined;
let cachedPath: string | undefined;

export function defaultProvidersPath(): string {
  const fromEnv = process.env.DECX_AGENT_PROVIDERS;
  if (fromEnv) return fromEnv;
  return path.join(homedir(), ".decx", "agent", DEFAULT_FILENAME);
}

export function loadProvidersFile(filePath: string = defaultProvidersPath()): ProvidersFile {
  if (cachedFile && cachedPath === filePath) return cachedFile;
  let result: ProvidersFile = {};
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        result = parsed as ProvidersFile;
      }
    } catch {
      result = {};
    }
  }
  cachedFile = result;
  cachedPath = filePath;
  return result;
}

export function saveProvidersFile(file: ProvidersFile, filePath: string = defaultProvidersPath()): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  cachedFile = undefined;
  cachedPath = undefined;
}

export function initProvidersFile(
  filePath: string = defaultProvidersPath(),
  presets: readonly ProviderPreset[] = PROVIDER_PRESETS,
): { created: boolean; path: string } {
  if (existsSync(filePath)) {
    return { created: false, path: filePath };
  }
  const seeded: ProvidersFile = {};
  for (const preset of presets) {
    seeded[preset.id] = {
      name: preset.name,
      baseURL: preset.baseURL,
      apiKeyEnv: preset.apiKeyEnv,
      model: preset.model,
    };
  }
  saveProvidersFile(seeded, filePath);
  return { created: true, path: filePath };
}

export function findProvider(
  id: string,
  file: ProvidersFile,
  presets: readonly ProviderPreset[] = PROVIDER_PRESETS,
): { config: UserProviderConfig; source: "user" | "preset" } | undefined {
  const userCfg = file[id];
  if (userCfg) return { config: userCfg, source: "user" };
  const preset = presets.find((p) => p.id === id);
  if (preset) {
    return {
      config: presetToUserConfig(preset),
      source: "preset",
    };
  }
  return undefined;
}

export function listKnownProviders(
  file: ProvidersFile,
  presets: readonly ProviderPreset[] = PROVIDER_PRESETS,
): Array<{ id: string; name: string; baseURL: string; apiKeyEnv: string; model: string; source: "user" | "preset" }> {
  const byId = new Map<string, { id: string; name: string; baseURL: string; apiKeyEnv: string; model: string; source: "user" | "preset" }>();
  for (const preset of presets) {
    byId.set(preset.id, {
      id: preset.id,
      name: preset.name,
      baseURL: preset.baseURL,
      apiKeyEnv: preset.apiKeyEnv,
      model: preset.model,
      source: "preset",
    });
  }
  for (const [id, cfg] of Object.entries(file)) {
    byId.set(id, {
      id,
      name: cfg.name ?? id,
      baseURL: cfg.baseURL,
      apiKeyEnv: cfg.apiKeyEnv,
      model: cfg.model,
      source: "user",
    });
  }
  return [...byId.values()];
}

export function presetToUserConfig(preset: ProviderPreset): UserProviderConfig {
  return {
    baseURL: preset.baseURL,
    apiKeyEnv: preset.apiKeyEnv,
    model: preset.model,
    name: preset.name,
  };
}

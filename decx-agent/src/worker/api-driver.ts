/**
 * Driver for model/API-backed workers.
 *
 * Resolves a configured model provider and turns a prompt into text without an
 * external agent CLI. Use this for direct LLM calls where tool/session behavior
 * is not required.
 */

import type { WorkerConfig, WorkerName } from "../agent/types.js";
import { getProvider } from "./providers/registry.js";
import type { ModelCallInput, ModelCallResult } from "./providers/registry.js";
import type { WorkerDriver, WorkerRequest, WorkerResult } from "./base.js";
import { findProvider, loadProvidersFile } from "../config/providers-config.js";
import { PROVIDER_PRESETS } from "../config/provider-presets.js";

/**
 * ApiDriver — direct model API call through a registered ModelProvider.
 *
 * No agent loop, no tools, no sessions. Used when a phase needs a single LLM
 * completion (e.g. a lightweight reviewer) without paying the subprocess +
 * agent-boot cost of AgentDriver.
 */
export class ApiDriver implements WorkerDriver {
  readonly name: WorkerName;

  constructor(name: WorkerName, private readonly config: WorkerConfig) {
    this.name = name;
  }

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    const providerId = resolveProviderId(this.config);
    const provider = getProvider(providerId);
    if (!provider) {
      return { worker: this.name, returncode: 1, stdout: "", stderr: `unknown model provider: ${providerId}. Run 'decx-agent providers init' to set up providers.` };
    }
    try {
      const callInput: ModelCallInput = {
        prompt: request.prompt,
        maxTokens: this.config.maxTokens,
        model: this.config.model,
        temperature: this.config.temperature,
      };
      const result: ModelCallResult = await provider.complete(callInput, this.config);
      return { worker: this.name, returncode: 0, stdout: result.text, stderr: "" };
    } catch (error) {
      return { worker: this.name, returncode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * Resolve provider id in priority order:
 *   1. config.provider (explicit in task.json)
 *   2. DECX_AGENT_API_PROVIDER env
 *   3. Scan providers.json + presets for the first provider whose apiKeyEnv is set in env
 *   4. "openai" as final fallback
 */
export function resolveProviderId(config: WorkerConfig): string {
  const fromConfig = config.provider?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.DECX_AGENT_API_PROVIDER?.trim();
  if (fromEnv) return fromEnv;

  const file = loadProvidersFile();
  for (const preset of PROVIDER_PRESETS) {
    const match = findProvider(preset.id, file);
    if (!match) continue;
    if (process.env[match.config.apiKeyEnv]) {
      return preset.id;
    }
  }

  return "openai";
}

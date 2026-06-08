/**
 * ModelDriver: dispatches model-backed workers through a registered provider.
 *
 * Resolution order for the provider id (first hit wins):
 *   1. worker config `provider`
 *   2. $DECX_AGENT_API_PROVIDER env var
 *   3. presence of $ANTHROPIC_API_KEY (=> "anthropic") or $OPENAI_API_KEY (=> "openai")
 *
 * Adding a new model requires no edits here — register a `ModelProvider` once
 * (built-in or custom) and reference its id from task.json or env.
 *
 * This file replaces the old `api.ts` and the duplicated `api`/`model`
 * `WorkerKind`. There is now a single `model` kind, parameterised by
 * `provider` in `WorkerConfig`.
 */

import type { WorkerConfig, WorkerName } from "../core/types.js";
import { getProvider } from "./providers/registry.js";
import type { ModelCallInput, ModelCallResult } from "./providers/registry.js";
import type { WorkerDriver, WorkerRequest, WorkerResult } from "./base.js";

export class ModelDriver implements WorkerDriver {
  readonly name: WorkerName;

  constructor(name: WorkerName, private readonly config: WorkerConfig) {
    this.name = name;
  }

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    const providerId = resolveProviderId(this.config);
    const provider = getProvider(providerId);
    if (!provider) {
      return { worker: this.name, returncode: 1, stdout: "", stderr: `unknown model provider: ${providerId}` };
    }
    try {
      const callInput: ModelCallInput = {
        prompt: request.prompt,
        maxTokens: this.config.maxTokens,
        model: this.config.model,
        temperature: this.config.temperature,
      };
      const result: ModelCallResult = await provider.complete(callInput, this.config);
      return { worker: this.name, returncode: 0, stdout: result.text, stderr: "", session: result.session };
    } catch (error) {
      return { worker: this.name, returncode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function resolveProviderId(config: WorkerConfig): string {
  const fromConfig = config.provider?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.DECX_AGENT_API_PROVIDER?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "openai";
}

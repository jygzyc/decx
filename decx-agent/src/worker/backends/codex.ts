/**
 * Codex command backend.
 *
 * Adapts decx-agent worker requests to the Codex CLI. It is one executable
 * backend behind AgentDriver; scheduling, role prompts, and graph state are
 * handled by higher layers.
 */

import type { WorkerConfig } from "../../agent/types.js";
import { SubprocessBackend } from "./subprocess.js";

export class CodexBackend extends SubprocessBackend {
  readonly id = "codex";

  buildArgv(config: WorkerConfig, prompt: string) {
    return {
      argv: [
        "codex", "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        ...modelFlags(config),
        ...providerFlags(config),
        "--", prompt,
      ],
      env: envFor(config),
    };
  }
}

function modelFlags(config: WorkerConfig): string[] {
  const model = config.model ?? process.env.CODEX_MODEL;
  return model ? ["--model", model] : [];
}

function providerFlags(config: WorkerConfig): string[] {
  const baseUrl = config.baseUrl ?? process.env.CODEX_BASE_URL;
  if (!baseUrl) return [];
  return [
    "-c", 'model_provider="decx"',
    "-c", 'model_providers.decx.name="decx"',
    "-c", 'model_providers.decx.wire_api="responses"',
    "-c", 'model_reasoning_effort="high"',
    `-c`, `model_providers.decx.base_url="${baseUrl}"`,
    "-c", 'model_providers.decx.env_key="OPENAI_API_KEY"',
  ];
}

function envFor(config: WorkerConfig): Record<string, string> | undefined {
  const keyEnv = config.apiKeyEnv ?? "OPENAI_API_KEY";
  const key = process.env[keyEnv];
  return key ? { OPENAI_API_KEY: key } : undefined;
}

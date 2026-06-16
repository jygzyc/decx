import type { WorkerConfig } from "../../core/types.js";
import { SubprocessBackend } from "./subprocess.js";

export class ClaudeBackend extends SubprocessBackend {
  readonly id = "claude-code";

  buildArgv(config: WorkerConfig, prompt: string) {
    return {
      argv: ["claude", "--dangerously-skip-permissions", "-p", "--", prompt],
      env: envFor(config),
    };
  }
}

function envFor(config: WorkerConfig): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (config.model) env.ANTHROPIC_MODEL = config.model;
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
  const keyEnv = config.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const key = process.env[keyEnv];
  if (key) env.ANTHROPIC_AUTH_TOKEN = key;
  return Object.keys(env).length > 0 ? env : undefined;
}

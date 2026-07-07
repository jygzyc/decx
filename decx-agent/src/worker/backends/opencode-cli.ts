/**
 * OpenCode CLI backend.
 *
 * Runs OpenCode as a subprocess worker and supports DECX-specific environment
 * wiring for graph-aware workflows. This backend is for local CLI execution;
 * HTTP transport lives in opencode-http.ts.
 */

import type { WorkerConfig } from "../../agent/types.js";
import { SubprocessBackend } from "./subprocess.js";

export class OpencodeCliBackend extends SubprocessBackend {
  readonly id = "opencode";

  buildArgv(config: WorkerConfig, prompt: string): { argv: string[]; env?: Record<string, string> } {
    const args: string[] = ["run"];
    if (config.model) args.push("--model", config.model);
    args.push("--print");
    if (config.args) args.push(...config.args);
    args.push(prompt);

    const env: Record<string, string> = {};
    if (config.baseUrl) env.OPENCODE_BASE_URL = config.baseUrl;
    const keyEnv = config.apiKeyEnv ?? "OPENCODE_API_KEY";
    const key = process.env[keyEnv];
    if (key) env.OPENCODE_API_KEY = key;

    return {
      argv: ["opencode", ...args],
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  }
}

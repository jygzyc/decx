import { spawnSync } from "node:child_process";
import type { WorkerConfig } from "../../core/types.js";
import type { AgentBackend, BackendInvokeInput, BackendInvokeResult } from "./types.js";

const SPAWN_ERROR_RETURNCODE = 127;

export abstract class SubprocessBackend implements AgentBackend {
  abstract readonly id: string;

  abstract buildArgv(config: WorkerConfig, prompt: string): { argv: string[]; env?: Record<string, string>; input?: string };

  invoke(input: BackendInvokeInput): BackendInvokeResult {
    const built = this.buildArgv(input.config, input.prompt);
    const result = spawnSync(built.argv[0], built.argv.slice(1), {
      cwd: input.cwd ?? process.cwd(),
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 10,
      input: built.input,
      env: { ...process.env, ...(built.env ?? {}), DECX_AGENT_ACTIVE: "1" },
    });

    if (result.error) {
      return { text: "", returncode: SPAWN_ERROR_RETURNCODE, stderr: result.error.message };
    }

    return {
      text: result.stdout ?? "",
      returncode: result.status ?? SPAWN_ERROR_RETURNCODE,
      stderr: result.stderr ?? "",
    };
  }
}

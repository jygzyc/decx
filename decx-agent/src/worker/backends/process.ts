/**
 * Generic process backend for configured command workers.
 *
 * Executes arbitrary command/args worker definitions from task configuration.
 * This is the escape hatch for custom agent CLIs while preserving the common
 * AgentBackend invocation contract.
 */

import type { WorkerConfig } from "../../agent/types.js";
import { SubprocessBackend } from "./subprocess.js";

export class ProcessBackend extends SubprocessBackend {
  readonly id = "process";

  buildArgv(config: WorkerConfig, prompt: string) {
    const command = config.command ?? "echo";
    const args = config.args ?? [];
    return { argv: [command, ...args], input: prompt };
  }
}

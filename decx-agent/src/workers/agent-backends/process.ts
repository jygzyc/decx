import type { WorkerConfig } from "../../core/types.js";
import { SubprocessBackend } from "./subprocess.js";

export class ProcessBackend extends SubprocessBackend {
  readonly id = "process";

  buildArgv(config: WorkerConfig, prompt: string) {
    const command = config.command ?? "echo";
    const args = config.args ?? [];
    return { argv: [command, ...args], input: prompt };
  }
}

import type { WorkerConfig } from "../../core/types.js";
import { SubprocessBackend } from "./subprocess.js";

export class OpencodeCliBackend extends SubprocessBackend {
  readonly id = "opencode";

  buildArgv(_config: WorkerConfig, prompt: string) {
    return { argv: ["opencode", "run", prompt] };
  }
}

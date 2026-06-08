import { spawnSync } from "child_process";
import type { WorkerConfig, WorkerName } from "../core/types.js";
import {
  extractRegexSession,
  extractResponseText,
  prepareWorkerSession,
  renderArgTemplates,
  type WorkerDriver,
  type WorkerRequest,
  type WorkerResult,
} from "./base.js";

/** Spawns a CLI tool with prompt/session placeholders rendered in the configured args. */
export class CommandDriver implements WorkerDriver {
  constructor(
    readonly name: WorkerName,
    private readonly config: WorkerConfig,
  ) {}

  execute(request: WorkerRequest): WorkerResult {
    const command = this.config.command ?? this.name;
    const prepared = prepareWorkerSession(request, this.config);
    const args = renderArgTemplates(this.config.args ?? ["{{prompt}}"], request, prepared.session);
    const result = spawnSync(command, args, {
      cwd: request.cwd ?? process.cwd(),
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, ...prepared.env, DECX_AGENT_ACTIVE: "1" },
    });
    const stdout = result.stdout ?? "";
    const stderr = result.error ? result.error.message : (result.stderr ?? "");
    const session = prepared.session ?? extractRegexSession(this.config, stdout, stderr);
    return {
      worker: this.name,
      returncode: result.status ?? 1,
      stdout: extractResponseText(this.config, stdout),
      stderr,
      session,
    };
  }
}

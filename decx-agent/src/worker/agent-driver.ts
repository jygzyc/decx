/**
 * Driver for command/agent-backed workers.
 *
 * Resolves the configured backend, invokes it with a prompt, and normalizes its
 * result into the WorkerDriver contract used by the worker registry. It does not
 * own scheduling or graph state.
 */

import type { WorkerConfig, WorkerName } from "../agent/types.js";
import type { WorkerDriver, WorkerRequest, WorkerResult } from "./base.js";
import { getAgentBackend, ProcessBackend } from "./backends/registry.js";
import type { AgentBackend } from "./backends/types.js";

export class AgentDriver implements WorkerDriver {
  constructor(
    readonly name: WorkerName,
    private readonly config: WorkerConfig,
  ) {}

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    const backend = this.resolveBackend();
    if (!backend) {
      const backendId = this.config.backend ?? this.name;
      return { worker: this.name, returncode: 2, stdout: "", stderr: `unknown agent backend: ${backendId}` };
    }

    const result = await backend.invoke({
      prompt: request.prompt,
      config: this.config,
      cwd: request.cwd,
    });

    return {
      worker: this.name,
      returncode: result.returncode,
      stdout: result.text,
      stderr: result.stderr ?? "",
    };
  }

  private resolveBackend(): AgentBackend | undefined {
    if (this.config.transport === "http") {
      const httpBackend = getAgentBackend(`${this.config.backend ?? this.name}-http`);
      if (httpBackend) return httpBackend;
    }
    const backendId = this.config.backend ?? this.name;
    const registered = getAgentBackend(backendId);
    if (registered) return registered;
    if (this.config.command) return new ProcessBackend();
    return undefined;
  }
}

/**
 * MockWorker — testing-only WorkerPool implementation.
 *
 * Returns canned responses by regex match against the prompt. Falls through
 * to a failure result if no pattern matches. Used in every Stage unit test
 * and in the e2e pipeline test.
 */

import type { ProjectId, TaskConfig, WorkerName } from "../agent/types.js";
import type { WorkerPool, WorkerRequest, WorkerResult } from "./worker-runtime.js";

type ResponseSpec = string | ((request: WorkerRequest) => string | Promise<string>);

interface MockEntry {
  pattern: RegExp;
  response: ResponseSpec;
  returncode: number;
}

export class MockWorker implements WorkerPool {
  private entries: MockEntry[] = [];
  private runningPerProject = new Map<ProjectId, Set<string>>();
  private callLog: Array<{ prompt: string; text: string; workerName?: string }> = [];

  register(pattern: RegExp, response: ResponseSpec, returncode = 0): this {
    this.entries.unshift({ pattern, response, returncode });
    return this;
  }

  reset(): this {
    this.entries = [];
    this.callLog = [];
    return this;
  }

  calls(): Array<{ prompt: string; text: string; workerName?: string }> {
    return [...this.callLog];
  }

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    for (const entry of this.entries) {
      if (entry.pattern.test(request.prompt)) {
        const raw: string | Promise<string> = typeof entry.response === "function"
          ? entry.response(request)
          : entry.response;
        const text = await Promise.resolve(raw);
        this.callLog.push({ prompt: request.prompt, text, workerName: request.workerName });
        return { workerId: "mock", text, returncode: entry.returncode };
      }
    }
    const stderr = `no mock match for prompt: ${request.prompt.slice(0, 100)}`;
    this.callLog.push({ prompt: request.prompt, text: "", workerName: request.workerName });
    return { workerId: "mock", text: "", returncode: 1, stderr };
  }

  pickWorker(projectId: ProjectId, config: TaskConfig): WorkerName {
    const candidates = Object.keys(config.workers);
    const running = this.runningPerProject.get(projectId);
    return candidates.find((w) => !running?.has(w)) ?? candidates[0] ?? "mock";
  }

  runningCount(projectId: ProjectId): number {
    return this.runningPerProject.get(projectId)?.size ?? 0;
  }

  markRunning(projectId: ProjectId, workerId: string): void {
    let s = this.runningPerProject.get(projectId);
    if (!s) {
      s = new Set();
      this.runningPerProject.set(projectId, s);
    }
    s.add(workerId);
  }
}

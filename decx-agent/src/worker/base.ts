/**
 * Shared worker driver request/response types.
 *
 * These types define the lower-level worker registry contract used by AgentDriver
 * and ApiDriver. The agent-facing WorkerPool abstraction lives in worker/worker-runtime.ts.
 */

import type { WorkerConfig, WorkerName } from "../agent/types.js";

export interface WorkerRequest {
  worker: WorkerName;
  role: string;
  projectId: string;
  sessionDir: string;
  prompt: string;
  intentId?: string;
  cwd?: string;
  config?: WorkerConfig;
}

export interface WorkerResult {
  worker: WorkerName;
  returncode: number;
  stdout: string;
  stderr: string;
}

export interface WorkerDriver {
  readonly name: WorkerName;
  execute(request: WorkerRequest): Promise<WorkerResult> | WorkerResult;
}

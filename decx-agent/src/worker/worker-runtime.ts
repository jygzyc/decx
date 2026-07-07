/**
 * WorkerPool — the execution abstraction for decx-agent.
 *
 * Stages never call subprocesses directly. They call WorkerPool.execute().
 * This indirection makes every Stage a pure function of (input, graph, workerPool),
 * which is what makes MockWorker-based testing possible.
 *
 * Two implementations:
 *   - MockWorker: testing, returns canned responses by regex match
 *   - AgentDriverPool: production, wraps AgentDriver + AgentBackend + ModelProvider
 */

import type { TaskConfig, WorkerConfig, WorkerName } from "../agent/types.js";
import type { ProjectId } from "../agent/types.js";

export interface WorkerRequest {
  prompt: string;
  config: WorkerConfig;
  workerName?: WorkerName;
  projectId?: ProjectId;
  expectedPayload?: string;
  cwd?: string;
  maxOutputTokens?: number;
  sessionId?: string;
}

export interface WorkerResult {
  workerId: string;
  text: string;
  returncode: number;
  stderr?: string;
  timedOut?: boolean;
}

export interface WorkerPool {
  /**
   * Execute a worker synchronously (from the caller's perspective).
   * Returns the worker's text output. Non-zero returncode means failure.
   */
  execute(request: WorkerRequest): Promise<WorkerResult>;

  /**
   * Pick a worker for the given project. Should prefer heterogeneous engines
   * (an engine not currently running for this project) when possible.
   */
  pickWorker(projectId: ProjectId, config: TaskConfig): WorkerName;

  /**
   * Number of workers currently executing for the given project.
   */
  runningCount(projectId: ProjectId): number;
}

/**
 * A worker pool that does nothing — for configs that have no workers
 * or for early prototyping. Always fails.
 */
export class NullWorkerPool implements WorkerPool {
  async execute(): Promise<WorkerResult> {
    return { workerId: "null", text: "", returncode: 1, stderr: "null worker pool" };
  }
  pickWorker(): WorkerName { return "null"; }
  runningCount(): number { return 0; }
}

import type { AgentPhase, WorkerConfig, WorkerName } from "../core/types.js";

export interface WorkerRequest {
  worker: WorkerName;
  phase: AgentPhase;
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

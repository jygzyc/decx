import type { WorkerConfig } from "../../core/types.js";

export interface AgentBackend {
  readonly id: string;
  invoke(input: BackendInvokeInput): Promise<BackendInvokeResult> | BackendInvokeResult;
}

export interface BackendInvokeInput {
  prompt: string;
  config: WorkerConfig;
  cwd?: string;
}

export interface BackendInvokeResult {
  text: string;
  returncode: number;
  stderr?: string;
}

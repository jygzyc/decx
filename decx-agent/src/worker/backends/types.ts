/**
 * Agent backend contract.
 *
 * A backend is the bottom adapter for an interactive or one-shot agent runtime
 * such as OpenCode, Codex, Claude Code, or a custom command. It receives a
 * prompt plus WorkerConfig and returns raw text output with process metadata.
 */

import type { WorkerConfig } from "../../agent/types.js";

export interface AgentBackend {
  readonly id: string;
  invoke(input: BackendInvokeInput): Promise<BackendInvokeResult> | BackendInvokeResult;
  supportsConclude?: boolean;
}

export interface BackendInvokeInput {
  prompt: string;
  config: WorkerConfig;
  cwd?: string;
  conclude?: boolean;
  partialOutput?: string;
}

export interface BackendInvokeResult {
  text: string;
  returncode: number;
  stderr?: string;
  timedOut?: boolean;
}

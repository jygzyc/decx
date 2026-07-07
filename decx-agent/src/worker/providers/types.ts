/**
 * Provider contract for any model-backed worker.
 *
 * Implementations wrap an official SDK (or a custom one) and expose a single
 * `complete` call. The agent runtime treats them as black boxes that turn a
 * prompt into text. Adding a new model is a matter of writing a class that
 * implements `ModelProvider` and registering it via `registerProvider`.
 */

import type { WorkerConfig } from "../../agent/types.js";

export interface ModelCallInput {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelCallResult {
  text: string;
  session?: string;
}

export interface ModelProvider {
  readonly id: string;
  complete(input: ModelCallInput, config: WorkerConfig): Promise<ModelCallResult>;
}

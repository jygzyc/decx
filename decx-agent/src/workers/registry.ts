/**
 * Worker execution layer: a registry of driver factories and built-in worker
 * configs.
 *
 * Adding a new worker is one of two things:
 *   - `kind: "command"` (e.g. `codex`, `claude-code`, `opencode`, plus any
 *     CLI-based agent runner): add an entry to `BUILTIN_WORKER_CONFIGS`.
 *   - `kind: "model"` (any API-backed model): register a `ModelProvider` in
 *     `./providers/registry.ts` and reference its id from `provider` in
 *     `task.json`. No source change needed for new providers.
 *
 * The legacy `"api"` `WorkerKind` was a synonym for `"model"` and is
 * intentionally gone; existing task.json files that say `kind: "api"` should
 * switch to `kind: "model"`.
 */

import type { WorkerConfig, WorkerKind, WorkerName } from "../core/types.js";
import { listProviderIds } from "./providers/registry.js";
import type { WorkerDriver, WorkerRequest, WorkerResult } from "./base.js";
import { CommandDriver } from "./command.js";
import { ModelDriver } from "./model.js";
import { NoopDriver } from "./noop.js";

export type { WorkerDriver, WorkerRequest, WorkerResult } from "./base.js";

type DriverFactory = (name: WorkerName, config: WorkerConfig) => WorkerDriver;

const DRIVER_FACTORIES: Record<WorkerKind, DriverFactory> = {
  noop: (name) => new NoopDriver(name),
  command: (name, config) => new CommandDriver(name, config),
  model: (name, config) => new ModelDriver(name, config),
};

const BUILTIN_WORKER_CONFIGS: Record<string, WorkerConfig> = {
  // Test / fallback.
  noop: { kind: "noop" },

  // CLI-driven agent runners — preserved verbatim.
  codex: { kind: "command", command: "codex", args: ["exec", "{{prompt}}"] },
  "claude-code": {
    kind: "command",
    command: "claude",
    args: ["--print", "--output-format", "text", "--dangerously-skip-permissions", "--no-session-persistence", "{{prompt}}"],
  },
  opencode: { kind: "command", command: "opencode", args: ["run", "{{prompt}}"] },

  // Model-backed workers. Provider id is resolved through the
  // `providers/registry.ts` map; `api` is the generic "pick a provider from
  // env" entry, the named variants pin a specific provider.
  api: { kind: "model" },
  openai: { kind: "model", provider: "openai" },
  anthropic: { kind: "model", provider: "anthropic" },
  "openai-compatible": { kind: "model", provider: "openai-compatible" },
};

export const WORKERS: WorkerName[] = Object.keys(BUILTIN_WORKER_CONFIGS);

export function executeWorker(request: WorkerRequest): Promise<WorkerResult> | WorkerResult {
  const config = resolveWorkerConfig(request.worker, request.config);
  if (!config) {
    return { worker: request.worker, returncode: 2, stdout: "", stderr: `unsupported worker: ${request.worker}` };
  }
  const factory = DRIVER_FACTORIES[config.kind];
  if (!factory) {
    return { worker: request.worker, returncode: 2, stdout: "", stderr: `unsupported worker kind: ${config.kind}` };
  }
  return factory(request.worker, config).execute({ ...request, config });
}

export function knownWorkers(configured: Record<string, WorkerConfig> | undefined): WorkerName[] {
  return [...new Set([...WORKERS, ...Object.keys(configured ?? {})])];
}

export function workerCapabilities(): Record<string, unknown> {
  return {
    workers: WORKERS,
    driverKinds: Object.keys(DRIVER_FACTORIES),
    modelProviders: listProviderIds(),
  };
}

function resolveWorkerConfig(worker: WorkerName, configured: WorkerConfig | undefined): WorkerConfig | undefined {
  return configured ?? BUILTIN_WORKER_CONFIGS[worker];
}

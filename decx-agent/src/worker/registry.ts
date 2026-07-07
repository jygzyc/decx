/**
 * Worker driver registry.
 *
 * Resolves named workers from task configuration or built-ins, dispatches to the
 * appropriate driver kind, and exposes capability metadata for CLI/status
 * commands. This is the bridge from WorkerPool to concrete drivers.
 */

import type { WorkerConfig, WorkerKind, WorkerName } from "../agent/types.js";
import { listProviderIds } from "./providers/registry.js";
import type { WorkerDriver, WorkerRequest, WorkerResult } from "./base.js";
import { AgentDriver } from "./agent-driver.js";
import { ApiDriver } from "./api-driver.js";
import { listAgentBackendIds } from "./backends/registry.js";

export type { WorkerDriver, WorkerRequest, WorkerResult } from "./base.js";

type DriverFactory = (name: WorkerName, config: WorkerConfig) => WorkerDriver;

const DRIVER_FACTORIES: Partial<Record<WorkerKind, DriverFactory>> = {
  agent: (name, config) => new AgentDriver(name, config),
  api: (name, config) => new ApiDriver(name, config),
};

const BUILTIN_WORKER_CONFIGS: Record<string, WorkerConfig> = {
  "claude-code": { kind: "agent", backend: "claude-code" },
  codex: { kind: "agent", backend: "codex" },
  opencode: { kind: "agent", backend: "opencode" },
  api: { kind: "api" },
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
    agentBackends: listAgentBackendIds(),
    modelProviders: listProviderIds(),
  };
}

function resolveWorkerConfig(worker: WorkerName, configured: WorkerConfig | undefined): WorkerConfig | undefined {
  return configured ?? BUILTIN_WORKER_CONFIGS[worker];
}

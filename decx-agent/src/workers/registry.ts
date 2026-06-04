/**
 * Worker execution layer: driver registry, request/result types, and command runner.
 * All worker backends are registered here. The dispatcher calls `executeWorker()` to dispatch work.
 */

import { spawnSync } from "child_process";
import type { AgentPhase, WorkerConfig, WorkerName } from "../core/types.js";
import { runApiWorker } from "./api.js";
import { NoopDriver } from "./noop.js";

// --- Public types ---

export interface WorkerRequest {
  worker: WorkerName;
  phase: AgentPhase;
  role: string;
  projectId: string;
  sessionDir: string;
  artifactDir: string;
  references: string[];
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

// --- Registry ---

export const WORKERS: WorkerName[] = ["noop", "codex", "claude-code", "opencode", "api"];

const BUILTIN_WORKER_CONFIGS: Record<string, WorkerConfig> = {
  noop: { kind: "noop" },
  codex: { kind: "command", command: "codex", args: ["exec", "{{prompt}}"] },
  "claude-code": {
    kind: "command",
    command: "claude",
    args: ["--print", "--output-format", "text", "--dangerously-skip-permissions", "--no-session-persistence", "{{prompt}}"],
  },
  opencode: { kind: "command", command: "opencode", args: ["run", "{{prompt}}"] },
  api: { kind: "api" },
};

/** Spawns a CLI tool with the prompt as a command-line argument. */
class CommandDriver implements WorkerDriver {
  constructor(
    readonly name: WorkerName,
    private readonly config: WorkerConfig,
  ) {}

  execute(request: WorkerRequest): WorkerResult {
    const command = this.config.command ?? this.name;
    const args = (this.config.args ?? ["{{prompt}}"]).map((arg) => arg === "{{prompt}}" ? request.prompt : arg);
    const result = spawnSync(command, args, {
      cwd: request.cwd ?? process.cwd(),
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, DECX_AGENT_ACTIVE: "1" },
    });
    return {
      worker: this.name,
      returncode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.error ? result.error.message : (result.stderr ?? ""),
    };
  }
}

/** Calls OpenAI-compatible or Anthropic chat completion endpoints. */
class ApiDriver implements WorkerDriver {
  readonly name = "api" as const;
  execute(request: WorkerRequest): Promise<WorkerResult> {
    return runApiWorker(request.prompt, request.config, request.worker);
  }
}

export function executeWorker(request: WorkerRequest): Promise<WorkerResult> | WorkerResult {
  const config = request.config ?? BUILTIN_WORKER_CONFIGS[request.worker];
  if (!config) {
    return { worker: request.worker, returncode: 2, stdout: "", stderr: `unsupported worker: ${request.worker}` };
  }
  const driver = driverFor(request.worker, config);
  return driver.execute({ ...request, config });
}

export function knownWorkers(configured: Record<string, WorkerConfig> | undefined): WorkerName[] {
  return [...new Set([...WORKERS, ...Object.keys(configured ?? {})])];
}

function driverFor(name: WorkerName, config: WorkerConfig): WorkerDriver {
  switch (config.kind) {
    case "noop":
      return new NoopDriver(name);
    case "command":
      return new CommandDriver(name, config);
    case "api":
      return new ApiDriver();
  }
}

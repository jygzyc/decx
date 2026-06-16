import type { DatabaseSync } from "node:sqlite";
import { loadTaskConfigInput } from "./core/task-config.js";
import type { ProjectDetail, WorkerConfig, WorkerName } from "./core/types.js";
import { DispatcherLoop, type DispatcherOptions } from "./dispatcher/loop.js";
import { openAgentDb } from "./server/db.js";
import { AgentRepository } from "./server/repository.js";
import { knownWorkers, workerCapabilities } from "./workers/registry.js";

export interface StartRunInput {
  configPath: string;
  session?: string;
  worker?: string;
}

export type RunOptions = DispatcherOptions;

export class AgentRuntime {
  private readonly db: DatabaseSync;
  readonly repo: AgentRepository;
  readonly dispatcher: DispatcherLoop;

  constructor(dbPath?: string) {
    this.db = openAgentDb(dbPath);
    this.repo = new AgentRepository(this.db);
    this.dispatcher = new DispatcherLoop(this.repo);
  }

  async start(input: StartRunInput, options: RunOptions = {}): Promise<ProjectDetail> {
    const loaded = loadTaskConfigInput(input.configPath, input.session);
    const worker = normalizeWorker(input.worker ?? loaded.config.worker, loaded.config.workers);
    const detail = this.repo.createProject({
      session: loaded.session,
      name: loaded.config.task.name ?? loaded.session,
      target: loaded.config.task.target,
      goal: loaded.config.task.goal,
      worker,
      sessionDir: loaded.sessionDir,
      configPath: loaded.configPath,
      taskConfig: loaded.config,
    });
    return this.dispatcher.runProject(detail.project.id, options);
  }

  async resume(idOrSession: string, options: RunOptions = {}): Promise<ProjectDetail> {
    return this.dispatcher.runProject(idOrSession, options);
  }

  status(idOrSession: string): ProjectDetail {
    return this.repo.getProject(idOrSession);
  }

  workers(): ReturnType<typeof workerCapabilities> {
    return workerCapabilities();
  }
}

function normalizeWorker(value: string | undefined, configured?: Record<string, WorkerConfig>): WorkerName {
  const worker = value ?? "noop";
  if (!knownWorkers(configured).includes(worker)) throw new Error(`unsupported worker: ${value}`);
  return worker;
}

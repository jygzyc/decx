/**
 * Wall-clock metacognition loop.
 *
 * Runs the metacog profile via SubagentRunner, independently of the main
 * SessionLoop step cadence. Tracks active SubagentRuns and honors maxActive
 * to prevent over-spawning.
 */

import type { ProjectId, TaskConfig } from "../agent/types.js";
import type { Graph } from "../graph/graph.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { runSubagent, metacogExtra } from "../agent/subagent-runner.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { ContextLedger } from "../agent/context-ledger.js";
import { WorkerSessionManager } from "../worker/session-manager.js";
import { ProjectLockManager } from "./project-lock.js";

const DEFAULT_METACOG_INTERVAL_MS = 30_000;

export class MetacogSupervisor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly intervalMs: number;
  private readonly promptLoader: PromptLoader;
  readonly contextLedger = new ContextLedger();
  readonly sessionManager = new WorkerSessionManager();

  constructor(
    private readonly graph: Graph,
    private readonly workerPool: WorkerPool,
    private readonly config: TaskConfig,
    private readonly locks: ProjectLockManager,
    intervalMs?: number,
  ) {
    const cfg = config.workflow.metacog?.triggers?.everySeconds;
    this.intervalMs = intervalMs ?? (cfg ? cfg * 1000 : DEFAULT_METACOG_INTERVAL_MS);
    this.promptLoader = new PromptLoader();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  async runOnce(): Promise<void> {
    const active = this.graph.listProjects("active");
    await Promise.allSettled(active.map((p) => this.runForProject(p.id)));
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const active = this.graph.listProjects("active");
    await Promise.allSettled(active.map((p) => this.runForProject(p.id)));
  }

  private async runForProject(projectId: ProjectId): Promise<void> {
    await this.locks.acquire(projectId, async () => {
      const progress = this.graph.progress(projectId);
      const stagnationTrigger = this.config.workflow.metacog?.triggers?.stagnationLevel ?? 3;
      const everySteps = this.config.workflow.metacog?.triggers?.everySteps ?? 5;

      const shouldRun =
        progress.stagnationLevel >= stagnationTrigger
        || progress.stepsExecuted > 0 && progress.stepsExecuted % everySteps === 0
        || progress.openIntents === 0 && progress.chainedIntents === 0 && progress.candidateFacts === 0 && progress.acceptedFacts > 0;

      if (!shouldRun) return;

      const metacogProfileId = this.config.control?.metacogProfile ?? "metacog";
      const profile = this.config.profiles[metacogProfileId] ?? this.config.profiles.metacog;
      if (!profile) return;

      const maxActive = profile.maxActive ?? 1;
      const activeRuns = this.graph.subagentRuns(projectId, { profileId: metacogProfileId, status: "running" });
      if (activeRuns.length >= maxActive) return;

      const run = this.graph.createSubagentRun(projectId, {
        profileId: metacogProfileId,
        role: profile.role,
        workerName: profile.runtime.worker,
        inputSummary: "scheduled metacog tick",
      });

      try {
        this.graph.updateSubagentRun(projectId, run.id, { status: "running" });

        const output = await runSubagent({
          profile,
          profileId: metacogProfileId,
          projectId, graph: this.graph,
          workerPool: this.workerPool, config: this.config,
          promptLoader: this.promptLoader,
          contextLedger: this.contextLedger,
          sessionManager: this.sessionManager,
          promptExtra: metacogExtra("scheduled"),
        });

        if (output.kind === "hints") {
          for (const hint of output.hints.hints) {
            this.graph.addHint(projectId, hint);
          }
          this.graph.updateSubagentRun(projectId, run.id, {
            status: "completed",
            outputSummary: `${output.hints.hints.length} hints`,
          });
        } else if (output.kind === "stop") {
          this.graph.updateProjectStatus(projectId, "stopped");
          this.graph.logEvent(projectId, "metacog.stop_request", { reason: output.stop.reason });
          this.graph.updateSubagentRun(projectId, run.id, {
            status: "completed",
            outputSummary: `stop: ${output.stop.reason}`,
          });
        } else {
          this.graph.updateSubagentRun(projectId, run.id, {
            status: "completed",
            outputSummary: `unexpected kind: ${output.kind}`,
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.graph.updateSubagentRun(projectId, run.id, { status: "failed", errorMessage: reason });
        this.graph.logEvent(projectId, "metacog.error", { error: reason });
      }
    });
  }
}

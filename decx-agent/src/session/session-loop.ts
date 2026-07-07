/**
 * Per-session main loop.
 *
 * Drives project steps: directives → planner (MainAgent) → explorers
 * (SubagentRunner) → evaluators (SubagentRunner) → chain resolution →
 * termination. Scheduling and SubagentRun lifecycle live here; role-specific
 * prompt assembly is delegated to SubagentRunner.
 */

import type { Fact, Intent, ProjectId } from "../agent/types.js";
import { DEFAULT_LIMITS } from "../agent/types.js";
import type { Graph } from "../graph/graph.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { StageError } from "../agent/parse-envelope.js";
import { MainAgent } from "../agent/main-agent.js";
import { applyMainDecision } from "../agent/decision-applier.js";
import {
  runSubagent,
  runSubagentWithText,
  explorerExtra,
  evaluatorExtra,
} from "../agent/subagent-runner.js";
import { ContextLedger } from "../agent/context-ledger.js";
import { WorkerSessionManager } from "../worker/session-manager.js";
import { ProjectLockManager } from "./project-lock.js";
import { PromptLoader } from "../config/prompt-loader.js";

export type StepResult =
  | { type: "stepped"; intentsDispatched: number; factsAccepted: number }
  | { type: "idle"; reason: string }
  | { type: "completed" }
  | { type: "failed"; reason: string };

export interface RunOptions {
  maxSteps?: number;
  idlePollMs?: number;
  onStep?: (projectId: ProjectId, step: number, result: StepResult) => void;
}

const DEFAULT_LEASE_MS = 300_000;

export class SessionLoop {
  private locks = new ProjectLockManager();
  readonly contextLedger = new ContextLedger();
  readonly sessionManager = new WorkerSessionManager();
  private stepVerdicts = new Map<ProjectId, Array<{ factId: string; verdict: import("../agent/types.js").Verdict; intentId?: string }>>();
  readonly locks_: ProjectLockManager;
  private readonly promptLoader: PromptLoader;

  constructor(
    private readonly graph: Graph,
    private readonly workerPool: WorkerPool,
    private readonly config: import("../agent/types.js").TaskConfig,
  ) {
    this.locks_ = this.locks;
    this.promptLoader = new PromptLoader();
  }

  async step(projectId: ProjectId): Promise<StepResult> {
    return this.locks.acquire(projectId, async () => this.stepLocked(projectId));
  }

  async tick(): Promise<StepResult[]> {
    this.graph.sweepExpiredLeases();
    const active = this.graph.listProjects("active");
    const results = await Promise.allSettled(active.map((p) => this.step(p.id)));
    return results.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { type: "failed" as const, reason: `exception: ${(r.reason as Error)?.message ?? String(r.reason)}` },
    );
  }

  async run(projectId: ProjectId, options: RunOptions = {}): Promise<StepResult> {
    const maxSteps = options.maxSteps ?? 100;
    const idlePollMs = options.idlePollMs ?? 50;
    let lastResult: StepResult = { type: "stepped", intentsDispatched: 0, factsAccepted: 0 };

    for (let step = 1; step <= maxSteps; step += 1) {
      lastResult = await this.step(projectId);
      options.onStep?.(projectId, step, lastResult);
      if (lastResult.type === "completed" || lastResult.type === "failed") break;
      if (lastResult.type === "idle") await sleep(idlePollMs);
    }
    return lastResult;
  }

  private async stepLocked(projectId: ProjectId): Promise<StepResult> {
    const project = this.graph.getProject(projectId);
    if (!project) return { type: "failed", reason: "project not found" };

    this.graph.sweepExpiredLeases();

    await this.consumeDirectives(projectId);
    const current = this.graph.getProject(projectId)!;
    if (current.status !== "active") {
      if (current.status === "completed" || current.status === "stopped") return { type: "completed" };
      if (current.status === "failed") return { type: "failed", reason: "project failed" };
      return { type: "idle", reason: `project status=${current.status}` };
    }

    const factsBefore = this.graph.facts(projectId, "accepted").length;

    await this.maybeRunPlanner(projectId);
    const dispatched = await this.dispatchExplorers(projectId);
    await this.runEvaluators(projectId);
    await this.resolveChains(projectId);

    const term = this.checkTermination(projectId);
    if (term) return term;

    const factsAfter = this.graph.facts(projectId, "accepted").length;
    return { type: "stepped", intentsDispatched: dispatched, factsAccepted: factsAfter - factsBefore };
  }

  private async consumeDirectives(projectId: ProjectId): Promise<void> {
    const directives = this.graph.unconsumedDirectives(projectId);
    for (const dir of directives) {
      this.graph.consumeDirective(projectId, dir.id);
      switch (dir.kind) {
        case "stop":
          this.graph.updateProjectStatus(projectId, "stopped");
          this.graph.logEvent(projectId, "directive.stop", { reason: dir.payload });
          return;
        case "pause":
          this.graph.updateProjectStatus(projectId, "paused");
          this.graph.logEvent(projectId, "directive.pause", { reason: dir.payload });
          return;
        case "resume":
          this.graph.updateProjectStatus(projectId, "active");
          this.graph.logEvent(projectId, "directive.resume", {});
          break;
        case "hint":
          this.graph.addHint(projectId, { content: dir.payload, creator: "human" });
          this.graph.logEvent(projectId, "directive.hint", { content: dir.payload });
          break;
        case "kill-intent":
          try {
            this.graph.failIntent(projectId, dir.payload, "killed by directive", false);
            this.graph.logEvent(projectId, "directive.kill", { intentId: dir.payload });
          } catch { /* intent may not exist */ }
          break;
        case "spawn-intent":
          this.graph.addIntent(projectId, { description: dir.payload, creator: "human" });
          this.graph.logEvent(projectId, "directive.spawn", { description: dir.payload });
          break;
      }
    }
  }

  private lastPlannerStep = new Map<ProjectId, number>();

  private async maybeRunPlanner(projectId: ProjectId): Promise<void> {
    const intents = this.graph.intents(projectId);
    const hints = this.graph.unconsumedHints(projectId);
    const recentVerdicts = this.stepVerdicts.get(projectId) ?? [];

    const isEmpty = intents.length === 0;
    const hasRejectOrDemote = recentVerdicts.some((v) => v.verdict.decision !== "accept");
    const hasActionableHint = hints.some((h) => h.kind === "stop-explorer" || h.kind === "direction");

    const needsPlanning = isEmpty || hasActionableHint || hasRejectOrDemote;
    if (!needsPlanning) {
      this.stepVerdicts.set(projectId, []);
      return;
    }

    const progress = this.graph.progress(projectId);
    const lastStep = this.lastPlannerStep.get(projectId) ?? -99;
    const cooldown = this.config.workflow.limits.plannerCooldownSteps ?? 3;
    const inCooldown = progress.stepsExecuted - lastStep < cooldown;

    if (!isEmpty && !hasActionableHint && !hasRejectOrDemote && inCooldown) {
      this.stepVerdicts.set(projectId, []);
      return;
    }

    try {
      const agent = new MainAgent({
        projectId, graph: this.graph, config: this.config,
        workerPool: this.workerPool, promptLoader: this.promptLoader,
        contextLedger: this.contextLedger, sessionManager: this.sessionManager,
      });
      const { decision, permissions } = await agent.run({
        hints: hints.length > 0 ? hints : undefined,
        recentVerdicts: hasRejectOrDemote ? recentVerdicts : undefined,
      });

      applyMainDecision({
        projectId, graph: this.graph, config: this.config,
        decision, permissions,
      });

      this.stepVerdicts.set(projectId, []);
      this.lastPlannerStep.set(projectId, progress.stepsExecuted);
    } catch (err) {
      this.graph.logEvent(projectId, "planner.error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatchExplorers(projectId: ProjectId): Promise<number> {
    const open = this.graph.intents(projectId, "open");
    if (open.length === 0) return 0;

    const dispatchable = open.filter((i) => !this.graph.isDeadEnd(projectId, i.description));
    for (const dead of open.filter((i) => this.graph.isDeadEnd(projectId, i.description))) {
      this.graph.failIntent(projectId, dead.id, "skipped: matches recorded dead-end", true);
    }
    if (dispatchable.length === 0) return 0;

    const limits = this.config.workflow.limits;
    const maxConcurrent = limits.maxConcurrent ?? DEFAULT_LIMITS.maxConcurrent;
    const refillPerTick = limits.refillPerTick ?? DEFAULT_LIMITS.refillPerTick;
    const claimedCount = this.graph.intents(projectId, "claimed").length;
    const availableSlots = Math.max(0, maxConcurrent - claimedCount);
    const slots = Math.min(availableSlots, refillPerTick, dispatchable.length);
    if (slots <= 0) return 0;

    let batch = dispatchable.slice(0, slots);

    const explorerProfile = this.config.profiles.explorer;
    if (explorerProfile.maxActive !== undefined) {
      const activeRuns = this.graph.subagentRuns(projectId, { profileId: "explorer", status: "running" }).length;
      const inFlight = Math.max(activeRuns, claimedCount);
      if (inFlight >= explorerProfile.maxActive) return 0;
      batch = batch.slice(0, explorerProfile.maxActive - inFlight);
      if (batch.length === 0) return 0;
    }

    await Promise.allSettled(batch.map((intent) => this.runOneExplorer(projectId, intent)));
    return batch.length;
  }

  private async runOneExplorer(projectId: ProjectId, intent: Intent): Promise<void> {
    const leaseMs = this.config.workflow.limits.workerLeaseMs ?? DEFAULT_LEASE_MS;
    const workerId = `w-${intent.id}-${Date.now().toString(36)}`;

    const explorerProfile = this.config.profiles.explorer;
    const run = this.graph.createSubagentRun(projectId, {
      profileId: "explorer",
      role: explorerProfile.role,
      workerName: explorerProfile.runtime.workers?.[0] ?? explorerProfile.runtime.worker,
      intentId: intent.id,
      inputSummary: intent.description,
    });

    try {
      this.graph.claimIntent(projectId, intent.id, workerId, leaseMs);
      this.graph.updateSubagentRun(projectId, run.id, { status: "running" });

      const { output, prompt, usedDelta } = await runSubagentWithText({
        profile: explorerProfile,
        profileId: "explorer",
        projectId, graph: this.graph,
        workerPool: this.workerPool, config: this.config,
        promptLoader: this.promptLoader,
        contextLedger: this.contextLedger,
        sessionManager: this.sessionManager,
        intent,
        promptExtra: explorerExtra(intent.id, intent.description, intent.parentFactIds, [], false),
      });
      const inputTokens = Math.ceil(prompt.length / 4);
      const outputTokens = 0;

      if (output.kind === "chain") {
        this.graph.chainIntent(projectId, intent.id, output.chain);
        this.graph.updateSubagentRun(projectId, run.id, {
          status: "completed",
          outputSummary: `chain: ${output.chain.reason}`,
          usedDelta, inputTokens,
        });
        return;
      }

      if (output.kind !== "fact") {
        throw new StageError(`explorer returned kind="${output.kind}", expected "fact" or "chain"`, "explorer");
      }

      const fact = this.graph.addFact(projectId, {
        description: output.fact.description,
        evidence: output.fact.evidence,
        source: "explorer",
        confidence: output.fact.confidence,
        parentIntentId: intent.id,
      });
      this.graph.concludeIntent(projectId, intent.id, fact.id);
      this.graph.updateSubagentRun(projectId, run.id, {
        status: "completed",
        factId: fact.id,
        outputSummary: output.fact.description.slice(0, 200),
        usedDelta, inputTokens,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        this.graph.failIntent(projectId, intent.id, reason, false);
      } catch { /* already concluded */ }
      this.graph.updateSubagentRun(projectId, run.id, { status: "failed", errorMessage: reason });
      this.graph.logEvent(projectId, "explorer.error", { intentId: intent.id, error: reason, runId: run.id });
    }
  }

  private async runEvaluators(projectId: ProjectId): Promise<void> {
    const candidates = this.graph.pendingCandidates(projectId);
    if (candidates.length === 0) return;

    const evaluatorProfile = this.config.profiles.evaluator;

    await Promise.allSettled(
      candidates.map(async (candidate) => {
        const run = this.graph.createSubagentRun(projectId, {
          profileId: "evaluator",
          role: evaluatorProfile.role,
          workerName: evaluatorProfile.runtime.worker,
          factId: candidate.id,
          inputSummary: candidate.description.slice(0, 200),
        });
        try {
          this.graph.updateSubagentRun(projectId, run.id, { status: "running" });

          const output = await runSubagent({
            profile: evaluatorProfile,
            profileId: "evaluator",
            projectId, graph: this.graph,
            workerPool: this.workerPool, config: this.config,
            promptLoader: this.promptLoader,
            contextLedger: this.contextLedger,
            sessionManager: this.sessionManager,
            candidate,
            promptExtra: evaluatorExtra(candidate),
          });

          if (output.kind !== "verdict") {
            throw new StageError(`evaluator returned kind="${output.kind}", expected "verdict"`, "evaluator");
          }

          this.graph.resolveFact(projectId, candidate.id, output.verdict);

          const verdicts = this.stepVerdicts.get(projectId) ?? [];
          verdicts.push({
            factId: candidate.id,
            verdict: output.verdict,
            intentId: candidate.parentIntentId,
          });
          this.stepVerdicts.set(projectId, verdicts);

          this.graph.updateSubagentRun(projectId, run.id, {
            status: "completed",
            outputSummary: `${output.verdict.decision}: ${output.verdict.reason.slice(0, 150)}`,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.graph.resolveFact(projectId, candidate.id, {
            decision: "reject",
            reason: `evaluator error: ${reason}`,
          });
          this.graph.updateSubagentRun(projectId, run.id, { status: "failed", errorMessage: reason });
          this.graph.logEvent(projectId, "evaluator.error", {
            factId: candidate.id, error: reason, runId: run.id,
          });
        }
      }),
    );
  }

  private async resolveChains(projectId: ProjectId): Promise<void> {
    const chained = this.graph.intents(projectId, "chained");
    if (chained.length === 0) return;

    const explorerProfile = this.config.profiles.explorer;

    for (const intent of chained) {
      if (!intent.chain) continue;

      const subIntents = intent.chain.subIntentIds
        .map((id) => this.graph.getIntent(projectId, id))
        .filter((s): s is Intent => s !== undefined);

      const terminalSubs = subIntents.filter((s) => s.status === "done" || s.status === "failed");
      const ready = intent.chain.waitMode === "all"
        ? terminalSubs.length === subIntents.length && subIntents.length > 0
        : terminalSubs.length >= 1;
      if (!ready) continue;

      const enrichedContext: Fact[] = [];
      for (const sub of terminalSubs) {
        if (sub.status === "done" && sub.concludedFactId) {
          const f = this.graph.getFact(projectId, sub.concludedFactId);
          if (f && f.status === "accepted") enrichedContext.push(f);
        }
      }

      this.graph.resumeChainedIntent(projectId, intent.id);
      const leaseMs = this.config.workflow.limits.workerLeaseMs ?? DEFAULT_LEASE_MS;
      const workerId = `w-${intent.id}-r-${Date.now().toString(36)}`;

      try {
        this.graph.claimIntent(projectId, intent.id, workerId, leaseMs);

        const output = await runSubagent({
          profile: explorerProfile,
          profileId: "explorer",
          projectId, graph: this.graph,
          workerPool: this.workerPool, config: this.config,
          promptLoader: this.promptLoader,
          contextLedger: this.contextLedger,
          sessionManager: this.sessionManager,
          promptExtra: explorerExtra(intent.id, intent.description, intent.parentFactIds, [], true),
          enrichedContext,
        });

        if (output.kind === "chain") {
          this.graph.chainIntent(projectId, intent.id, output.chain);
        } else if (output.kind === "fact") {
          const fact = this.graph.addFact(projectId, {
            description: output.fact.description,
            evidence: output.fact.evidence,
            source: "explorer",
            confidence: output.fact.confidence,
            parentIntentId: intent.id,
          });
          this.graph.concludeIntent(projectId, intent.id, fact.id);
        } else {
          throw new StageError(`chain resume returned kind="${output.kind}", expected "fact" or "chain"`, "explorer");
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        try { this.graph.failIntent(projectId, intent.id, reason, false); } catch { /* concluded */ }
        this.graph.logEvent(projectId, "chain.resume.error", { intentId: intent.id, error: reason });
      }
    }
  }

  private checkTermination(projectId: ProjectId): StepResult | undefined {
    const project = this.graph.getProject(projectId);
    if (!project) return { type: "failed", reason: "project not found" };
    if (project.status !== "active") {
      if (project.status === "completed" || project.status === "stopped") return { type: "completed" };
      if (project.status === "failed") return { type: "failed", reason: "project failed" };
      if (project.status === "paused") return { type: "idle", reason: "paused by directive" };
    }

    const limits = this.config.workflow.limits;
    const progress = this.graph.progress(projectId);
    const maxSteps = limits.maxSteps ?? DEFAULT_LIMITS.maxSteps;

    if (maxSteps > 0 && progress.stepsExecuted >= maxSteps) {
      this.graph.updateProjectStatus(projectId, "failed");
      this.graph.logEvent(projectId, "project.max_steps", { maxSteps });
      return { type: "failed", reason: `max-steps (${maxSteps}) exceeded` };
    }

    const stopGate = this.config.workflow.stopGate;
    if (stopGate?.requireNoOpenIntents && progress.openIntents === 0 && progress.chainedIntents === 0) {
      if (stopGate.minFactConfidence !== undefined) {
        const accepted = this.graph.facts(projectId, "accepted");
        if (accepted.length > 0) {
          const avg = accepted.reduce((s, f) => s + f.confidence, 0) / accepted.length;
          if (avg < stopGate.minFactConfidence) return undefined;
        }
      }
      this.graph.updateProjectStatus(projectId, "completed");
      this.graph.logEvent(projectId, "project.stop_gate_satisfied", {});
      return { type: "completed" };
    }

    const maxStagnation = limits.maxStagnation ?? DEFAULT_LIMITS.maxStagnation;
    if (maxStagnation > 0 && progress.stagnationLevel >= maxStagnation && progress.openIntents === 0 && progress.chainedIntents === 0) {
      this.graph.updateProjectStatus(projectId, "paused");
      this.graph.logEvent(projectId, "project.stagnation_paused", { stagnationLevel: progress.stagnationLevel, maxStagnation });
      return { type: "idle", reason: "paused by stagnation (resume via directive)" };
    }

    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

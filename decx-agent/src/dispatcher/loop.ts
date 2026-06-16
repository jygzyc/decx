import { parseWorkerPayload, type WorkerPayload } from "../core/protocol.js";
import type { AgentPhase, Intent, TaskConfig, WorkerName, WorkflowEvent, WorkflowRule } from "../core/types.js";
import { executeWorker, type WorkerResult } from "../workers/registry.js";
import { buildWorkerPrompt } from "./prompt.js";
import type { AgentRepository } from "../server/repository.js";
import type { ProjectDetail } from "../core/types.js";
import { utcnow } from "../core/utils.js";
import { applyAutonomy } from "./autonomy.js";
import { matchesWorkflowRule } from "./workflow.js";
import { defaultRoleForPhase, getRole } from "./roles.js";

export interface DispatcherOptions {
  maxSteps?: number;
  awaitReviews?: boolean;
}

/**
 * DispatcherLoop: the core execution loop.
 * Each step: pick the next open intent → select phase → dispatch to a worker → apply result → fire workflow rules.
 *
 * Workflow fires are tracked in-memory per DispatcherLoop instance (not persisted).
 * WorkflowEvents are in-memory signals for the rule matcher (not persisted).
 */
export class DispatcherLoop {
  private readonly firedRules = new Set<string>();
  private readonly runningReviews = new Set<string>();

  constructor(private readonly repo: AgentRepository) {}

  // Run up to maxSteps iterations. Stops early if the project completes or fails.
  async runProject(projectIdOrSession: string, options: DispatcherOptions = {}): Promise<ProjectDetail> {
    const maxSteps = options.maxSteps ?? 8;
    let detail = this.repo.getProject(projectIdOrSession);
    for (let step = 0; step < maxSteps && detail.project.status === "active"; step += 1) {
      await this.step(detail.project.id, { awaitReviews: options.awaitReviews ?? true });
      detail = this.repo.getProject(detail.project.id);
    }
    return detail;
  }

  // Execute exactly one step: pick next intent → dispatch → evaluate rules.
  async step(projectId: string, options: DispatcherOptions = {}): Promise<void> {
    const detail = this.repo.getProject(projectId);
    if (detail.project.status !== "active") return;

    const intent = nextIntent(detail);
    const phase = selectPhase(detail, intent);
    await this.executePhase(detail, phase, intent);

    if (phase !== "review") {
      const review = this.maybeReview(projectId, options.awaitReviews ?? true);
      if (review) await review;
    }
  }

  // Tick all active projects (called from server loop).
  async runActiveOnce(): Promise<void> {
    for (const p of this.repo.listProjects().filter(p => p.status === "active")) {
      await this.step(p.id, { awaitReviews: false });
    }
  }

  private async executePhase(detail: ProjectDetail, phase: AgentPhase, intent?: Intent): Promise<void> {
    const phaseConfig = detail.project.taskConfig.workflow.phases.find((item) => item.id === phase);
    const role = intent?.role ?? phaseConfig?.agent ?? phaseConfig?.role ?? defaultRoleForPhase(phase);
    const worker = workerFor(detail.project.taskConfig, role, intent?.worker ?? detail.project.worker);
    if (intent) this.repo.claimIntent(detail.project.id, intent.id, worker);

    const startedAt = utcnow();
    const result = await executeWorker({
      worker, phase, role,
      projectId: detail.project.id,
      intentId: intent?.id,
      sessionDir: detail.project.sessionDir,
      prompt: buildWorkerPrompt({ detail, phase, role, intent }),
      cwd: detail.project.sessionDir,
      config: detail.project.taskConfig.workers[worker],
    });
    const completedAt = utcnow();

    this.repo.addRun(detail.project.id, {
      worker: result.worker, role, phase, intentId: intent?.id,
      returncode: result.returncode,
      stdoutPreview: result.stdout.slice(0, 1000),
      stderrPreview: result.stderr.slice(0, 1000),
      startedAt, completedAt,
    });

    if (result.returncode !== 0) {
      if (intent) this.repo.failIntent(detail.project.id, intent.id, result.stderr || "worker failed");
      const failureEvents = this.emitEvents(detail.project.id, [{
        type: "worker.failed",
        severity: "high",
        category: "worker",
        source: result.worker,
        data: { returncode: result.returncode, stderr: result.stderr.slice(0, 500) },
      }], result.worker, phase, intent);
      this.evaluateWorkflow(detail.project.id, detail.project.taskConfig, failureEvents);
      return;
    }

    try {
      const payload = parseWorkerPayload(phase, result.stdout);
      const checked = applyAutonomy(getRole(detail.project.taskConfig, role), payload);
      if (!checked.allowed) {
        if (intent) this.repo.failIntent(detail.project.id, intent.id, checked.reason);
        const violationEvents = this.emitEvents(detail.project.id, [{
          type: "autonomy.violation",
          severity: "medium",
          category: "autonomy",
          source: role,
          data: { reason: checked.reason },
        }], result.worker, phase, intent);
        this.evaluateWorkflow(detail.project.id, detail.project.taskConfig, violationEvents);
        return;
      }
      const events = this.applyPayload(detail, phase, role, checked.payload, result.worker, intent);
      this.evaluateWorkflow(detail.project.id, detail.project.taskConfig, events);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (intent) this.repo.failIntent(detail.project.id, intent.id, reason);
      const parseEvents = this.emitEvents(detail.project.id, [{
        type: "worker.parse_failed",
        severity: "medium",
        category: "worker",
        source: role,
        data: { reason },
      }], result.worker, phase, intent);
      this.evaluateWorkflow(detail.project.id, detail.project.taskConfig, parseEvents);
    }
    this.repo.touchProject(detail.project.id);
  }

  // Handle each payload kind and return the in-memory workflow events it produced.
  private applyPayload(
    detail: ProjectDetail, phase: AgentPhase, role: string,
    payload: WorkerPayload, worker: WorkerName, intent?: Intent,
  ): WorkflowEvent[] {
    const pid = detail.project.id;
    if (payload.kind === "rejected") {
      if (intent) this.repo.failIntent(pid, intent.id);
      return [];
    }
    if (payload.kind === "fact") {
      if (intent) this.repo.concludeIntent(pid, intent.id, payload.description, payload.evidence, role);
      else this.repo.addFact(pid, { id: nextFactId(detail), description: payload.description, evidence: payload.evidence, source: role, confidence: 1.0, createdAt: utcnow() });
      return this.emitEvents(pid, payload.events, worker, phase, intent);
    }
    if (payload.kind === "intents") {
      for (const next of payload.intents.slice(0, 3)) {
        this.repo.addIntent(pid, {
          from: next.from.length > 0 ? next.from : ["origin"],
          description: next.description, creator: role, worker,
        });
      }
      return [];
    }
    if (payload.kind === "complete") {
      this.repo.addFact(pid, { id: nextFactId(detail), description: payload.description, evidence: payload.from, source: role, confidence: 1.0, createdAt: utcnow() });
      this.repo.updateProjectStatus(pid, "completed");
      return [];
    }
    if (payload.kind === "review") {
      // Reviews are stored as facts from the reviewer source, plus we update last_review_at.
      const events = this.emitEvents(pid, payload.events, worker, "review", intent);
      this.repo.addFact(pid, {
        id: nextFactId(detail),
        description: payload.summary,
        evidence: events.map(e => e.id),
        source: "reviewer",
        confidence: payload.severity === "high" || payload.severity === "critical" ? 0.9 : 0.7,
        createdAt: utcnow(),
      });
      this.repo.touchReview(pid);
      return events;
    }
    return this.emitEvents(pid, payload.events, worker, phase, intent);
  }

  // Run the reviewer if enough steps have passed since last review.
  private maybeReview(projectId: string, awaitReview: boolean): Promise<void> | undefined {
    if (this.runningReviews.has(projectId)) return;
    const detail = this.repo.getProject(projectId);
    const config = detail.project.taskConfig.workflow.review;
    if (!config?.enabled) return;
    const every = config.everySteps ?? 5;
    const primaryRuns = detail.runs.filter(r => r.phase !== "review").length;
    if (primaryRuns === 0 || primaryRuns % every !== 0) return;
    if (config.everySeconds) {
      const last = detail.project.lastReviewAt;
      if (last && Date.now() - Date.parse(last) < config.everySeconds * 1000) return;
    }
    this.runningReviews.add(projectId);
    const review = this.executePhase(detail, "review").finally(() => {
      this.runningReviews.delete(projectId);
    });
    if (awaitReview) return review;
    review.catch((err: unknown) => console.error(err instanceof Error ? err.message : String(err)));
    return undefined;
  }

  // Build in-memory WorkflowEvent objects (NOT persisted).
  private emitEvents(
    pid: string, events: Array<Omit<WorkflowEvent, "id" | "createdAt" | "worker" | "phase">>,
    worker: WorkerName, phase: AgentPhase, intent?: Intent,
  ): WorkflowEvent[] {
    return this.repo.emitEvents(pid, events.map(e => ({ ...e, worker, phase, intentId: intent?.id })));
  }

  // Match new events against workflow rules. Each (rule × event) fires at most once.
  private evaluateWorkflow(projectId: string, config: TaskConfig, events: WorkflowEvent[]): void {
    const rules = config.workflow.rules;
    if (!rules) return;
    for (const event of events) {
      for (const rule of rules) {
        const fireKey = `${projectId}:${rule.id}:${event.id}`;
        if (this.firedRules.has(fireKey)) continue;
        const detail = this.repo.getProject(projectId);
        if (!matchesWorkflowRule(rule, event, { facts: detail.facts, intents: detail.intents })) continue;
        this.applyWorkflowRule(projectId, rule, event);
        this.firedRules.add(fireKey);
      }
    }
  }

  private applyWorkflowRule(projectId: string, rule: WorkflowRule, event: WorkflowEvent): void {
    for (const action of rule.then) {
      if ("createIntent" in action) {
        this.repo.addIntent(projectId, {
          from: [],
          description: action.createIntent.description,
          creator: "workflow",
          role: action.createIntent.agent ?? action.createIntent.role,
          worker: action.createIntent.worker,
          promptText: action.createIntent.promptText,
        });
      } else if ("completeRun" in action) {
        this.repo.updateProjectStatus(projectId, "completed");
      } else {
        this.repo.updateProjectStatus(projectId, "failed");
      }
    }
  }
}

// Phase selection logic: high-level task direction based on graph state.
function selectPhase(detail: ProjectDetail, intent?: Intent): AgentPhase {
  if (detail.facts.length <= 2 && detail.intents.length === 0) return "bootstrap";
  return intent ? "explore" : "reason";
}

// Prefer workflow-created intents first (they carry explicit instructions), then any open intent.
function nextIntent(detail: ProjectDetail): Intent | undefined {
  const open = detail.intents
    .filter(i => i.status === "open")
    .sort((a, b) => {
      if (a.creator === "workflow" && b.creator !== "workflow") return -1;
      if (a.creator !== "workflow" && b.creator === "workflow") return 1;
      return b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    });
  return open[0];
}

// Resolve worker for a role: role-level override → parent role's worker → reviewer config → fallback.
function workerFor(config: TaskConfig, role: string, fallback: WorkerName): WorkerName {
  const resolved = getRole(config, role);
  return config.agents?.[role]?.worker
    ?? config.agents?.[resolved.extends ?? ""]?.worker
    ?? config.workflow.phases.find((item) => item.id === resolved.phase)?.worker
    ?? (role === (config.workflow.review?.role ?? "reviewer") ? config.workflow.review?.worker ?? fallback : fallback);
}

function nextFactId(detail: ProjectDetail): string {
  const count = detail.facts.filter(f => f.id.startsWith("f")).length + 1;
  return `f${String(count).padStart(3, "0")}`;
}

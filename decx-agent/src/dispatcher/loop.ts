import { parseWorkerPayload, type WorkerPayload } from "../core/protocol.js";
import type { AgentPhase, Intent, TaskConfig, WorkerName, WorkflowEvent, WorkflowRule } from "../core/types.js";
import { executeWorker } from "../workers/registry.js";
import { buildWorkerPrompt } from "./prompt.js";
import type { AgentRepository } from "../server/repository.js";
import type { ProjectDetail } from "../server/repository-types.js";
import { utcnow } from "../server/repository.js";
import { matchesWorkflowRule, readWorkflowPrompt } from "./workflow.js";
import { defaultRoleForPhase, getRole } from "./roles.js";

export interface DispatcherOptions {
  maxSteps?: number;
  awaitReviews?: boolean;
}

/**
 * DispatcherLoop: the core execution loop.
 * Each step: pick the next open intent → select phase → dispatch to a worker → apply result → fire workflow rules.
 */
export class DispatcherLoop {
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
    const role = intent?.agent ?? intent?.role ?? phaseConfig?.agent ?? phaseConfig?.role ?? defaultRoleForPhase(phase);
    const worker = workerFor(detail.project.taskConfig, role, intent?.worker ?? detail.project.worker);
    if (intent) this.repo.setIntentWorking(detail.project.id, intent.id, worker);

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

    this.repo.addWorkerRun(detail.project.id, {
      worker: result.worker, role, agent: role, phase, intentId: intent?.id,
      returncode: result.returncode,
      stdoutPreview: result.stdout.slice(0, 1000),
      stderrPreview: result.stderr.slice(0, 1000),
      errorKind: result.returncode === 0 ? undefined : "worker_failed",
      workerSession: result.session,
      startedAt, completedAt,
    });

    if (result.returncode !== 0) {
      if (intent) this.repo.failIntent(detail.project.id, intent.id, result.stderr || "worker failed");
      this.recordEvents(detail.project.id, [{
        type: "worker.failed",
        severity: "high",
        category: "worker",
        source: result.worker,
        data: { returncode: result.returncode, stderr: result.stderr.slice(0, 500) },
      }], result.worker, phase, intent);
      return;
    }

    try {
      const payload = parseWorkerPayload(phase, result.stdout);
      const checked = applyAutonomy(getRole(detail.project.taskConfig, role), payload);
      if (!checked.allowed) {
        if (intent) this.repo.failIntent(detail.project.id, intent.id, checked.reason);
        this.recordEvents(detail.project.id, [{
          type: "autonomy.violation",
          severity: "medium",
          category: "autonomy",
          source: role,
          data: { reason: checked.reason },
        }], result.worker, phase, intent);
        return;
      }
      const events = this.applyPayload(detail, phase, role, checked.payload, result.worker, intent);
      this.evaluateWorkflow(detail.project.id, detail.project.taskConfig, events);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (intent) this.repo.failIntent(detail.project.id, intent.id, reason);
      this.recordEvents(detail.project.id, [{
        type: "worker.parse_failed",
        severity: "medium",
        category: "worker",
        source: role,
        data: { reason },
      }], result.worker, phase, intent);
    }
    this.repo.touchProject(detail.project.id);
  }

  // Handle each payload kind and return the workflow events it produced.
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
      else this.repo.addFact(pid, { id: nextFactId(detail), description: payload.description, evidence: payload.evidence, source: role, createdAt: utcnow() });
      return this.recordEvents(pid, payload.events, worker, phase, intent);
    }
    if (payload.kind === "intents") {
      for (const next of payload.intents.slice(0, 3)) {
        this.repo.addIntent(pid, {
          from: next.from.length > 0 ? next.from : ["origin"],
          description: next.description, creator: role,
          agent: next.role ?? "explorer", worker,
        });
      }
      return [];
    }
    if (payload.kind === "complete") {
      this.repo.addFact(pid, { id: nextFactId(detail), description: payload.description, evidence: payload.from, source: role, createdAt: utcnow() });
      this.repo.updateProjectStatus(pid, "completed");
      return [];
    }
    if (payload.kind === "review") {
      const events = this.recordEvents(pid, payload.events, worker, "review", intent);
      this.repo.addReview(pid, { worker, summary: payload.summary, severity: payload.severity, events });
      return events;
    }
    return this.recordEvents(pid, payload.events, worker, phase, intent);
  }

  // Run the reviewer if enough steps have passed since last review.
  private maybeReview(projectId: string, awaitReview: boolean): Promise<void> | undefined {
    const config = this.repo.getProject(projectId).project.taskConfig.workflow.review;
    if (!config?.enabled) return;
    const every = config.everySteps ?? 5;
    const primaryRuns = this.repo.getProject(projectId).workerRuns.filter(r => r.phase !== "review").length;
    if (primaryRuns === 0 || primaryRuns % every !== 0) return;
    if (config.everySeconds) {
      const last = this.repo.lastReview(projectId);
      if (last && Date.now() - Date.parse(last.createdAt) < config.everySeconds * 1000) return;
    }
    const review = this.executePhase(this.repo.getProject(projectId), "review");
    if (awaitReview) return review;
    review.catch((err: unknown) => console.error(err instanceof Error ? err.message : String(err)));
    return undefined;
  }

  // Tag events with worker/phase/intent metadata and persist.
  private recordEvents(
    pid: string, events: Array<Omit<WorkflowEvent, "id" | "createdAt" | "worker" | "phase">>,
    worker: WorkerName, phase: AgentPhase, intent?: Intent,
  ): WorkflowEvent[] {
    return this.repo.addEvents(pid, events.map(e => ({ ...e, worker, phase, intentId: intent?.id })));
  }

  // Match new events against workflow rules. Each (rule × event) fires at most once.
  private evaluateWorkflow(projectId: string, config: TaskConfig, events: WorkflowEvent[]): void {
    const rules = config.workflow.rules;
    if (!rules) return;
    for (const event of events) {
      for (const rule of rules) {
        if (this.repo.hasWorkflowFire(projectId, rule.id, event.id)) continue;
        const detail = this.repo.getProject(projectId);
        if (!matchesWorkflowRule(rule, event, { facts: detail.facts, intents: detail.intents })) continue;
        this.applyWorkflowRule(projectId, rule, event);
        this.repo.markWorkflowFire(projectId, rule.id, event.id);
      }
    }
  }

  private applyWorkflowRule(projectId: string, rule: WorkflowRule, event: WorkflowEvent): void {
    const detail = this.repo.getProject(projectId);
    for (const action of rule.then) {
      if ("createIntent" in action) {
        this.repo.addIntent(projectId, {
          from: [],
          fromEvents: action.createIntent.fromEvent === false ? [] : [event.id],
          description: action.createIntent.description,
          creator: "workflow",
          agent: action.createIntent.agent ?? action.createIntent.role ?? "explorer",
          worker: action.createIntent.worker,
          promptText: action.createIntent.promptText ?? readWorkflowPrompt(detail.project.sessionDir, action.createIntent.prompt),
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
  return detail.intents.find(i => i.status === "open" && i.creator === "workflow")
    ?? detail.intents.find(i => i.status === "open");
}

// Resolve worker for a role: role-level override → parent role's worker → reviewer config → fallback.
function workerFor(config: TaskConfig, role: string, fallback: WorkerName): WorkerName {
  const resolved = getRole(config, role);
  return config.agents?.[role]?.worker
    ?? config.roles?.[role]?.worker
    ?? config.agents?.[resolved.extends ?? ""]?.worker
    ?? config.roles?.[resolved.extends ?? ""]?.worker
    ?? config.workflow.phases.find((item) => item.id === resolved.phase)?.worker
    ?? (role === (config.workflow.review?.role ?? "reviewer") ? config.workflow.review?.worker ?? fallback : fallback);
}

function applyAutonomy(role: ReturnType<typeof getRole>, payload: WorkerPayload): { allowed: true; payload: WorkerPayload } | { allowed: false; reason: string } {
  if (payload.kind === "intents") {
    if (!role.autonomy.canCreateIntents) return { allowed: false, reason: `${role.id} cannot create intents` };
    if (payload.intents.length > role.autonomy.maxIntentsPerStep) {
      return { allowed: true, payload: { ...payload, intents: payload.intents.slice(0, role.autonomy.maxIntentsPerStep) } };
    }
  }
  if (payload.kind === "complete" && !role.autonomy.canCompleteRun) return { allowed: false, reason: `${role.id} cannot complete runs` };
  if (payload.kind === "rejected" && !role.autonomy.canFailRun) return { allowed: false, reason: `${role.id} cannot fail work` };
  if (payload.kind === "review" && !role.autonomy.canReview) return { allowed: false, reason: `${role.id} cannot review` };
  return { allowed: true, payload };
}

function nextFactId(detail: ProjectDetail): string {
  const count = detail.facts.filter(f => f.id.startsWith("f")).length + 1;
  return `f${String(count).padStart(3, "0")}`;
}

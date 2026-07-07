/**
 * In-memory Graph implementation.
 *
 * Used by tests and lightweight runtime scenarios. Mirrors SQLiteGraph behavior
 * closely enough for loopestration tests, including transactions, leases,
 * dead-end tracking, directives, events, and progress counters.
 */

import type {
  ChainRequest,
  Directive,
  DirectiveId,
  DirectiveInput,
  Fact,
  FactId,
  FactStatus,
  GraphEvent,
  Hint,
  HintId,
  Intent,
  IntentId,
  IntentStatus,
  ISOTime,
  Link,
  LinkId,
  Progress,
  Project,
  ProjectId,
  ProjectStatus,
  RunId,
  RunStatus,
  SubagentRun,
  SubagentRunInput,
  TaskConfig,
  Verdict,
  WorkerName,
} from "../agent/types.js";
import {
  type FactInput,
  type HintInput,
  type IntentInput,
  type LinkInput,
  type ProjectInput,
  type Graph,
  newProjectId,
  newRunId,
  now,
  routeHash,
} from "./graph.js";

interface InMemoryState {
  projects: Map<ProjectId, Project>;
  facts: Map<ProjectId, Map<FactId, Fact>>;
  intents: Map<ProjectId, Map<IntentId, Intent>>;
  hints: Map<ProjectId, Map<HintId, Hint>>;
  directives: Map<ProjectId, Map<DirectiveId, Directive>>;
  links: Map<ProjectId, Map<LinkId, Link>>;
  events: Map<ProjectId, GraphEvent[]>;
  runs: Map<ProjectId, Map<RunId, SubagentRun>>;
  seqCounters: Map<ProjectId, number>;
  deadEnds: Map<ProjectId, Map<string, { intentId: IntentId; description: string; reason: string }>>;
  stagnationCounters: Map<ProjectId, number>;
  stepCounters: Map<ProjectId, number>;

  factCounters: Map<ProjectId, number>;
  intentCounters: Map<ProjectId, number>;
  hintCounters: Map<ProjectId, number>;
  directiveCounters: Map<ProjectId, number>;
  linkCounters: Map<ProjectId, number>;

  snapshots: Map<ProjectId, unknown[]>;
}

export class InMemoryGraph implements Graph {
  private state: InMemoryState = {
    projects: new Map(),
    facts: new Map(),
    intents: new Map(),
    hints: new Map(),
    directives: new Map(),
    links: new Map(),
    events: new Map(),
    runs: new Map(),
    seqCounters: new Map(),
    deadEnds: new Map(),
    stagnationCounters: new Map(),
    stepCounters: new Map(),
    factCounters: new Map(),
    intentCounters: new Map(),
    hintCounters: new Map(),
    directiveCounters: new Map(),
    linkCounters: new Map(),
    snapshots: new Map(),
  };

  private inTx = false;
  private txSnapshot: InMemoryState | undefined;

  // ─── Project ───

  createProject(input: ProjectInput): Project {
    const existing = this.findProject(input.session);
    if (existing) return existing;

    const id = newProjectId();
    const ts = now();
    const project: Project = {
      id,
      session: input.session,
      name: input.name,
      target: input.target,
      goal: input.goal,
      status: "active",
      worker: input.worker,
      sessionDir: input.sessionDir,
      configPath: input.configPath,
      taskConfig: input.taskConfig,
      createdAt: ts,
      updatedAt: ts,
    };

    this.transaction(() => {
      this.state.projects.set(id, project);
      this.state.facts.set(id, new Map());
      this.state.intents.set(id, new Map());
      this.state.hints.set(id, new Map());
      this.state.directives.set(id, new Map());
      this.state.links.set(id, new Map());
      this.state.events.set(id, []);
      this.state.runs.set(id, new Map());
      this.state.seqCounters.set(id, 0);
      this.state.deadEnds.set(id, new Map());
      this.state.stagnationCounters.set(id, 0);
      this.state.stepCounters.set(id, 0);
      this.state.factCounters.set(id, 0);
      this.state.intentCounters.set(id, 0);
      this.state.hintCounters.set(id, 0);
      this.state.directiveCounters.set(id, 0);
      this.state.linkCounters.set(id, 0);
    });

    return project;
  }

  getProject(idOrSession: string): Project | undefined {
    return this.findProject(idOrSession);
  }

  listProjects(status?: ProjectStatus): Project[] {
    const all = [...this.state.projects.values()];
    return status ? all.filter((p) => p.status === status) : all;
  }

  updateProjectStatus(id: ProjectId, status: ProjectStatus): void {
    this.transaction(() => {
      const p = this.state.projects.get(id);
      if (!p) throw new Error(`project not found: ${id}`);
      p.status = status;
      p.updatedAt = now();
      this.logEvent(id, "project.status", { status });
    });
  }

  touchProject(id: ProjectId): void {
    const p = this.state.projects.get(id);
    if (p) p.updatedAt = now();
  }

  // ─── Fact ───

  addFact(projectId: ProjectId, input: FactInput): Fact {
    return this.transaction(() => {
      const factsMap = this.requireFacts(projectId);
      const counter = this.state.factCounters.get(projectId)! + 1;
      this.state.factCounters.set(projectId, counter);
      const id = `f${String(counter).padStart(3, "0")}`;
      const fact: Fact = {
        id,
        projectId,
        description: input.description,
        evidence: input.evidence ?? [],
        source: input.source,
        confidence: input.confidence ?? 1.0,
        status: "candidate",
        parentIntentId: input.parentIntentId,
        stepDiscovered: this.state.stepCounters.get(projectId) ?? 0,
        createdAt: now(),
      };
      factsMap.set(id, fact);
      this.logEvent(projectId, "fact.created", {
        factId: id,
        source: fact.source,
        description: fact.description,
        confidence: fact.confidence,
      });
      return fact;
    });
  }

  getFact(projectId: ProjectId, factId: FactId): Fact | undefined {
    return this.state.facts.get(projectId)?.get(factId);
  }

  facts(projectId: ProjectId, status?: FactStatus): Fact[] {
    const all = [...(this.state.facts.get(projectId)?.values() ?? [])];
    return status ? all.filter((f) => f.status === status) : all;
  }

  pendingCandidates(projectId: ProjectId): Fact[] {
    return this.facts(projectId, "candidate");
  }

  resolveFact(projectId: ProjectId, factId: FactId, verdict: Verdict): void {
    this.transaction(() => {
      const factsMap = this.requireFacts(projectId);
      const fact = factsMap.get(factId);
      if (!fact) throw new Error(`fact not found: ${factId}`);
      if (fact.status !== "candidate" && fact.status !== "blocked") {
        throw new Error(`fact is not resolvable: ${factId} (status=${fact.status})`);
      }
      fact.status = verdict.decision === "reject" ? "rejected" : verdict.decision === "block" ? "blocked" : "accepted";
      if (verdict.confidence !== undefined) {
        fact.confidence = verdict.confidence;
      } else if (verdict.decision === "block") {
        fact.confidence = Math.min(fact.confidence, 0.35);
      }
      fact.reviewerReason = verdict.reason;
      fact.requiredConditions = verdict.requiredConditions ?? [];
      this.logEvent(projectId, "fact.resolved", { factId, verdict });

      if (verdict.decision === "accept" || verdict.decision === "demote") {
        this.state.stagnationCounters.set(projectId, 0);
      }
    });
  }

  // ─── Intent ───

  addIntent(projectId: ProjectId, input: IntentInput): Intent {
    return this.transaction(() => {
      const intentsMap = this.requireIntents(projectId);
      const counter = this.state.intentCounters.get(projectId)! + 1;
      this.state.intentCounters.set(projectId, counter);
      const id = `i${String(counter).padStart(3, "0")}`;
      const intent: Intent = {
        id,
        projectId,
        description: input.description,
        creator: input.creator,
        parentFactIds: input.parentFactIds ?? [],
        status: "open",
        parentIntentId: input.parentIntentId,
        priority: input.priority ?? 0,
        createdAt: now(),
      };
      intentsMap.set(id, intent);
      this.logEvent(projectId, "intent.created", {
        intentId: id,
        description: input.description,
        creator: input.creator,
      });
      return intent;
    });
  }

  getIntent(projectId: ProjectId, intentId: IntentId): Intent | undefined {
    return this.state.intents.get(projectId)?.get(intentId);
  }

  intents(projectId: ProjectId, status?: IntentStatus): Intent[] {
    const all = [...(this.state.intents.get(projectId)?.values() ?? [])];
    return status ? all.filter((i) => i.status === status) : all;
  }

  claimIntent(projectId: ProjectId, intentId: IntentId, workerId: string, leaseMs: number): Intent {
    return this.transaction(() => {
      const intent = this.requireIntent(projectId, intentId);
      if (intent.status !== "open") {
        throw new Error(`intent is not open: ${intentId} (status=${intent.status})`);
      }
      intent.status = "claimed";
      const t = Date.now();
      intent.lease = {
        workerId,
        claimedAt: new Date(t).toISOString(),
        expiresAt: new Date(t + leaseMs).toISOString(),
      };
      this.logEvent(projectId, "intent.claimed", { intentId, workerId });
      return intent;
    });
  }

  releaseIntent(projectId: ProjectId, intentId: IntentId): void {
    this.transaction(() => {
      const intent = this.requireIntent(projectId, intentId);
      if (intent.status === "claimed") {
        intent.status = "open";
        intent.lease = undefined;
        this.logEvent(projectId, "intent.released", { intentId });
      }
    });
  }

  concludeIntent(projectId: ProjectId, intentId: IntentId, factId?: FactId): void {
    this.transaction(() => {
      const intent = this.requireIntent(projectId, intentId);
      if (intent.status === "done" || intent.status === "failed") {
        throw new Error(`intent already concluded: ${intentId}`);
      }
      intent.status = "done";
      intent.concludedAt = now();
      intent.concludedFactId = factId;
      this.bumpStep(projectId);
      this.logEvent(projectId, "intent.concluded", { intentId, factId });
    });
  }

  failIntent(projectId: ProjectId, intentId: IntentId, reason: string, recordDeadEnd = true, killedBy: Intent["killedBy"] = undefined): void {
    this.transaction(() => {
      const intent = this.requireIntent(projectId, intentId);
      if (intent.status === "failed") {
        throw new Error(`intent already failed: ${intentId}`);
      }
      const wasDone = intent.status === "done";
      intent.status = "failed";
      intent.concludedAt = now();
      intent.failureReason = reason;
      intent.killedBy = killedBy;
      intent.lease = undefined;

      if (recordDeadEnd) {
        const deadEndsMap = this.state.deadEnds.get(projectId) ?? new Map();
        const hash = routeHash(intent.description);
        deadEndsMap.set(hash, { intentId, description: intent.description, reason });
        this.state.deadEnds.set(projectId, deadEndsMap);
      }

      if (!wasDone) {
        this.bumpStep(projectId);
        this.bumpStagnation(projectId);
      }
      this.logEvent(projectId, "intent.failed", { intentId, reason, recordDeadEnd, killedBy, wasDone });
    });
  }

  chainIntent(projectId: ProjectId, intentId: IntentId, chain: ChainRequest): IntentId[] {
    return this.transaction(() => {
      const intent = this.requireIntent(projectId, intentId);
      if (intent.status !== "claimed") {
        throw new Error(`can only chain a claimed intent: ${intentId} (status=${intent.status})`);
      }
      const subIds: IntentId[] = [];
      for (const spec of chain.subIntents) {
        const sub = this.addIntent(projectId, {
          description: spec.description,
          creator: "workflow",
          parentIntentId: intentId,
          parentFactIds: intent.parentFactIds,
          priority: spec.priority ?? intent.priority,
        });
        subIds.push(sub.id);
      }
      intent.status = "chained";
      intent.chain = {
        reason: chain.reason,
        subIntentIds: subIds,
        waitMode: chain.waitMode,
        createdAt: now(),
      };
      this.logEvent(projectId, "intent.chained", { intentId, subIntentIds: subIds, reason: chain.reason });
      return subIds;
    });
  }

  resumeChainedIntent(projectId: ProjectId, intentId: IntentId): void {
    this.transaction(() => {
      const intent = this.requireIntent(projectId, intentId);
      if (intent.status !== "chained") {
        throw new Error(`can only resume a chained intent: ${intentId} (status=${intent.status})`);
      }
      intent.status = "open";
      this.logEvent(projectId, "intent.resumed", { intentId });
    });
  }

  isDeadEnd(projectId: ProjectId, description: string): boolean {
    const hash = routeHash(description);
    return this.state.deadEnds.get(projectId)?.has(hash) ?? false;
  }

  sweepExpiredLeases(): number {
    let swept = 0;
    const nowIso = now();
    for (const [projectId, intentsMap] of this.state.intents) {
      for (const intent of intentsMap.values()) {
        if (intent.status === "claimed" && intent.lease && intent.lease.expiresAt < nowIso) {
          intent.status = "open";
          intent.lease = undefined;
          swept += 1;
          this.logEvent(projectId, "intent.lease_expired", { intentId: intent.id });
        }
      }
    }
    return swept;
  }

  // ─── Hint ───

  addHint(projectId: ProjectId, input: HintInput): Hint {
    return this.transaction(() => {
      const hintsMap = this.requireHints(projectId);
      const counter = this.state.hintCounters.get(projectId)! + 1;
      this.state.hintCounters.set(projectId, counter);
      const id = `h${String(counter).padStart(3, "0")}`;
      const hint: Hint = {
        id,
        projectId,
        content: input.content,
        creator: input.creator,
        kind: input.kind ?? "direction",
        targetIntentId: input.targetIntentId,
        createdAt: now(),
        expiresAt: input.expiresAt,
      };
      hintsMap.set(id, hint);
      this.logEvent(projectId, "hint.created", { hintId: id, creator: input.creator, kind: hint.kind });
      return hint;
    });
  }

  unconsumedHints(projectId: ProjectId): Hint[] {
    const all = [...(this.state.hints.get(projectId)?.values() ?? [])];
    const nowIso = now();
    return all.filter((h) => !h.consumedAt && (!h.expiresAt || h.expiresAt > nowIso));
  }

  consumeHint(projectId: ProjectId, hintId: HintId): void {
    this.transaction(() => {
      const hint = this.state.hints.get(projectId)?.get(hintId);
      if (!hint) throw new Error(`hint not found: ${hintId}`);
      hint.consumedAt = now();
      this.logEvent(projectId, "hint.consumed", { hintId });
    });
  }

  // ─── Directive ───

  addDirective(projectId: ProjectId, input: DirectiveInput): Directive {
    return this.transaction(() => {
      const dirMap = this.requireDirectives(projectId);
      const counter = this.state.directiveCounters.get(projectId)! + 1;
      this.state.directiveCounters.set(projectId, counter);
      const id = `d${String(counter).padStart(3, "0")}`;
      const dir: Directive = {
        id,
        projectId,
        kind: input.kind,
        payload: input.payload,
        createdAt: now(),
      };
      dirMap.set(id, dir);
      this.logEvent(projectId, "directive.created", { directiveId: id, kind: input.kind });
      return dir;
    });
  }

  unconsumedDirectives(projectId: ProjectId): Directive[] {
    const all = [...(this.state.directives.get(projectId)?.values() ?? [])];
    return all.filter((d) => !d.consumedAt);
  }

  consumeDirective(projectId: ProjectId, directiveId: DirectiveId): void {
    this.transaction(() => {
      const dir = this.state.directives.get(projectId)?.get(directiveId);
      if (!dir) throw new Error(`directive not found: ${directiveId}`);
      dir.consumedAt = now();
      this.logEvent(projectId, "directive.consumed", { directiveId });
    });
  }

  // ─── Link ───

  addLink(projectId: ProjectId, input: LinkInput): Link {
    return this.transaction(() => {
      const linksMap = this.requireLinks(projectId);
      const counter = this.state.linkCounters.get(projectId)! + 1;
      this.state.linkCounters.set(projectId, counter);
      const id = `l${String(counter).padStart(3, "0")}`;
      const link: Link = {
        id,
        projectId,
        fromFactId: input.fromFactId,
        toFactId: input.toFactId,
        kind: input.kind,
        evidence: input.evidence ?? [],
        createdAt: now(),
      };
      linksMap.set(id, link);
      this.logEvent(projectId, "link.created", {
        linkId: id,
        from: input.fromFactId,
        to: input.toFactId,
        kind: input.kind,
      });
      return link;
    });
  }

  links(projectId: ProjectId): Link[] {
    return [...(this.state.links.get(projectId)?.values() ?? [])];
  }

  // ─── SubagentRun ───

  createSubagentRun(projectId: ProjectId, input: SubagentRunInput): SubagentRun {
    return this.transaction(() => {
      this.requireProject(projectId);
      const runsMap = this.ensureMap(this.state.runs, projectId);
      const id = newRunId();
      const ts = now();
      const run: SubagentRun = {
        id,
        projectId,
        profileId: input.profileId,
        role: input.role,
        workerName: input.workerName,
        status: "pending",
        intentId: input.intentId,
        factId: input.factId,
        parentRunId: input.parentRunId,
        inputSummary: input.inputSummary,
        rotateOf: input.rotateOf,
        usedDelta: input.usedDelta,
        createdAt: ts,
      };
      runsMap.set(id, run);
      this.logEvent(projectId, "run.created", {
        runId: id, profileId: input.profileId, role: input.role,
        intentId: input.intentId, rotateOf: input.rotateOf,
      });
      return run;
    });
  }

  updateSubagentRun(
    projectId: ProjectId,
    runId: RunId,
    patch: Partial<Pick<SubagentRun,
      "status" | "outputSummary" | "errorMessage" | "factId" | "startedAt" | "finishedAt"
      | "usedDelta" | "inputTokens" | "outputTokens">>,
  ): void {
    this.transaction(() => {
      const runsMap = this.state.runs.get(projectId);
      const run = runsMap?.get(runId);
      if (!run) throw new Error(`subagent run not found: ${runId}`);
      const prev = run.status;
      Object.assign(run, patch);
      if (patch.status === "running" && !run.startedAt) run.startedAt = now();
      if (isTerminal(run.status) && !run.finishedAt) run.finishedAt = now();
      this.logEvent(projectId, "run.updated", {
        runId, prevStatus: prev, status: run.status,
        outputSummary: patch.outputSummary, errorMessage: patch.errorMessage,
      });
    });
  }

  getSubagentRun(projectId: ProjectId, runId: RunId): SubagentRun | undefined {
    return this.state.runs.get(projectId)?.get(runId);
  }

  subagentRuns(projectId: ProjectId, filter?: { profileId?: string; status?: RunStatus }): SubagentRun[] {
    const all = [...(this.state.runs.get(projectId)?.values() ?? [])];
    if (!filter) return all;
    return all.filter((r) =>
      (filter.profileId === undefined || r.profileId === filter.profileId) &&
      (filter.status === undefined || r.status === filter.status),
    );
  }

  // ─── Event ───

  logEvent(projectId: ProjectId, type: string, payload: Record<string, unknown> = {}): GraphEvent {
    const events = this.state.events.get(projectId) ?? [];
    const seq = (this.state.seqCounters.get(projectId) ?? 0) + 1;
    this.state.seqCounters.set(projectId, seq);
    const event: GraphEvent = { seq, projectId, type, payload, timestamp: now() };
    events.push(event);
    this.state.events.set(projectId, events);
    return event;
  }

  events(projectId: ProjectId, sinceSeq?: number, limit = 1000): GraphEvent[] {
    const all = this.state.events.get(projectId) ?? [];
    const filtered = sinceSeq !== undefined ? all.filter((e) => e.seq > sinceSeq) : all;
    return filtered.slice(-limit);
  }

  // ─── Progress ───

  progress(projectId: ProjectId): Progress {
    const facts = this.facts(projectId);
    const intents = this.intents(projectId);
    const events = this.events(projectId);
    const stepsExecuted = this.state.stepCounters.get(projectId) ?? 0;
    const lastActivityAt = events.length > 0
      ? events[events.length - 1].timestamp
      : this.state.projects.get(projectId)?.createdAt ?? now();

    return {
      totalFacts: facts.length,
      acceptedFacts: facts.filter((f) => f.status === "accepted").length,
      candidateFacts: facts.filter((f) => f.status === "candidate").length,
      rejectedFacts: facts.filter((f) => f.status === "rejected").length,
      blockedFacts: facts.filter((f) => f.status === "blocked").length,
      openIntents: intents.filter((i) => i.status === "open").length,
      claimedIntents: intents.filter((i) => i.status === "claimed").length,
      chainedIntents: intents.filter((i) => i.status === "chained").length,
      stepsExecuted,
      lastActivityAt,
      stagnationLevel: this.state.stagnationCounters.get(projectId) ?? 0,
    };
  }

  // ─── Transaction ───

  transaction<T>(fn: () => T): T {
    const isOuter = !this.inTx;
    if (isOuter) {
      this.inTx = true;
      this.txSnapshot = this.cloneState();
    }
    try {
      return fn();
    } catch (err) {
      if (isOuter) {
        this.state = this.txSnapshot!;
        this.txSnapshot = undefined;
      }
      throw err;
    } finally {
      if (isOuter) {
        this.inTx = false;
        this.txSnapshot = undefined;
      }
    }
  }

  // ─── Internals ───

  private cloneState(): InMemoryState {
    return structuredClone(this.state);
  }

  private bumpStep(projectId: ProjectId): void {
    const cur = this.state.stepCounters.get(projectId) ?? 0;
    this.state.stepCounters.set(projectId, cur + 1);
  }

  private bumpStagnation(projectId: ProjectId): void {
    const cur = this.state.stagnationCounters.get(projectId) ?? 0;
    this.state.stagnationCounters.set(projectId, cur + 1);
  }

  private findProject(idOrSession: string): Project | undefined {
    for (const p of this.state.projects.values()) {
      if (p.id === idOrSession || p.session === idOrSession) return p;
    }
    return undefined;
  }

  private requireProject(projectId: ProjectId): Project {
    const p = this.state.projects.get(projectId);
    if (!p) throw new Error(`project not found: ${projectId}`);
    return p;
  }

  private requireFacts(projectId: ProjectId): Map<FactId, Fact> {
    this.requireProject(projectId);
    return this.ensureMap(this.state.facts, projectId);
  }

  private requireIntents(projectId: ProjectId): Map<IntentId, Intent> {
    this.requireProject(projectId);
    return this.ensureMap(this.state.intents, projectId);
  }

  private requireIntent(projectId: ProjectId, intentId: IntentId): Intent {
    const m = this.requireIntents(projectId);
    const i = m.get(intentId);
    if (!i) throw new Error(`intent not found: ${intentId}`);
    return i;
  }

  private requireHints(projectId: ProjectId): Map<HintId, Hint> {
    this.requireProject(projectId);
    return this.ensureMap(this.state.hints, projectId);
  }

  private requireDirectives(projectId: ProjectId): Map<DirectiveId, Directive> {
    this.requireProject(projectId);
    return this.ensureMap(this.state.directives, projectId);
  }

  private requireLinks(projectId: ProjectId): Map<LinkId, Link> {
    this.requireProject(projectId);
    return this.ensureMap(this.state.links, projectId);
  }

  private ensureMap<K, V>(root: Map<ProjectId, Map<K, V>>, projectId: ProjectId): Map<K, V> {
    let m = root.get(projectId);
    if (!m) {
      m = new Map();
      root.set(projectId, m);
    }
    return m;
  }
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

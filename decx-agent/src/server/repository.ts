import type { DatabaseSync } from "node:sqlite";
import { scanArtifacts } from "../core/sdk.js";
import type {
  AgentPhase,
  ArtifactInfo,
  Fact,
  Hint,
  Intent,
  Review,
  TaskConfig,
  WorkerName,
  WorkerRun,
  WorkflowEvent,
} from "../core/types.js";
import {
  artifactFromRow,
  eventFromRow,
  factFromRow,
  hintFromRow,
  intentFromRow,
  projectFromRow,
  reviewFromRow,
  utcnow,
  workerRunFromRow,
} from "./repository-rows.js";
import type { ProjectDetail, ProjectRecord } from "./repository-types.js";
import { WorkflowGraphRepository } from "./workflow-graph.js";

export { utcnow } from "./repository-rows.js";

export class AgentRepository {
  private readonly graph: WorkflowGraphRepository;

  constructor(private readonly db: DatabaseSync) {
    this.graph = new WorkflowGraphRepository(db);
  }

  createProject(input: {
    session: string;
    name: string;
    target: string;
    goal: string;
    worker: WorkerName;
    sessionDir: string;
    artifactDir: string;
    configPath: string;
    taskConfig: TaskConfig;
  }): ProjectDetail {
    const existing = this.findProject(input.session);
    if (existing) return existing;

    const now = utcnow();
    const id = `proj_${Date.now()}`;
    this.db.prepare(`
      INSERT INTO projects (id, session, name, target, goal, status, worker, session_dir, artifact_dir, config_path, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.session, input.name, input.target, input.goal, input.worker, input.sessionDir, input.artifactDir, input.configPath, JSON.stringify(input.taskConfig), now, now);
    this.graph.node(id, "project", id, input.name, { session: input.session });
    this.addFact(id, { id: "origin", description: input.target, evidence: [], source: "system", createdAt: now });
    this.addFact(id, { id: "goal", description: input.goal, evidence: [], source: "system", createdAt: now });
    return this.getProject(id);
  }

  listProjects(): ProjectRecord[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY created_at").all().map(projectFromRow);
  }

  findProject(idOrSession: string): ProjectDetail | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ? OR session = ?").get(idOrSession, idOrSession);
    return row ? this.getProject(String(row.id)) : undefined;
  }

  getProject(idOrSession: string): ProjectDetail {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ? OR session = ?").get(idOrSession, idOrSession);
    if (!row) throw new Error(`project not found: ${idOrSession}`);
    const project = projectFromRow(row);
    return {
      project,
      facts: this.facts(project.id),
      intents: this.intents(project.id),
      hints: this.hints(project.id),
      events: this.events(project.id),
      reviews: this.reviews(project.id),
      artifacts: this.artifacts(project.id),
      workerRuns: this.workerRuns(project.id),
      workflowNodes: this.graph.nodes(project.id),
      workflowEdges: this.graph.edges(project.id),
    };
  }

  updateProjectStatus(projectId: string, status: ProjectRecord["status"]): void {
    this.db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(status, utcnow(), projectId);
    const projectNode = this.graph.node(projectId, "project", projectId, projectId);
    const statusNode = this.graph.node(projectId, "status_change", `${status}:${Date.now()}`, status);
    this.graph.edge(projectId, projectNode, statusNode, "changes_status");
  }

  touchProject(projectId: string): void {
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(utcnow(), projectId);
  }

  addFact(projectId: string, fact: Fact): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO facts (id, project_id, description, evidence_json, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(fact.id, projectId, fact.description, JSON.stringify(fact.evidence), fact.source, fact.createdAt);
    this.graph.node(projectId, "fact", fact.id, fact.description, { source: fact.source });
  }

  addIntent(projectId: string, input: {
    from: string[];
    description: string;
    creator: string;
    role: string;
    worker?: WorkerName;
    promptText?: string;
    fromEvents?: string[];
  }): Intent {
    const now = utcnow();
    const intent: Intent = {
      id: this.nextId("intents", projectId, "i"),
      from: input.from,
      description: input.description,
      creator: input.creator,
      role: input.role,
      worker: input.worker,
      promptText: input.promptText,
      fromEvents: input.fromEvents,
      status: "open",
      createdAt: now,
    };
    this.db.prepare(`
      INSERT INTO intents (id, project_id, from_json, description, creator, role, worker, status, prompt_text, from_events_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `).run(intent.id, projectId, JSON.stringify(intent.from), intent.description, intent.creator, intent.role, intent.worker ?? null, intent.promptText ?? null, JSON.stringify(intent.fromEvents ?? []), now);
    const intentNode = this.graph.node(projectId, "intent", intent.id, intent.description, { role: intent.role, creator: intent.creator });
    for (const factId of intent.from) {
      this.graph.edge(projectId, this.graph.node(projectId, "fact", factId, factId), intentNode, "originates_from");
    }
    for (const eventId of intent.fromEvents ?? []) {
      this.graph.edge(projectId, this.graph.node(projectId, "event", eventId, eventId), intentNode, "creates");
    }
    return intent;
  }

  setIntentWorking(projectId: string, intentId: string, worker: WorkerName): void {
    this.db.prepare("UPDATE intents SET status = 'working', worker = ? WHERE project_id = ? AND id = ?").run(worker, projectId, intentId);
  }

  claimIntent(projectId: string, intentId: string, worker: WorkerName): Intent {
    this.db.prepare("UPDATE intents SET status = 'working', worker = ? WHERE project_id = ? AND id = ? AND status = 'open'").run(worker, projectId, intentId);
    const intent = this.intents(projectId).find((item) => item.id === intentId);
    if (!intent) throw new Error(`intent not found: ${intentId}`);
    return intent;
  }

  releaseIntent(projectId: string, intentId: string, worker?: WorkerName): Intent {
    const current = this.intents(projectId).find((item) => item.id === intentId);
    if (!current) throw new Error(`intent not found: ${intentId}`);
    if (current.status === "working" && (!worker || current.worker === worker)) {
      this.db.prepare("UPDATE intents SET status = 'open', worker = NULL WHERE project_id = ? AND id = ?").run(projectId, intentId);
    }
    return this.intents(projectId).find((item) => item.id === intentId) ?? current;
  }

  concludeIntent(projectId: string, intentId: string, description: string, evidence: string[], source: string): Fact {
    const now = utcnow();
    const fact: Fact = { id: this.nextId("facts", projectId, "f"), description, evidence, source, createdAt: now };
    this.addFact(projectId, fact);
    this.db.prepare("UPDATE intents SET status = 'done', to_fact_id = ?, concluded_at = ? WHERE project_id = ? AND id = ?").run(fact.id, now, projectId, intentId);
    this.graph.edge(projectId, this.graph.node(projectId, "intent", intentId, intentId), this.graph.node(projectId, "fact", fact.id, fact.description), "concludes_to");
    return fact;
  }

  failIntent(projectId: string, intentId: string): void {
    this.db.prepare("UPDATE intents SET status = 'failed', concluded_at = ? WHERE project_id = ? AND id = ?").run(utcnow(), projectId, intentId);
  }

  addHint(projectId: string, content: string, creator = "human"): Hint {
    const now = utcnow();
    const hint: Hint = { id: this.nextId("hints", projectId, "h"), content, creator, createdAt: now };
    this.db.prepare("INSERT INTO hints (id, project_id, content, creator, created_at) VALUES (?, ?, ?, ?, ?)").run(hint.id, projectId, hint.content, hint.creator, now);
    return hint;
  }

  addEvents(projectId: string, events: Array<Omit<WorkflowEvent, "id" | "createdAt">>, createdAt = utcnow()): WorkflowEvent[] {
    const created: WorkflowEvent[] = [];
    for (const event of events) {
      const item: WorkflowEvent = { ...event, id: this.nextId("events", projectId, "e"), createdAt };
      this.db.prepare(`
        INSERT INTO events (id, project_id, type, severity, source, sink, category, artifact, data_json, worker, phase, intent_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(item.id, projectId, item.type, item.severity ?? null, item.source ?? null, item.sink ?? null, item.category ?? null, item.artifact ?? null, item.data ? JSON.stringify(item.data) : null, item.worker, item.phase, item.intentId ?? null, item.createdAt);
      const eventNode = this.graph.node(projectId, "event", item.id, item.type, { severity: item.severity, phase: item.phase });
      if (item.intentId) this.graph.edge(projectId, this.graph.node(projectId, "intent", item.intentId, item.intentId), eventNode, "emits");
      created.push(item);
    }
    return created;
  }

  addReview(projectId: string, review: Omit<Review, "id" | "projectId" | "createdAt">): Review {
    const item: Review = { ...review, id: this.nextId("reviews", projectId, "rv"), projectId, createdAt: utcnow() };
    this.db.prepare("INSERT INTO reviews (id, project_id, worker, summary, severity, events_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(item.id, projectId, item.worker, item.summary, item.severity ?? null, JSON.stringify(item.events), item.createdAt);
    const reviewNode = this.graph.node(projectId, "review", item.id, item.summary, { severity: item.severity });
    for (const event of item.events) this.graph.edge(projectId, this.graph.node(projectId, "event", event.id, event.type), reviewNode, "reviews");
    return item;
  }

  addWorkerRun(projectId: string, run: WorkerRun & { role: string }): void {
    this.db.prepare(`
      INSERT INTO worker_runs (project_id, worker, role, phase, intent_id, returncode, stdout_preview, stderr_preview, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, run.worker, run.role, run.phase, run.intentId ?? null, run.returncode, run.stdoutPreview, run.stderrPreview, run.startedAt, run.completedAt);
    const runNode = this.graph.node(projectId, "worker_run", `${run.startedAt}:${run.worker}:${run.phase}`, `${run.phase}/${run.worker}`, { role: run.role, returncode: run.returncode });
    if (run.intentId) this.graph.edge(projectId, this.graph.node(projectId, "intent", run.intentId, run.intentId), runNode, "dispatches");
  }

  refreshArtifacts(projectId: string, artifactDir: string): ArtifactInfo[] {
    const artifacts = scanArtifacts(artifactDir);
    const now = utcnow();
    this.db.prepare("DELETE FROM artifacts WHERE project_id = ?").run(projectId);
    for (const artifact of artifacts) {
      this.db.prepare(`
        INSERT INTO artifacts (path, project_id, file_name, kind, scope, source_id, sink_id, flow_sig, decx_session, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(artifact.path, projectId, artifact.fileName, artifact.kind, artifact.scope, artifact.sourceId, artifact.sinkId, artifact.flowSig, artifact.decxSession, now);
      this.graph.node(projectId, "artifact", artifact.path, artifact.fileName, { kind: artifact.kind, scope: artifact.scope });
    }
    return artifacts;
  }

  hasWorkflowFire(projectId: string, ruleId: string, eventId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM workflow_fires WHERE project_id = ? AND rule_id = ? AND event_id = ?").get(projectId, ruleId, eventId));
  }

  markWorkflowFire(projectId: string, ruleId: string, eventId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO workflow_fires (project_id, rule_id, event_id, created_at) VALUES (?, ?, ?, ?)").run(projectId, ruleId, eventId, utcnow());
    this.graph.edge(projectId, this.graph.node(projectId, "event", eventId, eventId), this.graph.node(projectId, "workflow_rule", ruleId, ruleId), "fires_rule");
  }

  private facts(projectId: string): Fact[] {
    return this.db.prepare("SELECT * FROM facts WHERE project_id = ? ORDER BY created_at, id").all(projectId).map(factFromRow);
  }

  private intents(projectId: string): Intent[] {
    return this.db.prepare("SELECT * FROM intents WHERE project_id = ? ORDER BY created_at, id").all(projectId).map(intentFromRow);
  }

  private hints(projectId: string): Hint[] {
    return this.db.prepare("SELECT * FROM hints WHERE project_id = ? ORDER BY created_at, id").all(projectId).map(hintFromRow);
  }

  private events(projectId: string): WorkflowEvent[] {
    return this.db.prepare("SELECT * FROM events WHERE project_id = ? ORDER BY created_at, id").all(projectId).map(eventFromRow);
  }

  private reviews(projectId: string): Review[] {
    return this.db.prepare("SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at, id").all(projectId).map(reviewFromRow);
  }

  private artifacts(projectId: string): ArtifactInfo[] {
    return this.db.prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY file_name").all(projectId).map(artifactFromRow);
  }

  private workerRuns(projectId: string): WorkerRun[] {
    return this.db.prepare("SELECT * FROM worker_runs WHERE project_id = ? ORDER BY id").all(projectId).map(workerRunFromRow);
  }

  lastReview(projectId: string): Review | undefined {
    const row = this.db.prepare("SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(projectId);
    return row ? reviewFromRow(row) : undefined;
  }

  private nextId(table: string, projectId: string, prefix: string): string {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ? AND id LIKE ?`).get(projectId, `${prefix}%`);
    return `${prefix}${String(Number(row?.count ?? 0) + 1).padStart(3, "0")}`;
  }
}

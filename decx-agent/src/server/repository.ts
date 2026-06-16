import type { DatabaseSync } from "node:sqlite";
import type {
  AgentConfig,
  Fact,
  Intent,
  Link,
  ProjectDetail,
  ProjectRecord,
  Run,
  TaskConfig,
  WorkerName,
  WorkflowEvent,
} from "../core/types.js";
import { parseJson, utcnow } from "../core/utils.js";

/**
 * AgentRepository — the single source of truth for agent state.
 *
 * Design: the graph IS the storage. Facts are nodes. Intents are multi-source
 * directed edges (via intent_sources). Links are directed reasoning dependencies.
 * No dual-write, no audit shadow tables. Every table here is read by the
 * dispatcher hot path or surfaced via the API.
 */
export class AgentRepository {
  constructor(private readonly db: DatabaseSync) {}

  // ─── Project lifecycle ───

  createProject(input: {
    session: string;
    name: string;
    target: string;
    goal: string;
    worker: WorkerName;
    sessionDir: string;
    configPath: string;
    taskConfig: TaskConfig;
  }): ProjectDetail {
    const existing = this.findProject(input.session);
    if (existing) return existing;

    const now = utcnow();
    const id = `proj_${Date.now()}`;
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO projects (id, session, name, target, goal, status, worker, session_dir, config_path, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      `).run(id, input.session, input.name, input.target, input.goal, input.worker, input.sessionDir, input.configPath, JSON.stringify(input.taskConfig), now, now);
      this.addFact(id, { id: "origin", description: input.target, evidence: [], source: "system", confidence: 1.0, createdAt: now });
      this.addFact(id, { id: "goal", description: input.goal, evidence: [], source: "system", confidence: 1.0, createdAt: now });
    });
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
      links: this.links(project.id),
      runs: this.runs(project.id),
    };
  }

  updateProjectStatus(projectId: string, status: ProjectRecord["status"]): void {
    const now = utcnow();
    const result = this.db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(status, now, projectId);
    if (Number(result.changes ?? 0) === 0) throw new Error(`project not found: ${projectId}`);
  }

  touchProject(projectId: string): void {
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(utcnow(), projectId);
  }

  touchReview(projectId: string): void {
    const now = utcnow();
    this.db.prepare("UPDATE projects SET last_review_at = ?, updated_at = ? WHERE id = ?").run(now, now, projectId);
  }

  // ─── Facts (observation nodes) ───

  addFact(projectId: string, fact: Fact): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO facts (id, project_id, description, evidence_json, source, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(fact.id, projectId, fact.description, JSON.stringify(fact.evidence), fact.source, fact.confidence, fact.createdAt);
  }

  // ─── Intents (work units / directed edges) ───

  addIntent(projectId: string, input: {
    from: string[];
    description: string;
    creator: string;
    role?: string;
    worker?: WorkerName;
    priority?: number;
    promptText?: string;
  }): Intent {
    const now = utcnow();
    const intent: Intent = {
      id: this.nextId("intents", projectId, "i"),
      fromFacts: input.from,
      description: input.description,
      creator: input.creator,
      role: input.role,
      worker: input.worker,
      promptText: input.promptText,
      status: "open",
      priority: input.priority ?? 0,
      createdAt: now,
    };
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO intents (id, project_id, description, creator, role, worker, prompt_text, status, priority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      `).run(intent.id, projectId, intent.description, intent.creator, intent.role ?? null, intent.worker ?? null, intent.promptText ?? null, intent.priority, now);
      for (const factId of input.from) {
        this.db.prepare("INSERT OR IGNORE INTO intent_sources (project_id, intent_id, fact_id) VALUES (?, ?, ?)")
          .run(projectId, intent.id, factId);
      }
    });
    return intent;
  }

  claimIntent(projectId: string, intentId: string, worker: WorkerName): Intent {
    const current = this.intent(projectId, intentId);
    if (!current) throw new Error(`intent not found: ${intentId}`);
    if (current.status !== "open") throw new Error(`intent is not open: ${intentId}`);
    const now = utcnow();
    const result = this.db.prepare(`
      UPDATE intents
      SET status = 'working', worker = ?, claimed_by = ?, claimed_at = ?
      WHERE project_id = ? AND id = ? AND status = 'open'
    `).run(worker, worker, now, projectId, intentId);
    if (Number(result.changes ?? 0) === 0) throw new Error(`intent is not open: ${intentId}`);
    return this.intent(projectId, intentId) ?? current;
  }

  releaseIntent(projectId: string, intentId: string, worker?: WorkerName): Intent {
    const current = this.intents(projectId).find((item) => item.id === intentId);
    if (!current) throw new Error(`intent not found: ${intentId}`);
    if (current.status === "working" && (!worker || current.worker === worker)) {
      this.db.prepare("UPDATE intents SET status = 'open', worker = NULL WHERE project_id = ? AND id = ?").run(projectId, intentId);
    }
    return this.intents(projectId).find((item) => item.id === intentId) ?? current;
  }

  concludeIntent(projectId: string, intentId: string, description: string, evidence: string[], source: string, confidence = 1.0): Fact {
    const now = utcnow();
    const current = this.intent(projectId, intentId);
    if (!current) throw new Error(`intent not found: ${intentId}`);
    if (current.status === "done" || current.status === "failed") throw new Error(`intent is already closed: ${intentId}`);
    const fact: Fact = { id: this.nextId("facts", projectId, "f"), description, evidence, source, confidence, createdAt: now };
    this.transaction(() => {
      this.addFact(projectId, fact);
      const result = this.db.prepare(`
        UPDATE intents
        SET status = 'done', to_fact_id = ?, concluded_at = ?
        WHERE project_id = ? AND id = ? AND status != 'done' AND status != 'failed'
      `).run(fact.id, now, projectId, intentId);
      if (Number(result.changes ?? 0) === 0) throw new Error(`intent is already closed: ${intentId}`);
    });
    return fact;
  }

  failIntent(projectId: string, intentId: string, reason = "intent failed"): void {
    const current = this.intent(projectId, intentId);
    if (!current) throw new Error(`intent not found: ${intentId}`);
    const now = utcnow();
    this.db.prepare(`
      UPDATE intents
      SET status = 'failed', concluded_at = ?, failure_reason = ?
      WHERE project_id = ? AND id = ? AND status != 'done' AND status != 'failed'
    `).run(now, reason, projectId, intentId);
  }

  // ─── Links (directed reasoning dependencies) ───

  addLink(projectId: string, input: {
    fromFactId: string;
    toFactId: string;
    kind: string;
    evidence?: string[];
  }): Link {
    this.assertAcyclicReasoningEdge(projectId, input.fromFactId, input.toFactId);
    const now = utcnow();
    const link: Link = {
      id: this.nextId("links", projectId, "l"),
      projectId,
      fromFactId: input.fromFactId,
      toFactId: input.toFactId,
      kind: input.kind,
      evidence: input.evidence ?? [],
      createdAt: now,
    };
    this.db.prepare(`
      INSERT INTO links (id, project_id, from_fact_id, to_fact_id, kind, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(link.id, projectId, link.fromFactId, link.toFactId, link.kind, JSON.stringify(link.evidence), now);
    return link;
  }

  links(projectId: string): Link[] {
    return this.db.prepare("SELECT * FROM links WHERE project_id = ? ORDER BY created_at, id")
      .all(projectId).map(linkFromRow);
  }

  // ─── Runs (worker execution records) ───

  addRun(projectId: string, run: Run & { id?: number }): void {
    this.db.prepare(`
      INSERT INTO runs (project_id, worker, role, phase, intent_id, returncode, stdout_preview, stderr_preview, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, run.worker, run.role, run.phase, run.intentId ?? null, run.returncode, run.stdoutPreview, run.stderrPreview, run.startedAt, run.completedAt);
  }

  // ─── Graph traversal (recursive CTE) ───

  /**
   * Trace the proof chain backwards from a fact through intent_sources and links.
   * Returns facts ordered by depth (deepest first). Max depth 30 to bound recursion.
   */
  proofChain(projectId: string, factId: string, maxDepth = 30): Array<{ fact: Fact; depth: number; path: string[] }> {
    const rows = this.db.prepare(`
      WITH RECURSIVE chain(fact_id, depth, path) AS (
        SELECT ?, 0, ?
        UNION ALL
        SELECT s.fact_id, c.depth + 1, c.path || ',' || s.fact_id
        FROM intent_sources s
        JOIN intents i ON i.project_id = s.project_id AND i.id = s.intent_id
        JOIN chain c ON c.fact_id = i.to_fact_id
        WHERE i.project_id = ? AND i.status = 'done' AND c.depth < ?
        UNION ALL
        SELECT l.from_fact_id, c.depth + 1, c.path || ',' || l.from_fact_id
        FROM links l
        JOIN chain c ON c.fact_id = l.to_fact_id
        WHERE l.project_id = ? AND c.depth < ?
      )
      SELECT f.id, f.project_id, f.description, f.evidence_json, f.source, f.confidence, f.created_at,
             chain.depth, chain.path
      FROM facts f
      JOIN chain ON f.id = chain.fact_id
      WHERE f.project_id = ?
      GROUP BY f.id
      ORDER BY chain.depth DESC
    `).all(factId, factId, projectId, maxDepth, projectId, maxDepth, projectId);
    return rows.map((row) => ({
      fact: factFromRow(row),
      depth: Number(row.depth),
      path: String(row.path).split(","),
    }));
  }

  /**
   * All facts reachable downstream from a fact (forward direction).
   */
  descendants(projectId: string, factId: string, maxDepth = 30): Fact[] {
    const rows = this.db.prepare(`
      WITH RECURSIVE downstream(fact_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT i.to_fact_id, d.depth + 1
        FROM intents i
        JOIN intent_sources s ON s.project_id = i.project_id AND s.intent_id = i.id
        JOIN downstream d ON d.fact_id = s.fact_id
        WHERE i.project_id = ? AND i.status = 'done' AND i.to_fact_id IS NOT NULL AND d.depth < ?
        UNION ALL
        SELECT l.to_fact_id, d.depth + 1
        FROM links l
        JOIN downstream d ON d.fact_id = l.from_fact_id
        WHERE l.project_id = ? AND d.depth < ?
      )
      SELECT DISTINCT f.* FROM facts f
      JOIN downstream d ON f.id = d.fact_id
      WHERE f.project_id = ? AND f.id != ?
      ORDER BY d.depth
    `).all(factId, projectId, maxDepth, projectId, maxDepth, projectId, factId);
    return rows.map(factFromRow);
  }

  // ─── In-memory events (NOT persisted — for workflow rule matching only) ───

  /**
   * Build WorkflowEvent objects in memory. These are used by the dispatcher's
   * rule matcher and then discarded. They are never written to the database.
   */
  emitEvents(projectId: string, events: Array<Omit<WorkflowEvent, "id" | "createdAt">>): WorkflowEvent[] {
    const now = utcnow();
    let counter = 0;
    return events.map((event) => ({
      ...event,
      id: `evt_${projectId}_${now}_${counter++}`,
      createdAt: now,
    }));
  }

  // ─── Private read helpers ───

  private facts(projectId: string): Fact[] {
    return this.db.prepare("SELECT * FROM facts WHERE project_id = ? ORDER BY created_at, id")
      .all(projectId).map(factFromRow);
  }

  private intents(projectId: string): Intent[] {
    const rows = this.db.prepare("SELECT * FROM intents WHERE project_id = ? ORDER BY created_at, id").all(projectId);
    return rows.map((row) => {
      const intent = intentBaseFromRow(row);
      intent.fromFacts = this.intentSources(projectId, intent.id);
      return intent;
    });
  }

  private intent(projectId: string, intentId: string): Intent | undefined {
    const row = this.db.prepare("SELECT * FROM intents WHERE project_id = ? AND id = ?").get(projectId, intentId);
    if (!row) return undefined;
    const intent = intentBaseFromRow(row);
    intent.fromFacts = this.intentSources(projectId, intent.id);
    return intent;
  }

  private intentSources(projectId: string, intentId: string): string[] {
    const rows = this.db.prepare("SELECT fact_id FROM intent_sources WHERE project_id = ? AND intent_id = ? ORDER BY fact_id")
      .all(projectId, intentId);
    return rows.map((row) => String(row.fact_id));
  }

  private runs(projectId: string): Run[] {
    return this.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY id").all(projectId).map(runFromRow);
  }

  private agents(projectId: string): Record<string, AgentConfig> {
    // Agents config lives in task.json now; read from projects.config_json.
    const row = this.db.prepare("SELECT config_json FROM projects WHERE id = ?").get(projectId);
    if (!row) return {};
    const config = parseJson(row.config_json, {}) as TaskConfig;
    return config.agents ?? {};
  }

  private nextId(table: string, projectId: string, prefix: string): string {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ? AND id LIKE ?`).get(projectId, `${prefix}%`);
    return `${prefix}${String(Number(row?.count ?? 0) + 1).padStart(3, "0")}`;
  }

  private assertAcyclicReasoningEdge(projectId: string, fromFactId: string, toFactId: string): void {
    if (fromFactId === toFactId) {
      throw new Error(`reasoning link would create a cycle: ${fromFactId} -> ${toFactId}`);
    }
    if (this.descendants(projectId, toFactId).some((fact) => fact.id === fromFactId)) {
      throw new Error(`reasoning link would create a cycle: ${fromFactId} -> ${toFactId}`);
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

// ─── Row mappers (file-private) ───

function projectFromRow(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    session: String(row.session),
    name: String(row.name),
    target: String(row.target),
    goal: String(row.goal),
    status: String(row.status) as ProjectRecord["status"],
    worker: String(row.worker) as WorkerName,
    sessionDir: String(row.session_dir),
    configPath: String(row.config_path),
    taskConfig: parseJson(row.config_json, {}) as TaskConfig,
    lastReviewAt: row.last_review_at ? String(row.last_review_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function factFromRow(row: Record<string, unknown>): Fact {
  return {
    id: String(row.id),
    description: String(row.description),
    evidence: parseJson(row.evidence_json, []) as string[],
    source: String(row.source),
    confidence: Number(row.confidence ?? 1.0),
    createdAt: String(row.created_at),
  };
}

function intentBaseFromRow(row: Record<string, unknown>): Intent {
  return {
    id: String(row.id),
    fromFacts: [], // populated by caller via intentSources()
    to: row.to_fact_id ? String(row.to_fact_id) : undefined,
    description: String(row.description),
    creator: String(row.creator),
    role: row.role ? String(row.role) : undefined,
    worker: row.worker ? String(row.worker) as WorkerName : undefined,
    promptText: row.prompt_text ? String(row.prompt_text) : undefined,
    status: String(row.status) as Intent["status"],
    priority: Number(row.priority ?? 0),
    claimedBy: row.claimed_by ? String(row.claimed_by) : undefined,
    claimedAt: row.claimed_at ? String(row.claimed_at) : undefined,
    failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
    createdAt: String(row.created_at),
    concludedAt: row.concluded_at ? String(row.concluded_at) : undefined,
  };
}

function linkFromRow(row: Record<string, unknown>): Link {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    fromFactId: String(row.from_fact_id),
    toFactId: String(row.to_fact_id),
    kind: String(row.kind),
    evidence: parseJson(row.evidence_json, []) as string[],
    createdAt: String(row.created_at),
  };
}

function runFromRow(row: Record<string, unknown>): Run {
  return {
    worker: String(row.worker) as WorkerName,
    role: String(row.role),
    phase: String(row.phase) as Run["phase"],
    intentId: row.intent_id ? String(row.intent_id) : undefined,
    returncode: Number(row.returncode),
    stdoutPreview: String(row.stdout_preview),
    stderrPreview: String(row.stderr_preview),
    startedAt: String(row.started_at),
    completedAt: String(row.completed_at),
  };
}

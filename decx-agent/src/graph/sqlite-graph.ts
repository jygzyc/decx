/**
 * SQLite-backed Graph implementation.
 *
 * Persists projects, facts, intents, hints, directives, links, events, counters,
 * leases, and dead-end records for resumable agent runs. It is the production
 * state store used by CLI/runtime sessions.
 */

import { DatabaseSync } from "node:sqlite";
import type {
  ChainRequest, Directive, DirectiveId, DirectiveInput,
  Fact, FactId, FactStatus, GraphEvent, Hint, HintId,
  Intent, IntentId, IntentStatus, ISOTime, Link, LinkId,
  Progress, Project, ProjectId, ProjectStatus, RunId, RunStatus,
  SubagentRun, SubagentRunInput, TaskConfig, Verdict,
} from "../agent/types.js";
import {
  type FactInput, type HintInput, type IntentInput, type LinkInput, type ProjectInput,
  type Graph,
  newProjectId, newRunId, now, routeHash,
} from "./graph.js";

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  session TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  worker TEXT NOT NULL,
  session_dir TEXT NOT NULL,
  config_path TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'candidate',
  parent_intent_id TEXT,
  reviewer_reason TEXT,
  required_conditions_json TEXT NOT NULL DEFAULT '[]',
  step_discovered INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS intents (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  description TEXT NOT NULL,
  creator TEXT NOT NULL,
  parent_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  parent_intent_id TEXT,
  chain_json TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  lease_worker_id TEXT,
  lease_claimed_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  concluded_at TEXT,
  concluded_fact_id TEXT,
  failure_reason TEXT,
  killed_by TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS intent_sources (
  project_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (project_id, intent_id, fact_id)
);

CREATE TABLE IF NOT EXISTS hints (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  creator TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'direction',
  target_intent_id TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS directives (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS links (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  from_fact_id TEXT NOT NULL,
  to_fact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS subagent_runs (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  role TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  intent_id TEXT,
  fact_id TEXT,
  parent_run_id TEXT,
  input_summary TEXT,
  output_summary TEXT,
  error_message TEXT,
  rotate_of TEXT,
  used_delta INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_runs_project_status ON subagent_runs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_project_profile ON subagent_runs(project_id, profile_id);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, seq);

CREATE TABLE IF NOT EXISTS dead_ends (
  route_hash TEXT NOT NULL,
  project_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, route_hash)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class SqliteGraph implements Graph {
  private db: DatabaseSync;
  private inTx = false;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    try {
      this.db.exec("ALTER TABLE facts ADD COLUMN required_conditions_json TEXT NOT NULL DEFAULT '[]'");
    } catch (err) {
      if (!(err instanceof Error) || !/duplicate column name/i.test(err.message)) throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // ─── Project ───

  createProject(input: ProjectInput): Project {
    const existing = this.findProject(input.session);
    if (existing) return existing;

    const id = newProjectId();
    const ts = now();
    const project: Project = {
      id, session: input.session, name: input.name,
      target: input.target, goal: input.goal,
      status: "active", worker: input.worker,
      sessionDir: input.sessionDir, configPath: input.configPath,
      taskConfig: input.taskConfig, createdAt: ts, updatedAt: ts,
    };
    this.transaction(() => {
      this.run(
        `INSERT INTO projects (id, session, name, target, goal, status, worker, session_dir, config_path, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        id, input.session, input.name, input.target, input.goal,
        input.worker, input.sessionDir, input.configPath,
        JSON.stringify(input.taskConfig), ts, ts,
      );
    });
    return project;
  }

  getProject(idOrSession: string): Project | undefined {
    return this.findProject(idOrSession);
  }

  listProjects(status?: ProjectStatus): Project[] {
    const sql = status
      ? "SELECT * FROM projects WHERE status = ? ORDER BY created_at"
      : "SELECT * FROM projects ORDER BY created_at";
    const rows = status ? this.all(sql, status) : this.all(sql);
    return rows.map(projectFromRow);
  }

  updateProjectStatus(id: ProjectId, status: ProjectStatus): void {
    this.transaction(() => {
      this.run("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?", status, now(), id);
      this.logEvent(id, "project.status", { status });
    });
  }

  touchProject(id: ProjectId): void {
    this.run("UPDATE projects SET updated_at = ? WHERE id = ?", now(), id);
  }

  // ─── Fact ───

  addFact(projectId: ProjectId, input: FactInput): Fact {
    return this.transaction(() => {
      const counter = this.nextId(projectId, "facts", "f");
      const id = `f${String(counter).padStart(3, "0")}`;
      const ts = now();
      const stepRow = this.get("SELECT value FROM meta WHERE key = ?", `steps:${projectId}`);
      const stepDiscovered = Number(stepRow?.value ?? 0);
      const fact: Fact = {
        id, projectId, description: input.description,
        evidence: input.evidence ?? [], source: input.source,
        confidence: input.confidence ?? 1.0, status: "candidate",
        parentIntentId: input.parentIntentId, stepDiscovered, createdAt: ts,
      };
      this.run(
        `INSERT INTO facts (id, project_id, description, evidence_json, source, confidence, status, parent_intent_id, step_discovered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`,
        id, projectId, fact.description, JSON.stringify(fact.evidence),
        fact.source, fact.confidence, input.parentIntentId ?? null, stepDiscovered, ts,
      );
      this.logEvent(projectId, "fact.created", { factId: id, source: fact.source, description: fact.description, confidence: fact.confidence });
      return fact;
    });
  }

  getFact(projectId: ProjectId, factId: FactId): Fact | undefined {
    const row = this.get("SELECT * FROM facts WHERE project_id = ? AND id = ?", projectId, factId);
    return row ? factFromRow(row) : undefined;
  }

  facts(projectId: ProjectId, status?: FactStatus): Fact[] {
    const rows = status
      ? this.all("SELECT * FROM facts WHERE project_id = ? AND status = ? ORDER BY created_at, id", projectId, status)
      : this.all("SELECT * FROM facts WHERE project_id = ? ORDER BY created_at, id", projectId);
    return rows.map(factFromRow);
  }

  pendingCandidates(projectId: ProjectId): Fact[] {
    return this.facts(projectId, "candidate");
  }

  resolveFact(projectId: ProjectId, factId: FactId, verdict: Verdict): void {
    this.transaction(() => {
      const fact = this.get("SELECT * FROM facts WHERE project_id = ? AND id = ?", projectId, factId);
      if (!fact) throw new Error(`fact not found: ${factId}`);
      if (fact.status !== "candidate" && fact.status !== "blocked") throw new Error(`fact is not resolvable: ${factId}`);
      const newStatus = verdict.decision === "reject" ? "rejected" : verdict.decision === "block" ? "blocked" : "accepted";
      const newConf = verdict.confidence !== undefined
        ? verdict.confidence
        : verdict.decision === "block"
          ? Math.min(Number(fact.confidence), 0.35)
          : fact.confidence;
      this.run(
        "UPDATE facts SET status = ?, confidence = ?, reviewer_reason = ?, required_conditions_json = ? WHERE project_id = ? AND id = ?",
        newStatus, newConf, verdict.reason, JSON.stringify(verdict.requiredConditions ?? []), projectId, factId,
      );
      this.logEvent(projectId, "fact.resolved", { factId, verdict });
      if (verdict.decision === "accept" || verdict.decision === "demote") {
        this.run("UPDATE meta SET value = '0' WHERE key = ?", `stagnation:${projectId}`);
      }
    });
  }

  // ─── Intent ───

  addIntent(projectId: ProjectId, input: IntentInput): Intent {
    return this.transaction(() => {
      const counter = this.nextId(projectId, "intents", "i");
      const id = `i${String(counter).padStart(3, "0")}`;
      const ts = now();
      const intent: Intent = {
        id, projectId, description: input.description, creator: input.creator,
        parentFactIds: input.parentFactIds ?? [], status: "open",
        parentIntentId: input.parentIntentId, priority: input.priority ?? 0, createdAt: ts,
      };
      this.run(
        `INSERT INTO intents (id, project_id, description, creator, parent_fact_ids_json, status, parent_intent_id, priority, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        id, projectId, input.description, input.creator,
        JSON.stringify(intent.parentFactIds), input.parentIntentId ?? null,
        intent.priority, ts,
      );
      for (let i = 0; i < intent.parentFactIds.length; i++) {
        this.run("INSERT OR IGNORE INTO intent_sources (project_id, intent_id, fact_id, seq) VALUES (?, ?, ?, ?)",
          projectId, id, intent.parentFactIds[i], i);
      }
      this.logEvent(projectId, "intent.created", { intentId: id, description: input.description, creator: input.creator });
      return intent;
    });
  }

  getIntent(projectId: ProjectId, intentId: IntentId): Intent | undefined {
    const row = this.get("SELECT * FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
    if (!row) return undefined;
    return intentFromRow(row, this.loadIntentSources(projectId, intentId));
  }

  intents(projectId: ProjectId, status?: IntentStatus): Intent[] {
    const rows = status
      ? this.all("SELECT * FROM intents WHERE project_id = ? AND status = ? ORDER BY created_at, id", projectId, status)
      : this.all("SELECT * FROM intents WHERE project_id = ? ORDER BY created_at, id", projectId);
    return rows.map((r) => intentFromRow(r, this.loadIntentSources(projectId, String(r.id))));
  }

  claimIntent(projectId: ProjectId, intentId: IntentId, workerId: string, leaseMs: number): Intent {
    return this.transaction(() => {
      const row = this.get("SELECT * FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
      if (!row) throw new Error(`intent not found: ${intentId}`);
      if (row.status !== "open") throw new Error(`intent is not open: ${intentId} (status=${row.status})`);
      const t = Date.now();
      const claimedAt = new Date(t).toISOString();
      const expiresAt = new Date(t + leaseMs).toISOString();
      this.run("UPDATE intents SET status = 'claimed', lease_worker_id = ?, lease_claimed_at = ?, lease_expires_at = ? WHERE project_id = ? AND id = ?",
        workerId, claimedAt, expiresAt, projectId, intentId);
      this.logEvent(projectId, "intent.claimed", { intentId, workerId });
      return this.getIntent(projectId, intentId)!;
    });
  }

  releaseIntent(projectId: ProjectId, intentId: IntentId): void {
    this.transaction(() => {
      const row = this.get("SELECT status FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
      if (!row) throw new Error(`intent not found: ${intentId}`);
      if (row.status === "claimed") {
        this.run("UPDATE intents SET status = 'open', lease_worker_id = NULL, lease_claimed_at = NULL, lease_expires_at = NULL WHERE project_id = ? AND id = ?",
          projectId, intentId);
        this.logEvent(projectId, "intent.released", { intentId });
      }
    });
  }

  concludeIntent(projectId: ProjectId, intentId: IntentId, factId?: FactId): void {
    this.transaction(() => {
      const row = this.get("SELECT status FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
      if (!row) throw new Error(`intent not found: ${intentId}`);
      if (row.status === "done" || row.status === "failed") throw new Error(`intent already concluded: ${intentId}`);
      const ts = now();
      this.run("UPDATE intents SET status = 'done', concluded_at = ?, concluded_fact_id = ? WHERE project_id = ? AND id = ?",
        ts, factId ?? null, projectId, intentId);
      this.bumpStep(projectId);
      this.logEvent(projectId, "intent.concluded", { intentId, factId });
    });
  }

  failIntent(projectId: ProjectId, intentId: IntentId, reason: string, recordDeadEnd = true, killedBy: Intent["killedBy"] = undefined): void {
    this.transaction(() => {
      const row = this.get("SELECT status FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
      if (!row) throw new Error(`intent not found: ${intentId}`);
      if (row.status === "failed") throw new Error(`intent already failed: ${intentId}`);
      const wasDone = row.status === "done";
      const ts = now();
      this.run("UPDATE intents SET status = 'failed', concluded_at = ?, failure_reason = ?, killed_by = ?, lease_worker_id = NULL WHERE project_id = ? AND id = ?",
        ts, reason, killedBy, projectId, intentId);
      if (recordDeadEnd) {
        const descRow = this.get("SELECT description FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
        const desc = String(descRow?.description ?? "");
        const hash = routeHash(desc);
        this.run("INSERT OR REPLACE INTO dead_ends (route_hash, project_id, intent_id, description, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          hash, projectId, intentId, desc, reason, ts);
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
      const row = this.get("SELECT status FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
      if (!row) throw new Error(`intent not found: ${intentId}`);
      if (row.status !== "claimed") throw new Error(`can only chain a claimed intent: ${intentId} (status=${row.status})`);
      const subIds: IntentId[] = [];
      for (const spec of chain.subIntents) {
        const sub = this.addIntent(projectId, {
          description: spec.description, creator: "workflow",
          parentIntentId: intentId, priority: spec.priority,
        });
        subIds.push(sub.id);
      }
      const ts = now();
      this.run("UPDATE intents SET status = 'chained', chain_json = ? WHERE project_id = ? AND id = ?",
        JSON.stringify({ reason: chain.reason, subIntentIds: subIds, waitMode: chain.waitMode, createdAt: ts }),
        projectId, intentId);
      this.logEvent(projectId, "intent.chained", { intentId, subIntentIds: subIds, reason: chain.reason });
      return subIds;
    });
  }

  resumeChainedIntent(projectId: ProjectId, intentId: IntentId): void {
    this.transaction(() => {
      const row = this.get("SELECT status FROM intents WHERE project_id = ? AND id = ?", projectId, intentId);
      if (!row) throw new Error(`intent not found: ${intentId}`);
      if (row.status !== "chained") throw new Error(`can only resume a chained intent: ${intentId} (status=${row.status})`);
      this.run("UPDATE intents SET status = 'open' WHERE project_id = ? AND id = ?", projectId, intentId);
      this.logEvent(projectId, "intent.resumed", { intentId });
    });
  }

  isDeadEnd(projectId: ProjectId, description: string): boolean {
    const hash = routeHash(description);
    const row = this.get("SELECT 1 FROM dead_ends WHERE project_id = ? AND route_hash = ?", projectId, hash);
    return !!row;
  }

  sweepExpiredLeases(): number {
    const nowIso = now();
    const rows = this.all("SELECT project_id, id FROM intents WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?", nowIso);
    for (const row of rows) {
      this.run("UPDATE intents SET status = 'open', lease_worker_id = NULL, lease_claimed_at = NULL, lease_expires_at = NULL WHERE project_id = ? AND id = ?",
        row.project_id, row.id);
      this.logEvent(String(row.project_id), "intent.lease_expired", { intentId: String(row.id) });
    }
    return rows.length;
  }

  // ─── Hint ───

  addHint(projectId: ProjectId, input: HintInput): Hint {
    return this.transaction(() => {
      const counter = this.nextId(projectId, "hints", "h");
      const id = `h${String(counter).padStart(3, "0")}`;
      const ts = now();
      const hint: Hint = {
        id, projectId, content: input.content, creator: input.creator,
        kind: input.kind ?? "direction", targetIntentId: input.targetIntentId,
        createdAt: ts, expiresAt: input.expiresAt,
      };
      this.run("INSERT INTO hints (id, project_id, content, creator, kind, target_intent_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id, projectId, hint.content, hint.creator, hint.kind, input.targetIntentId ?? null, ts, input.expiresAt ?? null);
      this.logEvent(projectId, "hint.created", { hintId: id, creator: input.creator, kind: hint.kind });
      return hint;
    });
  }

  unconsumedHints(projectId: ProjectId): Hint[] {
    const nowIso = now();
    return this.all(
      "SELECT * FROM hints WHERE project_id = ? AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, id",
      projectId, nowIso,
    ).map(hintFromRow);
  }

  consumeHint(projectId: ProjectId, hintId: HintId): void {
    this.transaction(() => {
      const row = this.get("SELECT 1 FROM hints WHERE project_id = ? AND id = ?", projectId, hintId);
      if (!row) throw new Error(`hint not found: ${hintId}`);
      this.run("UPDATE hints SET consumed_at = ? WHERE project_id = ? AND id = ?", now(), projectId, hintId);
      this.logEvent(projectId, "hint.consumed", { hintId });
    });
  }

  // ─── Directive ───

  addDirective(projectId: ProjectId, input: DirectiveInput): Directive {
    return this.transaction(() => {
      const counter = this.nextId(projectId, "directives", "d");
      const id = `d${String(counter).padStart(3, "0")}`;
      const ts = now();
      const dir: Directive = { id, projectId, kind: input.kind, payload: input.payload, createdAt: ts };
      this.run("INSERT INTO directives (id, project_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
        id, projectId, input.kind, input.payload, ts);
      this.logEvent(projectId, "directive.created", { directiveId: id, kind: input.kind });
      return dir;
    });
  }

  unconsumedDirectives(projectId: ProjectId): Directive[] {
    return this.all("SELECT * FROM directives WHERE project_id = ? AND consumed_at IS NULL ORDER BY created_at, id", projectId).map(directiveFromRow);
  }

  consumeDirective(projectId: ProjectId, directiveId: DirectiveId): void {
    this.transaction(() => {
      const row = this.get("SELECT 1 FROM directives WHERE project_id = ? AND id = ?", projectId, directiveId);
      if (!row) throw new Error(`directive not found: ${directiveId}`);
      this.run("UPDATE directives SET consumed_at = ? WHERE project_id = ? AND id = ?", now(), projectId, directiveId);
      this.logEvent(projectId, "directive.consumed", { directiveId });
    });
  }

  // ─── Link ───

  addLink(projectId: ProjectId, input: LinkInput): Link {
    return this.transaction(() => {
      const counter = this.nextId(projectId, "links", "l");
      const id = `l${String(counter).padStart(3, "0")}`;
      const ts = now();
      const link: Link = {
        id, projectId, fromFactId: input.fromFactId, toFactId: input.toFactId,
        kind: input.kind, evidence: input.evidence ?? [], createdAt: ts,
      };
      this.run("INSERT INTO links (id, project_id, from_fact_id, to_fact_id, kind, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id, projectId, link.fromFactId, link.toFactId, link.kind, JSON.stringify(link.evidence), ts);
      this.logEvent(projectId, "link.created", { linkId: id, from: input.fromFactId, to: input.toFactId, kind: input.kind });
      return link;
    });
  }

  links(projectId: ProjectId): Link[] {
    return this.all("SELECT * FROM links WHERE project_id = ? ORDER BY created_at, id", projectId).map(linkFromRow);
  }

  // ─── SubagentRun ───

  createSubagentRun(projectId: ProjectId, input: SubagentRunInput): SubagentRun {
    return this.transaction(() => {
      const id = newRunId();
      const ts = now();
      this.run(
        `INSERT INTO subagent_runs
         (id, project_id, profile_id, role, worker_name, status, intent_id, fact_id,
          parent_run_id, input_summary, rotate_of, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        id, projectId, input.profileId, input.role, input.workerName,
        input.intentId ?? null, input.factId ?? null,
        input.parentRunId ?? null, input.inputSummary ?? null, input.rotateOf ?? null, ts,
      );
      const run = this.get("SELECT * FROM subagent_runs WHERE project_id = ? AND id = ?", projectId, id);
      if (!run) throw new Error(`failed to read back subagent run: ${id}`);
      const parsed = runFromRow(run);
      this.logEvent(projectId, "run.created", {
        runId: id, profileId: input.profileId, role: input.role,
        intentId: input.intentId, rotateOf: input.rotateOf,
      });
      return parsed;
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
      const existing = this.get("SELECT status FROM subagent_runs WHERE project_id = ? AND id = ?", projectId, runId);
      if (!existing) throw new Error(`subagent run not found: ${runId}`);
      const prevStatus = String(existing.status);
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
      if (patch.outputSummary !== undefined) { sets.push("output_summary = ?"); params.push(patch.outputSummary); }
      if (patch.errorMessage !== undefined) { sets.push("error_message = ?"); params.push(patch.errorMessage); }
      if (patch.factId !== undefined) { sets.push("fact_id = ?"); params.push(patch.factId); }
      if (patch.usedDelta !== undefined) { sets.push("used_delta = ?"); params.push(patch.usedDelta ? 1 : 0); }
      if (patch.inputTokens !== undefined) { sets.push("input_tokens = ?"); params.push(patch.inputTokens); }
      if (patch.outputTokens !== undefined) { sets.push("output_tokens = ?"); params.push(patch.outputTokens); }

      const wantRunning = patch.status === "running";
      const wantTerminal = patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled";
      if (wantRunning) { sets.push("started_at = COALESCE(started_at, ?)"); params.push(now()); }
      if (wantTerminal) { sets.push("finished_at = COALESCE(finished_at, ?)"); params.push(now()); }

      if (sets.length === 0) return;
      params.push(projectId, runId);
      this.run(`UPDATE subagent_runs SET ${sets.join(", ")} WHERE project_id = ? AND id = ?`, ...params);
      this.logEvent(projectId, "run.updated", {
        runId, prevStatus: prevStatus,
        status: patch.status, outputSummary: patch.outputSummary, errorMessage: patch.errorMessage,
      });
    });
  }

  getSubagentRun(projectId: ProjectId, runId: RunId): SubagentRun | undefined {
    const row = this.get("SELECT * FROM subagent_runs WHERE project_id = ? AND id = ?", projectId, runId);
    return row ? runFromRow(row) : undefined;
  }

  subagentRuns(projectId: ProjectId, filter?: { profileId?: string; status?: RunStatus }): SubagentRun[] {
    let sql = "SELECT * FROM subagent_runs WHERE project_id = ?";
    const params: unknown[] = [projectId];
    if (filter?.profileId) { sql += " AND profile_id = ?"; params.push(filter.profileId); }
    if (filter?.status) { sql += " AND status = ?"; params.push(filter.status); }
    sql += " ORDER BY created_at, id";
    return this.all(sql, ...params).map(runFromRow);
  }

  // ─── Event ───

  logEvent(projectId: ProjectId, type: string, payload: Record<string, unknown> = {}): GraphEvent {
    const ts = now();
    const result = this.run(
      "INSERT INTO events (project_id, type, payload_json, timestamp) VALUES (?, ?, ?, ?)",
      projectId, type, JSON.stringify(payload), ts,
    );
    return { seq: Number(result.lastInsertRowid), projectId, type, payload, timestamp: ts };
  }

  events(projectId: ProjectId, sinceSeq?: number, limit = 1000): GraphEvent[] {
    const rows = sinceSeq !== undefined
      ? this.all("SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?", projectId, sinceSeq, limit)
      : this.all("SELECT * FROM events WHERE project_id = ? ORDER BY seq DESC LIMIT ?", projectId, limit);
    return rows.reverse().map(eventFromRow);
  }

  // ─── Progress ───

  progress(projectId: ProjectId): Progress {
    const facts = this.all("SELECT status FROM facts WHERE project_id = ?", projectId);
    const intents = this.all("SELECT status FROM intents WHERE project_id = ?", projectId);
    const evRow = this.get("SELECT timestamp FROM events WHERE project_id = ? ORDER BY seq DESC LIMIT 1", projectId);
    const stepsRow = this.get("SELECT value FROM meta WHERE key = ?", `steps:${projectId}`);
    const stagnationRow = this.get("SELECT value FROM meta WHERE key = ?", `stagnation:${projectId}`);
    return {
      totalFacts: facts.length,
      acceptedFacts: facts.filter((f) => f.status === "accepted").length,
      candidateFacts: facts.filter((f) => f.status === "candidate").length,
      rejectedFacts: facts.filter((f) => f.status === "rejected").length,
      blockedFacts: facts.filter((f) => f.status === "blocked").length,
      openIntents: intents.filter((i) => i.status === "open").length,
      claimedIntents: intents.filter((i) => i.status === "claimed").length,
      chainedIntents: intents.filter((i) => i.status === "chained").length,
      stepsExecuted: Number(stepsRow?.value ?? 0),
      lastActivityAt: String(evRow?.timestamp ?? now()),
      stagnationLevel: Number(stagnationRow?.value ?? 0),
    };
  }

  // ─── Transaction ───

  transaction<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  // ─── Internals ───

  private run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...params);
  }

  private get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
    return this.db.prepare(sql).get(...params);
  }

  private all(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
    return this.db.prepare(sql).all(...params);
  }

  private nextId(projectId: ProjectId, table: string, prefix: string): number {
    const row = this.get(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`, projectId);
    return Number(row?.count ?? 0) + 1;
  }

  private loadIntentSources(projectId: ProjectId, intentId: IntentId): string[] {
    return this.all("SELECT fact_id FROM intent_sources WHERE project_id = ? AND intent_id = ? ORDER BY seq", projectId, intentId)
      .map((r) => String(r.fact_id));
  }

  private bumpStep(projectId: ProjectId): void {
    this.run("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)", `steps:${projectId}`);
  }

  private bumpStagnation(projectId: ProjectId): void {
    this.run("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)", `stagnation:${projectId}`);
  }

  private findProject(idOrSession: string): Project | undefined {
    const row = this.get("SELECT * FROM projects WHERE id = ? OR session = ?", idOrSession, idOrSession);
    return row ? projectFromRow(row) : undefined;
  }
}

// ─── Row mappers ───

function projectFromRow(row: Record<string, unknown>): Project {
  return {
    id: String(row.id), session: String(row.session), name: String(row.name),
    target: String(row.target), goal: String(row.goal),
    status: String(row.status) as Project["status"], worker: String(row.worker),
    sessionDir: String(row.session_dir), configPath: String(row.config_path),
    taskConfig: JSON.parse(String(row.config_json)) as TaskConfig,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function factFromRow(row: Record<string, unknown>): Fact {
  return {
    id: String(row.id), projectId: String(row.project_id),
    description: String(row.description),
    evidence: JSON.parse(String(row.evidence_json ?? "[]")),
    source: String(row.source) as Fact["source"],
    confidence: Number(row.confidence), status: String(row.status) as FactStatus,
    parentIntentId: row.parent_intent_id ? String(row.parent_intent_id) : undefined,
    reviewerReason: row.reviewer_reason ? String(row.reviewer_reason) : undefined,
    requiredConditions: JSON.parse(String(row.required_conditions_json ?? "[]")),
    stepDiscovered: row.step_discovered !== undefined && row.step_discovered !== null ? Number(row.step_discovered) : undefined,
    createdAt: String(row.created_at),
  };
}

function intentFromRow(row: Record<string, unknown>, sources: string[]): Intent {
  const chainJson = row.chain_json ? String(row.chain_json) : null;
  const chain = chainJson ? JSON.parse(chainJson) as Intent["chain"] : undefined;
  return {
    id: String(row.id), projectId: String(row.project_id),
    description: String(row.description), creator: String(row.creator) as Intent["creator"],
    parentFactIds: sources.length > 0 ? sources : (JSON.parse(String(row.parent_fact_ids_json ?? "[]")) as string[]),
    status: String(row.status) as IntentStatus,
    parentIntentId: row.parent_intent_id ? String(row.parent_intent_id) : undefined,
    chain,
    lease: row.lease_worker_id ? {
      workerId: String(row.lease_worker_id),
      claimedAt: String(row.lease_claimed_at),
      expiresAt: String(row.lease_expires_at),
    } : undefined,
    priority: Number(row.priority),
    createdAt: String(row.created_at),
    concludedAt: row.concluded_at ? String(row.concluded_at) : undefined,
    concludedFactId: row.concluded_fact_id ? String(row.concluded_fact_id) : undefined,
    failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
    killedBy: row.killed_by ? String(row.killed_by) as Intent["killedBy"] : undefined,
  };
}

function hintFromRow(row: Record<string, unknown>): Hint {
  return {
    id: String(row.id), projectId: String(row.project_id),
    content: String(row.content), creator: String(row.creator) as Hint["creator"],
    kind: String(row.kind) as Hint["kind"],
    targetIntentId: row.target_intent_id ? String(row.target_intent_id) : undefined,
    consumedAt: row.consumed_at ? String(row.consumed_at) : undefined,
    createdAt: String(row.created_at),
    expiresAt: row.expires_at ? String(row.expires_at) : undefined,
  };
}

function directiveFromRow(row: Record<string, unknown>): Directive {
  return {
    id: String(row.id), projectId: String(row.project_id),
    kind: String(row.kind) as Directive["kind"], payload: String(row.payload),
    consumedAt: row.consumed_at ? String(row.consumed_at) : undefined,
    createdAt: String(row.created_at),
  };
}

function linkFromRow(row: Record<string, unknown>): Link {
  return {
    id: String(row.id), projectId: String(row.project_id),
    fromFactId: String(row.from_fact_id), toFactId: String(row.to_fact_id),
    kind: String(row.kind),
    evidence: JSON.parse(String(row.evidence_json ?? "[]")),
    createdAt: String(row.created_at),
  };
}

function eventFromRow(row: Record<string, unknown>): GraphEvent {
  return {
    seq: Number(row.seq), projectId: String(row.project_id),
    type: String(row.type),
    payload: JSON.parse(String(row.payload_json ?? "{}")),
    timestamp: String(row.timestamp),
  };
}

function runFromRow(row: Record<string, unknown>): SubagentRun {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    profileId: String(row.profile_id),
    role: String(row.role),
    workerName: String(row.worker_name),
    status: String(row.status) as SubagentRun["status"],
    intentId: row.intent_id ? String(row.intent_id) : undefined,
    factId: row.fact_id ? String(row.fact_id) : undefined,
    parentRunId: row.parent_run_id ? String(row.parent_run_id) : undefined,
    inputSummary: row.input_summary ? String(row.input_summary) : undefined,
    outputSummary: row.output_summary ? String(row.output_summary) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    rotateOf: row.rotate_of ? String(row.rotate_of) : undefined,
    usedDelta: row.used_delta !== undefined && row.used_delta !== null ? Boolean(row.used_delta) : undefined,
    inputTokens: row.input_tokens !== undefined && row.input_tokens !== null ? Number(row.input_tokens) : undefined,
    outputTokens: row.output_tokens !== undefined && row.output_tokens !== null ? Number(row.output_tokens) : undefined,
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    finishedAt: row.finished_at ? String(row.finished_at) : undefined,
  };
}

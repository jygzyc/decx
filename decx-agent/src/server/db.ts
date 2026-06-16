import { mkdirSync } from "fs";
import * as path from "path";
import { createRequire } from "module";
import type { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);

export function defaultDbPath(): string {
  return path.join(".decx", "agent_tasks", "agent.sqlite");
}

export function openAgentDb(dbPath = defaultDbPath()): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

/**
 * Schema v2 — minimal blackboard with directed-graph storage.
 *
 * 7 tables total:
 *   projects, facts, intents, intent_sources, links, runs, meta
 *
 * Removed vs schema v1:
 *   events, reviews, hints, workflow_fires, workflow_nodes,
 *   workflow_edges, agents
 *
 * Rationale:
 *   - Dispatcher never read events/reviews/hints/workflow_* for decisions
 *   - workflow_nodes/workflow_edges were write-only audit shadows of
 *     facts/intents; the graph IS the facts+intents+links now
 *   - agents config lives in task.json, not in a separate table
 *   - events are in-memory WorkflowEvent objects for rule matching only
 */
function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      session TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      target TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      worker TEXT NOT NULL,
      session_dir TEXT NOT NULL,
      config_path TEXT NOT NULL,
      config_json TEXT NOT NULL,
      last_review_at TEXT,
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
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS intents (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      to_fact_id TEXT,
      description TEXT NOT NULL,
      creator TEXT NOT NULL,
      role TEXT,
      worker TEXT,
      prompt_text TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      claimed_at TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      concluded_at TEXT,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS intent_sources (
      project_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      PRIMARY KEY (project_id, intent_id, fact_id),
      FOREIGN KEY (project_id, intent_id) REFERENCES intents(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, fact_id) REFERENCES facts(project_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS links (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      from_fact_id TEXT NOT NULL,
      to_fact_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, from_fact_id) REFERENCES facts(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, to_fact_id) REFERENCES facts(project_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      worker TEXT NOT NULL,
      role TEXT NOT NULL,
      phase TEXT NOT NULL,
      intent_id TEXT,
      returncode INTEGER NOT NULL,
      stdout_preview TEXT NOT NULL,
      stderr_preview TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project_id);
    CREATE INDEX IF NOT EXISTS idx_intents_project ON intents(project_id);
    CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(project_id, status, priority DESC);
    CREATE INDEX IF NOT EXISTS idx_intent_sources_fact ON intent_sources(project_id, fact_id);
    CREATE INDEX IF NOT EXISTS idx_intent_sources_intent ON intent_sources(project_id, intent_id);
    CREATE INDEX IF NOT EXISTS idx_links_from ON links(project_id, from_fact_id);
    CREATE INDEX IF NOT EXISTS idx_links_to ON links(project_id, to_fact_id);
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at);
  `);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '2')").run();
}

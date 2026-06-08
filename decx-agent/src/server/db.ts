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
  migrate(db);
  return db;
}

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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      description TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS intents (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      from_json TEXT NOT NULL DEFAULT '[]',
      to_fact_id TEXT,
      description TEXT NOT NULL,
      creator TEXT NOT NULL,
      agent TEXT NOT NULL,
      role TEXT NOT NULL,
      worker TEXT,
      status TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      prompt_text TEXT,
      from_events_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      concluded_at TEXT,
      failure_reason TEXT,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hints (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      content TEXT NOT NULL,
      creator TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT,
      source TEXT,
      sink TEXT,
      category TEXT,
      data_json TEXT,
      worker TEXT NOT NULL,
      phase TEXT NOT NULL,
      intent_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      worker TEXT NOT NULL,
      summary TEXT NOT NULL,
      severity TEXT,
      events_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS worker_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      worker TEXT NOT NULL,
      role TEXT NOT NULL,
      agent TEXT,
      phase TEXT NOT NULL,
      intent_id TEXT,
      returncode INTEGER NOT NULL,
      stdout_preview TEXT NOT NULL,
      stderr_preview TEXT NOT NULL,
      error_kind TEXT,
      worker_session TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workflow_fires (
      project_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, rule_id, event_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workflow_nodes (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      label TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      UNIQUE (project_id, kind, ref_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workflow_edges (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id),
      UNIQUE (project_id, from_node_id, to_node_id, kind),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
}

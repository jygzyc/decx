#!/usr/bin/env node
/**
 * decx-analysis-db.mjs — SQLite blackboard CLI for DECX vulnhunt skills.
 *
 * One database per target: .decx-analysis/<target>/decx-analysis.db.
 * Graph model: Facts are immutable nodes; Intents are directed edges
 * (from[] -> to_fact). Chain discovery via fact->intent->fact traversal.
 */

import { mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const FACT_TYPES = [
  "entrypoint", "surface", "reachability", "control", "guard", "sink",
  "impact", "composition", "dead_end", "service_entrypoint",
  "binder_reachability", "identity", "permission_guard", "appop_guard",
  "user_guard", "identity_transition", "observation",
];
const TARGET_KINDS = ["android_app", "android_framework"];

// ── Schema (v1) ─────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, session TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  target TEXT NOT NULL, target_kind TEXT NOT NULL DEFAULT 'android_app',
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT NOT NULL, project_id TEXT NOT NULL, description TEXT NOT NULL,
  fact_type TEXT NOT NULL DEFAULT 'observation', evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS intents (
  id TEXT NOT NULL, project_id TEXT NOT NULL, from_json TEXT NOT NULL DEFAULT '[]',
  to_fact_id TEXT, description TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'tracer',
  worker TEXT, dispatched_by TEXT, dispatched_at TEXT,
  priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
  claimed_by TEXT, claimed_at TEXT, created_at TEXT NOT NULL,
  concluded_at TEXT, failure_reason TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS hints (
  id TEXT NOT NULL, project_id TEXT NOT NULL, content TEXT NOT NULL,
  creator TEXT NOT NULL DEFAULT 'human', absorbed_at TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT NOT NULL, project_id TEXT NOT NULL, type TEXT NOT NULL, severity TEXT,
  source TEXT, category TEXT, data_json TEXT, worker TEXT NOT NULL DEFAULT 'main',
  phase TEXT NOT NULL DEFAULT 'explore', intent_id TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT NOT NULL, project_id TEXT NOT NULL, from_fact_id TEXT NOT NULL,
  to_fact_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chain', description TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project_id);
CREATE INDEX IF NOT EXISTS idx_intents_project ON intents(project_id);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
CREATE INDEX IF NOT EXISTS idx_intents_priority ON intents(priority DESC);
CREATE INDEX IF NOT EXISTS idx_hints_project ON hints(project_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_links_project ON links(project_id);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(project_id, from_fact_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(project_id, to_fact_id);
`;

// ── Help ────────────────────────────────────────────────────────────────────

const HELP_TOP = `Usage: node decx-analysis-db.mjs <command> <target-dir> [options]

SQLite blackboard for DECX vulnerability hunting.
Facts are immutable nodes. Intents are directed edges (from[] -> to_fact).

Commands:
  init      <dir>  Create a new analysis database and project
  fact      <dir>  Add an immutable observation
  facts     <dir>  List facts
  intent    <dir>  Create an exploration intent
  dispatch  <dir>  Dispatch a ready intent to a worker
  claim     <dir>  Claim a dispatched intent
  result    <dir>  Absorb subagent results (facts + events) into an intent
  conclude  <dir>  Conclude an intent by linking to a fact
  fail      <dir>  Mark an intent as failed
  intents   <dir>  List intents
  hint      <dir>  Add a human hint
  absorb    <dir>  Mark a hint as absorbed
  hints     <dir>  List hints
  event     <dir>  Record an audit event
  link      <dir>  Link one fact to another
  chain     <dir>  Link an ordered chain of facts
  graph     <dir>  Export the fact->intent->fact graph as JSON
  path      <dir>  BFS from one fact to another
  stats     <dir>  Print project statistics
  export    <dir>  Export project data

Run <command> --help for detailed options.`;

const HELP = {
init: `init <dir> — Create a new analysis database and project.

Arguments:
  <dir>                  Target directory (creates <dir>/decx-analysis.db)

Options:
  --session <name>       Session name (required, unique)
  --kind <kind>          Target kind: android_app | android_framework (default: android_app)

Example:
  node decx-analysis-db.mjs init .decx-analysis/myapp --session myapp --kind android_app`,

fact: `fact <dir> — Add an immutable fact to the blackboard.

Arguments:
  <dir>                  Target directory containing decx-analysis.db

Options:
  --description <text>   Fact description text (required)
  --type <type>          Fact type (default: observation)
                         Valid: ${FACT_TYPES.join(", ")}
  --source <src>         Fact source identifier (default: recon)
  --evidence <json>      JSON array of evidence items

Example:
  node decx-analysis-db.mjs fact .decx-analysis/myapp \\
    --description "exported: com.example.ExportActivity" --type entrypoint`,

facts: `facts <dir> — List facts in the database.

Options: --source <src>, --limit <n> (default: 100)

Example:
  node decx-analysis-db.mjs facts .decx-analysis/myapp --source recon --limit 20`,

intent: `intent <dir> — Create an exploration intent (directed edge from facts).

Options:
  --description <text>   Intent description (required)
  --from <factId,...>    Comma-separated source fact IDs
  --agent <role>         Agent role label (default: tracer)
  --priority <n>         Priority, higher = first (default: 0)

Example:
  node decx-analysis-db.mjs intent .decx-analysis/myapp \\
    --description "Trace reachability from ExportActivity" --from abc123`,

dispatch: `dispatch <dir> <intentId> — Dispatch a ready intent to a worker.

Arguments: <intentId> — Intent ID to dispatch
Options:  --to <worker>   Worker name to dispatch to (required)

Example:
  node decx-analysis-db.mjs dispatch .decx-analysis/myapp intent-1 --to subagent`,

claim: `claim <dir> <intentId> — Claim a dispatched intent for execution.

Arguments: <intentId> — Intent ID to claim
Options:  --by <worker>   Worker claiming the intent (default: main)

Example:
  node decx-analysis-db.mjs claim .decx-analysis/myapp intent-1 --by tracer-1`,

result: `result <dir> <intentId> — Absorb subagent results into a working intent.

Arguments: <intentId> — Intent ID to update
Options:
  --facts <json>         JSON array of fact objects (each requires description)
  --events <json>        JSON array of event objects (each requires type)
  --conclude <factId|last> Fact ID or "last" for the last inserted fact
  --fail <reason>        Fail the intent with a reason
  --by <worker>          Source worker label (default: subagent)

Example:
  node decx-analysis-db.mjs result .decx-analysis/myapp intent-1 \\
    --facts '[{"description":"guard: no caller check"}]' --conclude last`,

conclude: `conclude <dir> <intentId> — Conclude a working intent by linking to a fact.

Arguments: <intentId> — Intent ID to conclude
Options:  --fact <factId>   Fact ID to link as the conclusion (required)

Example:
  node decx-analysis-db.mjs conclude .decx-analysis/myapp intent-1 --fact abc123`,

fail: `fail <dir> <intentId> — Mark a working intent as failed.

Arguments: <intentId> — Intent ID to fail
Options:  --reason <text>   Failure reason (default: unknown)

Example:
  node decx-analysis-db.mjs fail .decx-analysis/myapp intent-1 --reason "no reachable path"`,

intents: `intents <dir> — List intents in the database.

Options: --status <st> (open|working|done|failed), --limit <n> (default: 50)

Example:
  node decx-analysis-db.mjs intents .decx-analysis/myapp --status open`,

hint: `hint <dir> — Add a human hint to the blackboard.

Options:
  --content <text>       Hint content text (required)
  --creator <who>        Hint creator label (default: human)

Example:
  node decx-analysis-db.mjs hint .decx-analysis/myapp --content "Check isUidMode guard in AMS"`,

absorb: `absorb <dir> <hintId> — Mark a hint as absorbed.

Arguments: <hintId> — Hint ID to mark as absorbed

Example:
  node decx-analysis-db.mjs absorb .decx-analysis/myapp hint-1`,

hints: `hints <dir> — List hints in the database.

Options: --absorbed (include absorbed hints), --limit <n> (default: 50)

Example:
  node decx-analysis-db.mjs hints .decx-analysis/myapp --absorbed`,

event: `event <dir> — Record an audit event.

Options:
  --type <type>          Event type (required)
  --severity <sev>       Severity level
  --source <sig>         Source identifier
  --category <cat>       Event category
  --data <json>          JSON data payload
  --worker <w>           Worker label (default: main)
  --phase <ph>           Phase label (default: explore)
  --intent <id>          Associated intent ID

Example:
  node decx-analysis-db.mjs event .decx-analysis/myapp --type "milestone" --severity info`,

link: `link <dir> — Link one fact to another.

Options:
  --from <factId>        Source fact ID (required)
  --to <factId>          Target fact ID (required)
  --kind <k>             Link kind (default: chain)
  --description <text>   Link description
  --evidence <json>      JSON array of evidence items

Example:
  node decx-analysis-db.mjs link .decx-analysis/myapp --from a --to b --kind flows-to`,

chain: `chain <dir> — Link an ordered chain of facts.

Options:
  --facts <factId,...>   Comma-separated ordered fact IDs (at least 2)
  --kind <k>             Link kind for each edge (default: chain)
  --description <text>   Shared description for each edge
  --evidence <json>      JSON array of evidence items

Example:
  node decx-analysis-db.mjs chain .decx-analysis/myapp --facts a,b,c --kind flows-to`,

graph: `graph <dir> — Export the fact->intent->fact graph as JSON.

Example: node decx-analysis-db.mjs graph .decx-analysis/myapp`,

path: `path <dir> — BFS from one fact to another through done intents and links.

Options: --from <factId> (required), --to <factId> (required)

Example:
  node decx-analysis-db.mjs path .decx-analysis/myapp --from entrypoint-1 --to sink-5`,

stats: `stats <dir> — Print project statistics.

Example: node decx-analysis-db.mjs stats .decx-analysis/myapp`,

export: `export <dir> — Export project data.

Options: --format <json|ndjson> (default: json)

Example:
  node decx-analysis-db.mjs export .decx-analysis/myapp --format ndjson`,
};

function printHelp(cmd) {
  const h = HELP[cmd];
  if (h) { console.log(h); process.exit(0); }
  if (cmd) { console.error(`error: unknown command '${cmd}'`); process.exit(1); }
  console.log(HELP_TOP);
  process.exit(0);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const now = () => new Date().toISOString();

function openDb(targetDir) {
  const dbPath = join(targetDir, "decx-analysis.db");
  if (!existsSync(dbPath)) fail(`database not found at ${dbPath}. Run 'init' first.`);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }

function getProjectId(db, sessionName) {
  if (sessionName) {
    const row = db.prepare("SELECT id FROM projects WHERE session = ?").get(sessionName);
    if (row) return row.id;
  }
  const row = db.prepare("SELECT id FROM projects WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get();
  if (!row) fail("no active project. Use --session or run 'init' first.");
  return row.id;
}

function fromJson(val, fallback) {
  if (Array.isArray(val)) return val;
  if (!val) return fallback || null;
  try { return JSON.parse(val); } catch { return fallback || null; }
}

function parseJson(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  try { return JSON.parse(value); } catch { fail(`${label} must be valid JSON`); }
}

function asArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be a JSON array`);
  return value;
}

function normalizeRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith("_json") && typeof v === "string") {
      try { out[k] = JSON.parse(v); } catch { out[k] = v; }
    } else { out[k] = v; }
  }
  return out;
}

function getOpt(args, flag) {
  const idx = args.indexOf(flag);
  return (idx !== -1 && idx + 1 < args.length) ? args[idx + 1] : undefined;
}

function factExists(db, projectId, factId) {
  return Boolean(db.prepare("SELECT 1 FROM facts WHERE project_id = ? AND id = ?").get(projectId, factId));
}

function getIntent(db, projectId, intentId) {
  return db.prepare("SELECT * FROM intents WHERE project_id = ? AND id = ?").get(projectId, intentId);
}

function insertEvent(db, projectId, event) {
  const id = event.id || randomUUID();
  db.prepare(`INSERT INTO events (id,project_id,type,severity,source,category,data_json,worker,phase,intent_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, projectId, event.type, event.severity || null, event.source || null,
    event.category || null, event.data === undefined ? null : JSON.stringify(event.data),
    event.worker || "main", event.phase || "explore",
    event.intent_id || event.intentId || null, event.created_at || now());
  return id;
}

function insertFact(db, projectId, fact) {
  if (!fact.description) fail("fact.description is required");
  const id = fact.id || randomUUID();
  const evidence = fact.evidence === undefined ? [] : fact.evidence;
  if (!Array.isArray(evidence)) fail("fact.evidence must be a JSON array");
  db.prepare(`INSERT INTO facts (id,project_id,description,fact_type,evidence_json,source,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    id, projectId, fact.description, fact.fact_type || "observation",
    JSON.stringify(evidence), fact.source || "subagent", fact.created_at || now());
  return id;
}

function insertLink(db, projectId, input) {
  if (!input.from || !input.to) fail("link requires from and to fact IDs");
  if (!factExists(db, projectId, input.from)) fail(`fact not found: ${input.from}`);
  if (!factExists(db, projectId, input.to)) fail(`fact not found: ${input.to}`);
  const evidence = input.evidence === undefined ? [] : input.evidence;
  if (!Array.isArray(evidence)) fail("link evidence must be a JSON array");
  const id = input.id || randomUUID();
  db.prepare(`INSERT INTO links (id,project_id,from_fact_id,to_fact_id,kind,description,evidence_json,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    id, projectId, input.from, input.to, input.kind || "chain",
    input.description || null, JSON.stringify(evidence), input.created_at || now());
  return id;
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdInit(args, targetDir) {
  const sessionName = getOpt(args, "--session");
  if (!sessionName) fail("--session <name> is required");
  const kind = getOpt(args, "--kind") || "android_app";
  if (!TARGET_KINDS.includes(kind)) fail(`--kind must be one of: ${TARGET_KINDS.join(", ")}`);

  mkdirSync(targetDir, { recursive: true });
  const dbPath = join(targetDir, "decx-analysis.db");

  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const id = randomUUID();
    db.prepare(`INSERT OR IGNORE INTO projects (id,session,name,target,target_kind,status,created_at,updated_at)
      VALUES (?,?,?,?,?,'active',?,?)`).run(id, sessionName, sessionName, basename(targetDir), kind, now(), now());
    const row = db.prepare("SELECT id FROM projects WHERE session = ?").get(sessionName);
    db.close();
    console.log(JSON.stringify({ ok: true, action: row?.id === id ? "project-added" : "project-exists", session: sessionName, project_id: row?.id || id }));
    return;
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  const id = randomUUID();
  db.prepare(`INSERT INTO projects (id,session,name,target,target_kind,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'active',?,?)`).run(id, sessionName, sessionName, basename(targetDir), kind, now(), now());
  db.close();
  console.log(JSON.stringify({ ok: true, action: "init", session: sessionName, project_id: id, db: dbPath }));
}

function cmdFact(args, targetDir) {
  const description = getOpt(args, "--description");
  if (!description) fail("--description is required");
  const factType = getOpt(args, "--type") || "observation";
  if (!FACT_TYPES.includes(factType)) fail(`invalid --type '${factType}'. Valid: ${FACT_TYPES.join(", ")}`);

  const db = openDb(targetDir);
  try {
    const evidence = getOpt(args, "--evidence");
    const source = getOpt(args, "--source") || "recon";
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const factId = insertFact(db, projectId, { description, fact_type: factType, evidence: parseJson(evidence, [], "--evidence"), source });
    console.log(JSON.stringify({ ok: true, id: factId, project_id: projectId }));
  } finally { db.close(); }
}

function cmdFacts(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const source = getOpt(args, "--source");
    const limit = parseInt(getOpt(args, "--limit") || "100", 10);
    let sql = "SELECT * FROM facts WHERE project_id = ?";
    const params = [projectId];
    if (source) { sql += " AND source = ?"; params.push(source); }
    sql += " ORDER BY created_at DESC LIMIT ?"; params.push(limit);
    console.log(JSON.stringify(db.prepare(sql).all(...params).map(normalizeRow)));
  } finally { db.close(); }
}

function cmdIntent(args, targetDir) {
  const description = getOpt(args, "--description");
  if (!description) fail("--description is required");

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const fromIds = getOpt(args, "--from") || "";
    const agent = getOpt(args, "--agent") || "tracer";
    const priority = parseInt(getOpt(args, "--priority") || "0", 10);
    const worker = getOpt(args, "--worker") || null;
    const id = randomUUID();
    const fromJson = fromIds ? JSON.stringify(fromIds.split(",")) : "[]";

    const cols = ["id", "project_id", "from_json", "description", "agent"];
    const vals = [id, projectId, fromJson, description, agent];
    if (worker) { cols.push("worker"); vals.push(worker); }
    cols.push("priority", "status", "created_at");
    vals.push(priority, "open", now());

    const placeholders = cols.map(() => "?").join(",");
    db.prepare(`INSERT INTO intents (${cols.join(",")}) VALUES (${placeholders})`).run(...vals);
    console.log(JSON.stringify({ ok: true, id, project_id: projectId, agent, priority }));
  } finally { db.close(); }
}

function cmdClaim(args, targetDir) {
  const intentId = args[0];
  if (!intentId) fail("intentId is required");
  const by = getOpt(args, "--by") || "main";

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const intent = getIntent(db, projectId, intentId);
    if (!intent) fail(`intent not found: ${intentId}`);
    if (!intent.dispatched_by) fail(`intent is not dispatched: ${intentId}`);
    if (intent.status !== "open") fail(`intent is not open: ${intentId}`);
    const active = db.prepare("SELECT id FROM intents WHERE project_id = ? AND status = 'working' AND claimed_by = ? AND id != ?").get(projectId, by, intentId);
    if (active) fail(`${by} already has a working intent: ${active.id}`);

    db.prepare("UPDATE intents SET status = 'working', claimed_by = ?, claimed_at = ? WHERE id = ? AND project_id = ? AND status = 'open'").run(by, now(), intentId, projectId);
    insertEvent(db, projectId, { type: "intent.claimed", severity: "info", category: "intent", source: by, worker: by, phase: "explore", intent_id: intentId, data: { claimedBy: by } });
    console.log(JSON.stringify({ ok: true, id: intentId, status: "working", claimed_by: by }));
  } finally { db.close(); }
}

function cmdDispatch(args, targetDir) {
  const intentId = args[0];
  const to = getOpt(args, "--to") || getOpt(args, "--by");
  if (!intentId) fail("intentId is required");
  if (!to) fail("--to <worker> is required");

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const intent = getIntent(db, projectId, intentId);
    if (!intent) fail(`intent not found: ${intentId}`);
    if (intent.status !== "open") fail(`intent is not open: ${intentId}`);
    if (intent.dispatched_by) fail(`intent already dispatched: ${intentId}`);

    db.prepare("UPDATE intents SET dispatched_by = ?, dispatched_at = ?, worker = COALESCE(worker, ?) WHERE project_id = ? AND id = ?").run(to, now(), to, projectId, intentId);
    const eventId = insertEvent(db, projectId, { type: "intent.dispatched", severity: "info", category: "intent", source: "main", worker: to, phase: "reason", intent_id: intentId, data: { dispatchedTo: to } });
    console.log(JSON.stringify({ ok: true, id: intentId, dispatched_to: to, event_id: eventId }));
  } finally { db.close(); }
}

function cmdConclude(args, targetDir) {
  const intentId = args[0];
  if (!intentId) fail("intentId is required");
  const factId = getOpt(args, "--fact");
  if (!factId) fail("--fact <factId> is required");

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const intent = getIntent(db, projectId, intentId);
    if (!intent) fail(`intent not found: ${intentId}`);
    if (intent.status !== "working") fail(`intent is not working: ${intentId}`);
    if (!factExists(db, projectId, factId)) fail(`fact not found: ${factId}`);
    db.prepare("UPDATE intents SET status = 'done', to_fact_id = ?, concluded_at = ? WHERE id = ? AND project_id = ?").run(factId, now(), intentId, projectId);
    insertEvent(db, projectId, { type: "intent.concluded", severity: "info", category: "intent", source: intent.claimed_by || "subagent", worker: intent.claimed_by || "subagent", phase: "explore", intent_id: intentId, data: { factId } });
    console.log(JSON.stringify({ ok: true, id: intentId, status: "done", to_fact_id: factId }));
  } finally { db.close(); }
}

function cmdFail(args, targetDir) {
  const intentId = args[0];
  if (!intentId) fail("intentId is required");
  const reason = getOpt(args, "--reason") || "unknown";

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const intent = getIntent(db, projectId, intentId);
    if (!intent) fail(`intent not found: ${intentId}`);
    if (intent.status !== "working") fail(`intent is not working: ${intentId}`);
    db.prepare("UPDATE intents SET status = 'failed', failure_reason = ?, concluded_at = ? WHERE id = ? AND project_id = ?").run(reason, now(), intentId, projectId);
    insertEvent(db, projectId, { type: "intent.failed", severity: "medium", category: "intent", source: intent.claimed_by || "subagent", worker: intent.claimed_by || "subagent", phase: "explore", intent_id: intentId, data: { reason } });
    console.log(JSON.stringify({ ok: true, id: intentId, status: "failed", reason }));
  } finally { db.close(); }
}

function cmdResult(args, targetDir) {
  const intentId = args[0];
  if (!intentId) fail("intentId is required");
  const by = getOpt(args, "--by") || "subagent";
  const factsJson = getOpt(args, "--facts");
  const eventsJson = getOpt(args, "--events");
  const concludeOpt = getOpt(args, "--conclude");
  const failReason = getOpt(args, "--fail");

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const intent = getIntent(db, projectId, intentId);
    if (!intent) fail(`intent not found: ${intentId}`);
    if (intent.status !== "working") fail(`intent is not working: ${intentId}`);

    const insertedFacts = [], insertedEvents = [];
    db.exec("BEGIN");
    try {
      for (const fact of asArray(parseJson(factsJson, [], "--facts"), "--facts"))
        insertedFacts.push(insertFact(db, projectId, { ...fact, source: fact.source || by }));
      for (const event of asArray(parseJson(eventsJson, [], "--events"), "--events")) {
        if (!event.type) fail("event.type is required");
        insertedEvents.push(insertEvent(db, projectId, { ...event, worker: event.worker || by, intent_id: event.intent_id || intentId }));
      }

      if (failReason) {
        db.prepare("UPDATE intents SET status = 'failed', failure_reason = ?, concluded_at = ? WHERE id = ? AND project_id = ?").run(failReason, now(), intentId, projectId);
        insertEvent(db, projectId, { type: "intent.failed", severity: "medium", category: "intent", source: by, worker: by, phase: "explore", intent_id: intentId, data: { reason: failReason } });
      } else {
        const concludeFact = concludeOpt === "last" || !concludeOpt ? insertedFacts[insertedFacts.length - 1] : concludeOpt;
        if (!concludeFact) fail("--conclude <factId|last> or --fail <reason> is required when no facts are inserted");
        if (!factExists(db, projectId, concludeFact)) fail(`fact not found: ${concludeFact}`);
        db.prepare("UPDATE intents SET status = 'done', to_fact_id = ?, concluded_at = ? WHERE id = ? AND project_id = ?").run(concludeFact, now(), intentId, projectId);
        insertEvent(db, projectId, { type: "intent.concluded", severity: "info", category: "intent", source: by, worker: by, phase: "explore", intent_id: intentId, data: { factId: concludeFact } });
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    console.log(JSON.stringify({ ok: true, id: intentId, facts: insertedFacts, events: insertedEvents, status: failReason ? "failed" : "done" }));
  } finally { db.close(); }
}

function cmdIntents(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const status = getOpt(args, "--status");
    const limit = parseInt(getOpt(args, "--limit") || "50", 10);
    let sql = "SELECT * FROM intents WHERE project_id = ?";
    const params = [projectId];
    if (status) { sql += " AND status = ?"; params.push(status); }
    sql += " ORDER BY priority DESC, created_at ASC LIMIT ?"; params.push(limit);
    console.log(JSON.stringify(db.prepare(sql).all(...params).map(normalizeRow)));
  } finally { db.close(); }
}

function cmdHint(args, targetDir) {
  const content = getOpt(args, "--content");
  if (!content) fail("--content is required");
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const id = randomUUID();
    db.prepare("INSERT INTO hints (id,project_id,content,creator,created_at) VALUES (?,?,?,?,?)").run(id, projectId, content, getOpt(args, "--creator") || "human", now());
    console.log(JSON.stringify({ ok: true, id }));
  } finally { db.close(); }
}

function cmdAbsorb(args, targetDir) {
  const hintId = args[0];
  if (!hintId) fail("hintId is required");
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    db.prepare("UPDATE hints SET absorbed_at = ? WHERE id = ? AND project_id = ?").run(now(), hintId, projectId);
    console.log(JSON.stringify({ ok: true, id: hintId, absorbed: true }));
  } finally { db.close(); }
}

function cmdHints(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const absorbed = args.includes("--absorbed");
    const limit = parseInt(getOpt(args, "--limit") || "50", 10);
    let sql = "SELECT * FROM hints WHERE project_id = ?";
    const params = [projectId];
    if (!absorbed) { sql += " AND absorbed_at IS NULL"; }
    sql += " ORDER BY created_at DESC LIMIT ?"; params.push(limit);
    console.log(JSON.stringify(db.prepare(sql).all(...params).map(normalizeRow)));
  } finally { db.close(); }
}

function cmdEvent(args, targetDir) {
  const type = getOpt(args, "--type");
  if (!type) fail("--type is required");
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const id = randomUUID();
    db.prepare(`INSERT INTO events (id,project_id,type,severity,source,category,data_json,worker,phase,intent_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, projectId, type, getOpt(args, "--severity") || null, getOpt(args, "--source") || null,
      getOpt(args, "--category") || null, getOpt(args, "--data") || null,
      getOpt(args, "--worker") || "main", getOpt(args, "--phase") || "explore",
      getOpt(args, "--intent") || null, now());
    console.log(JSON.stringify({ ok: true, id, type }));
  } finally { db.close(); }
}

function cmdLink(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const evidence = parseJson(getOpt(args, "--evidence"), [], "--evidence");
    const id = insertLink(db, projectId, {
      from: getOpt(args, "--from"), to: getOpt(args, "--to"),
      kind: getOpt(args, "--kind") || "chain",
      description: getOpt(args, "--description") || null, evidence,
    });
    console.log(JSON.stringify({ ok: true, id }));
  } finally { db.close(); }
}

function cmdChain(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const facts = (getOpt(args, "--facts") || "").split(",").map(s => s.trim()).filter(Boolean);
    if (facts.length < 2) fail("--facts must contain at least two fact IDs");
    const evidence = parseJson(getOpt(args, "--evidence"), [], "--evidence");
    const kind = getOpt(args, "--kind") || "chain";
    const desc = getOpt(args, "--description") || null;
    const ids = [];
    for (let i = 0; i < facts.length - 1; i++)
      ids.push(insertLink(db, projectId, { from: facts[i], to: facts[i + 1], kind, description: desc, evidence }));
    console.log(JSON.stringify({ ok: true, ids }));
  } finally { db.close(); }
}

function cmdGraph(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const facts = db.prepare("SELECT * FROM facts WHERE project_id = ? ORDER BY created_at").all(projectId).map(normalizeRow);
    const intents = db.prepare("SELECT * FROM intents WHERE project_id = ? ORDER BY priority DESC, created_at").all(projectId).map(normalizeRow);
    const links = db.prepare("SELECT * FROM links WHERE project_id = ? ORDER BY created_at").all(projectId).map(normalizeRow);

    const nodes = [], edges = [];
    for (const f of facts) nodes.push({ id: f.id, kind: "fact", label: (f.description || "").slice(0, 80), source: f.source, fact_type: f.fact_type || null });
    for (const i of intents) {
      nodes.push({ id: i.id, kind: "intent", agent: i.agent, status: i.status, dispatched_by: i.dispatched_by, claimed_by: i.claimed_by, label: (i.description || "").slice(0, 80) });
      for (const fid of fromJson(i.from_json, [])) edges.push({ from: fid, to: i.id, kind: "motivates" });
      if (i.to_fact_id) edges.push({ from: i.id, to: i.to_fact_id, kind: "concludes" });
    }
    for (const l of links) edges.push({ id: l.id, from: l.from_fact_id, to: l.to_fact_id, kind: l.kind || "chain", description: l.description || undefined });
    console.log(JSON.stringify({ nodes, edges }));
  } finally { db.close(); }
}

function cmdPath(args, targetDir) {
  const fromFact = getOpt(args, "--from");
  const toFact = getOpt(args, "--to");
  if (!fromFact || !toFact) fail("--from and --to fact IDs are required");

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const intents = db.prepare("SELECT id,from_json,to_fact_id FROM intents WHERE project_id = ? AND status = 'done'").all(projectId).map(normalizeRow);
    const links = db.prepare("SELECT id,from_fact_id,to_fact_id,kind,description FROM links WHERE project_id = ?").all(projectId).map(normalizeRow);

    const intentIdx = new Map();
    for (const i of intents)
      for (const fid of fromJson(i.from_json, [])) {
        if (!intentIdx.has(fid)) intentIdx.set(fid, []);
        intentIdx.get(fid).push(i);
      }
    const linkIdx = new Map();
    for (const l of links) {
      if (!linkIdx.has(l.from_fact_id)) linkIdx.set(l.from_fact_id, []);
      linkIdx.get(l.from_fact_id).push(l);
    }

    const visited = new Set();
    const queue = [[fromFact, [fromFact]]];
    let found = null, head = 0;
    while (head < queue.length && !found) {
      const [current, path] = queue[head++];
      if (current === toFact) { found = path; break; }
      if (visited.has(current)) continue;
      visited.add(current);
      for (const i of intentIdx.get(current) || [])
        if (i.to_fact_id && !visited.has(i.to_fact_id)) queue.push([i.to_fact_id, [...path, i.id, i.to_fact_id]]);
      for (const l of linkIdx.get(current) || [])
        if (l.to_fact_id && !visited.has(l.to_fact_id)) queue.push([l.to_fact_id, [...path, l.id, l.to_fact_id]]);
    }

    if (found) {
      const allFacts = db.prepare("SELECT id,description FROM facts WHERE project_id = ?").all(projectId);
      const fMap = Object.fromEntries(allFacts.map(f => [f.id, f.description]));
      const lMap = Object.fromEntries(links.map(l => [l.id, l.description || l.kind || "link"]));
      const resolved = found.map(id => ({ id, kind: fMap[id] ? "fact" : lMap[id] ? "link" : "intent", description: fMap[id] || lMap[id] || null }));
      console.log(JSON.stringify({ found: true, path: resolved, length: found.length }));
    } else {
      console.log(JSON.stringify({ found: false, path: null }));
    }
  } finally { db.close(); }
}

function cmdStats(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const pid = getProjectId(db, getOpt(args, "--session"));
    console.log(JSON.stringify({
      project_id: pid,
      facts: db.prepare("SELECT COUNT(*) as c FROM facts WHERE project_id = ?").get(pid).c,
      intents: {
        total: db.prepare("SELECT COUNT(*) as c FROM intents WHERE project_id = ?").get(pid).c,
        open: db.prepare("SELECT COUNT(*) as c FROM intents WHERE project_id = ? AND status = 'open'").get(pid).c,
        done: db.prepare("SELECT COUNT(*) as c FROM intents WHERE project_id = ? AND status = 'done'").get(pid).c,
        failed: db.prepare("SELECT COUNT(*) as c FROM intents WHERE project_id = ? AND status = 'failed'").get(pid).c,
      },
      hints: db.prepare("SELECT COUNT(*) as c FROM hints WHERE project_id = ? AND absorbed_at IS NULL").get(pid).c,
      events: db.prepare("SELECT COUNT(*) as c FROM events WHERE project_id = ?").get(pid).c,
      links: db.prepare("SELECT COUNT(*) as c FROM links WHERE project_id = ?").get(pid).c,
      fact_sources: db.prepare("SELECT source, COUNT(*) as count FROM facts WHERE project_id = ? GROUP BY source ORDER BY count DESC").all(pid),
    }));
  } finally { db.close(); }
}

function cmdExport(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const format = getOpt(args, "--format") || "json";
    const facts = db.prepare("SELECT * FROM facts WHERE project_id = ? ORDER BY created_at").all(projectId).map(normalizeRow);
    const intents = db.prepare("SELECT * FROM intents WHERE project_id = ? ORDER BY created_at").all(projectId).map(normalizeRow);
    const events = db.prepare("SELECT * FROM events WHERE project_id = ? ORDER BY created_at").all(projectId).map(normalizeRow);
    const links = db.prepare("SELECT * FROM links WHERE project_id = ? ORDER BY created_at").all(projectId).map(normalizeRow);
    if (format === "ndjson") {
      for (const f of facts) console.log(JSON.stringify({ kind: "fact", ...f }));
      for (const i of intents) console.log(JSON.stringify({ kind: "intent", ...i }));
      for (const l of links) console.log(JSON.stringify({ kind: "link", ...l }));
    } else {
      console.log(JSON.stringify({ project_id: projectId, exported_at: now(), facts, intents, events, links }));
    }
  } finally { db.close(); }
}

// ── Main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  const cmd = (argv[0] === "--help" || argv[0] === "-h") ? null : argv[0];
  printHelp(cmd);
}

if (argv.length < 2) printHelp(null);

const [command, targetDir, ...rest] = argv;

switch (command) {
  case "init":     cmdInit(rest, targetDir); break;
  case "fact":     cmdFact(rest, targetDir); break;
  case "facts":    cmdFacts(rest, targetDir); break;
  case "intent":   cmdIntent(rest, targetDir); break;
  case "dispatch": cmdDispatch(rest, targetDir); break;
  case "claim":    cmdClaim(rest, targetDir); break;
  case "result":   cmdResult(rest, targetDir); break;
  case "conclude": cmdConclude(rest, targetDir); break;
  case "fail":     cmdFail(rest, targetDir); break;
  case "intents":  cmdIntents(rest, targetDir); break;
  case "hint":     cmdHint(rest, targetDir); break;
  case "absorb":   cmdAbsorb(rest, targetDir); break;
  case "hints":    cmdHints(rest, targetDir); break;
  case "event":    cmdEvent(rest, targetDir); break;
  case "link":     cmdLink(rest, targetDir); break;
  case "chain":    cmdChain(rest, targetDir); break;
  case "graph":    cmdGraph(rest, targetDir); break;
  case "path":     cmdPath(rest, targetDir); break;
  case "stats":    cmdStats(rest, targetDir); break;
  case "export":   cmdExport(rest, targetDir); break;
  default:
    console.error(`error: unknown command '${command}'`);
    process.exit(1);
}

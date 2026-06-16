#!/usr/bin/env node
/**
 * decx-analysis-db.mjs — SQLite proof graph for DECX vulnhunt.
 *
 * Domain-agnostic directed graph: facts (nodes) connected by edges (typed
 * relations), with intents (ephemeral work units) that group facts and edges
 * produced by a single investigation step.
 *
 * The graph IS the storage. Chains emerge from BFS traversal over edges.
 * No enum validation — domain knowledge lives in SKILL.md.
 *
 * 8 commands:
 *   init    <dir>  Create project database
 *   intent  <dir>  Declare a hypothesis to verify (from facts → goal)
 *   solve   <dir>  Atomically resolve an intent (write facts + edges, close intent)
 *   fact    <dir>  Write a single fact
 *   edge    <dir>  Connect two facts with a typed edge
 *   intents <dir>  List intents (filter by status / phase)
 *   export  <dir>  Export complete graph as JSON
 *   path    <dir>  Find connected path between two facts (BFS through edges)
 */

import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

// ── Schema (5 tables, zero field overlap) ───────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  session     TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'android_app',
  status      TEXT NOT NULL DEFAULT 'active',
  reason_seq  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  prefix      TEXT NOT NULL,             -- classification (SKILL.md defines valid values)
  body        TEXT NOT NULL,             -- the observation, ≤50 tokens
  evidence    TEXT,                      -- external reference: file path / URL (never inline data)
  confidence  REAL NOT NULL DEFAULT 1.0,
  source      TEXT NOT NULL DEFAULT 'subagent',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS intents (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  goal        TEXT NOT NULL,             -- what to prove
  phase       TEXT NOT NULL DEFAULT 'trace',
  status      TEXT NOT NULL DEFAULT 'open',
  result_fact TEXT,                      -- outcome fact ID (conclusion or dead-end); NULL while open
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS intent_sources (
  project_id  TEXT NOT NULL,
  intent_id   TEXT NOT NULL,
  fact_id     TEXT NOT NULL,
  PRIMARY KEY (project_id, intent_id, fact_id),
  FOREIGN KEY (project_id, intent_id) REFERENCES intents(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, fact_id) REFERENCES facts(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS edges (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  from_fact   TEXT NOT NULL,
  to_fact     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'proves',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, from_fact) REFERENCES facts(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, to_fact) REFERENCES facts(project_id, id) ON DELETE CASCADE,
  CHECK (from_fact != to_fact)
);

CREATE INDEX IF NOT EXISTS idx_facts_prefix ON facts(project_id, prefix);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
CREATE INDEX IF NOT EXISTS idx_intents_phase ON intents(project_id, phase);
CREATE INDEX IF NOT EXISTS idx_intent_sources_fact ON intent_sources(project_id, fact_id);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(project_id, from_fact);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(project_id, to_fact);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(project_id, kind);
`;

// ── Help ────────────────────────────────────────────────────────────────────

const HELP_TOP = `Usage: node decx-analysis-db.mjs <command> <target-dir> [options]

Domain-agnostic SQLite proof graph. Facts, intents, and typed edges.

Write:
  init    <dir>  Create project database
  fact    <dir>  Write a single fact
  edge    <dir>  Connect two facts with a typed edge
  intent  <dir>  Declare a hypothesis to verify (from facts → goal)
  solve   <dir>  Atomically resolve an intent (write facts + edges, close intent)
  update  <dir>  Update a fact's confidence

Query:
  facts   <dir>  List facts (filter by prefix / confidence / source)
  edges   <dir>  List edges (filter by from / to / kind)
  intents <dir>  List intents (filter by status / phase)
  export  <dir>  Export complete graph as JSON

Graph traversal:
  path       <dir>  Shortest path between two facts (BFS)
  ancestors  <dir>  All facts that transitively lead to a given fact (reverse BFS)
  descendants <dir> All facts reachable from a given fact (forward BFS)
  chains     <dir>  All complete chains from root prefix to leaf prefix

Run <command> --help for detailed options.`;

const HELP = {
  init: `init <dir> — Create a new analysis database and project.

Options:
  --session <name>     Session name (required, unique)
  --kind <kind>        Target kind (default: android_app). Free-form string.

Example:
  node decx-analysis-db.mjs init .decx-analysis/myapp --session myapp --kind android_app`,

  intent: `intent <dir> — Declare a hypothesis to verify.

Options:
  --goal <text>        What to prove (required)
  --from <factId,...>  Source fact IDs (optional; omit for initial surface sweep)
  --phase <stage>      Workflow stage (default: trace)
  --priority <n>       Priority, higher = first (default: 0)

Example:
  node decx-analysis-db.mjs intent .decx-analysis/myapp \\
    --from f001,f003 --goal "Trace url extra to sink" --phase trace --priority 5`,

  solve: `solve <dir> <intentId> — Close an intent after subagent writes evidence.

Subagent writes facts/edges directly via 'fact'/'edge' commands during
investigation, then calls 'solve' to mark the intent done or failed.

Arguments:
  <intentId>            Intent ID to close

Options:
  --conclude <factId>   Conclusion fact ID (the final fact the subagent wrote)
  --fail <reason>       Fail the intent (auto-writes dead-end fact)

Examples:
  node decx-analysis-db.mjs solve .decx-analysis/myapp i001 --conclude f006
  node decx-analysis-db.mjs solve .decx-analysis/myapp i001 --fail "guard non-bypassable"`,

  fact: `fact <dir> — Write a single immutable fact.

Options:
  --prefix <type>      Fact classification (required). SKILL.md defines valid values.
  --body <text>        Fact body text (required)
  --evidence <ref>     Evidence reference: file path or URL (never inline data)
  --confidence <0-1>   Confidence score (default: 1.0)
  --source <name>      Source label (default: main)

Example:
  node decx-analysis-db.mjs fact .decx-analysis/myapp \\
    --prefix entrypoint --body "exported FooActivity accepts action VIEW" \\
    --evidence /tmp/hunt/exported.json`,

  edge: `edge <dir> — Connect two existing facts with a typed edge.

Options:
  --from <factId>      Source fact ID (required)
  --to <factId>        Target fact ID (required)
  --kind <type>        Edge type (default: proves). SKILL.md defines valid values.

Example:
  node decx-analysis-db.mjs edge .decx-analysis/myapp \\
    --from f012 --to f018 --kind carry`,

  intents: `intents <dir> — List intents.

Options:
  --status <st>        Filter: open | done | failed
  --phase <stage>      Filter by phase
  --limit <n>          Max results (default: 100)

Example:
  node decx-analysis-db.mjs intents .decx-analysis/myapp --status open`,

  export: `export <dir> — Export complete graph as JSON.

Options:
  --format <f>         json (default) | ndjson

Output shape (json):
  { project, facts[], intents[], intent_sources[], edges[] }

Example:
  node decx-analysis-db.mjs export .decx-analysis/myapp`,

  path: `path <dir> — Find shortest path between two facts via BFS through edges.

Options:
  --from <factId>      Source fact ID (required)
  --to <factId>        Target fact ID (required)
  --kind <k1,k2,...>   Filter by edge kind (comma-separated)

Example:
  node decx-analysis-db.mjs path .decx-analysis/myapp --from f001 --to f018
  node decx-analysis-db.mjs path .decx-analysis/myapp --from f001 --to f018 --kind proves`,

  facts: `facts <dir> — List facts with optional filters.

Options:
  --prefix <type>      Filter by prefix (e.g. entrypoint, sink, impact)
  --min-confidence <n> Filter by minimum confidence (e.g. 0.8)
  --source <name>      Filter by source (e.g. subagent, main, reviewer)
  --limit <n>          Max results (default: 200)

Example:
  node decx-analysis-db.mjs facts .decx-analysis/myapp --prefix sink --min-confidence 0.8`,

  edges: `edges <dir> — List edges with optional filters.

Options:
  --from <factId>      Filter by source fact
  --to <factId>        Filter by target fact
  --kind <type>        Filter by edge kind (e.g. proves, carry)
  --limit <n>          Max results (default: 200)

Example:
  node decx-analysis-db.mjs edges .decx-analysis/myapp --from f001
  node decx-analysis-db.mjs edges .decx-analysis/myapp --kind carry`,

  update: `update <dir> <factId> — Update a fact's confidence.

Arguments:
  <factId>             Fact ID to update

Options:
  --confidence <0-1>   New confidence value (required)
  --source <name>      Update source label

Example:
  node decx-analysis-db.mjs update .decx-analysis/myapp f012 --confidence 0.9 --source reviewer`,

  ancestors: `ancestors <dir> — All facts that transitively lead to a given fact (reverse BFS).

Shows the full evidence chain supporting a fact: every fact that has a path
to the target through edges.

Options:
  --fact <factId>      Target fact ID (required)
  --kind <k1,k2,...>   Filter by edge kind (comma-separated)

Example:
  node decx-analysis-db.mjs ancestors .decx-analysis/myapp --fact f018
  node decx-analysis-db.mjs ancestors .decx-analysis/myapp --fact f018 --kind proves`,

  descendants: `descendants <dir> — All facts reachable from a given fact (forward BFS).

Shows what a fact leads to: every fact reachable through outgoing edges.

Options:
  --fact <factId>      Source fact ID (required)
  --kind <k1,k2,...>   Filter by edge kind (comma-separated)

Example:
  node decx-analysis-db.mjs descendants .decx-analysis/myapp --fact f001`,

  chains: `chains <dir> — Find all complete evidence chains from roots to leaves.

A chain starts at a fact with no incoming edges (root) and ends at a fact
with no outgoing edges (leaf). Results are ordered by chain length.

Options:
  --root-prefix <type>    Only start from facts with this prefix (e.g. entrypoint)
  --leaf-prefix <type>    Only end at facts with this prefix (e.g. impact)
  --kind <k1,k2,...>      Filter by edge kind (comma-separated)
  --limit <n>             Max chains (default: 20)

Example:
  node decx-analysis-db.mjs chains .decx-analysis/myapp
  node decx-analysis-db.mjs chains .decx-analysis/myapp --root-prefix entrypoint --leaf-prefix impact`,
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

function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }

function openDb(targetDir) {
  const dbPath = join(targetDir, "decx-analysis.db");
  if (!existsSync(dbPath)) fail(`database not found at ${dbPath}. Run 'init' first.`);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

function getProjectId(db, sessionName) {
  if (sessionName) {
    const row = db.prepare("SELECT id FROM projects WHERE session = ?").get(sessionName);
    if (row) return row.id;
  }
  const row = db.prepare("SELECT id FROM projects WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get();
  if (!row) fail("no active project. Use --session or run 'init' first.");
  return row.id;
}

function nextId(db, projectId, table, prefix) {
  const row = db.prepare(
    `SELECT COUNT(*) as c FROM ${table} WHERE project_id = ? AND id LIKE ?`
  ).get(projectId, `${prefix}%`);
  return `${prefix}${String((row?.c ?? 0) + 1).padStart(3, "0")}`;
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

function insertFact(db, projectId, fact) {
  if (!fact.prefix) fail("fact.prefix is required");
  if (!fact.body) fail("fact.body is required");
  const id = fact.id || nextId(db, projectId, "facts", "f");
  db.prepare(
    `INSERT INTO facts (id, project_id, prefix, body, evidence, confidence, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, projectId, fact.prefix, fact.body,
    fact.evidence || null,
    fact.confidence ?? 1.0,
    fact.source || "subagent",
    fact.created_at || now(),
  );
  return id;
}

function insertEdge(db, projectId, edge, adjCache) {
  if (!edge.from) fail("edge.from is required");
  if (!edge.to) fail("edge.to is required");
  if (edge.from === edge.to) fail(`self-loop not allowed: ${edge.from} → ${edge.to}`);
  if (!factExists(db, projectId, edge.from)) fail(`fact not found: ${edge.from}`);
  if (!factExists(db, projectId, edge.to)) fail(`fact not found: ${edge.to}`);

  // Temporal causality: an edge must go from an earlier fact to a later fact.
  // Fact IDs are sequential (f001 < f002 < ...), so from must sort before to.
  if (edge.from > edge.to) {
    fail(`edge ${edge.from} → ${edge.to} violates temporal order (evidence must flow forward in time)`);
  }

  // DAG guard: adding from→to must not create a cycle.
  // A cycle exists iff there is already a path from `to` back to `from`.
  // Use adjCache if provided (batch insertion), otherwise build from DB.
  const adj = adjCache || buildAdjacency(db, projectId);
  if (canReach(adj, edge.to, edge.from)) {
    fail(`edge ${edge.from} → ${edge.to} would create a cycle (${edge.to} already reaches ${edge.from})`);
  }

  const kind = edge.kind || "proves";
  const id = edge.id || nextId(db, projectId, "edges", "e");
  db.prepare(
    `INSERT INTO edges (id, project_id, from_fact, to_fact, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, edge.from, edge.to, kind, edge.created_at || now());

  // Incrementally update the cache so subsequent insertions in the same
  // batch see this edge without reloading from disk.
  if (adjCache) {
    if (!adjCache.has(edge.from)) adjCache.set(edge.from, []);
    adjCache.get(edge.from).push(edge.to);
  }

  return id;
}

// Build full adjacency map from DB (used for DAG guard).
function buildAdjacency(db, projectId) {
  const rows = db.prepare(
    "SELECT from_fact, to_fact FROM edges WHERE project_id = ?"
  ).all(projectId);
  const adj = new Map();
  for (const r of rows) {
    if (!adj.has(r.from_fact)) adj.set(r.from_fact, []);
    adj.get(r.from_fact).push(r.to_fact);
  }
  return adj;
}

// BFS reachability on an adjacency map: can we go from `src` to `dst`?
function canReach(adj, src, dst) {
  if (src === dst) return true;
  const visited = new Set();
  const queue = [src];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === dst) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const next of adj.get(cur) || []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return false;
}

function getIntentSources(db, projectId, intentId) {
  return db.prepare(
    "SELECT fact_id FROM intent_sources WHERE project_id = ? AND intent_id = ? ORDER BY fact_id"
  ).all(projectId, intentId).map(r => r.fact_id);
}

// ── Commands ────────────────────────────────────────────────────────────────

function cmdInit(args, targetDir) {
  const sessionName = getOpt(args, "--session");
  if (!sessionName) fail("--session <name> is required");
  const kind = getOpt(args, "--kind") || "android_app";

  mkdirSync(targetDir, { recursive: true });
  const dbPath = join(targetDir, "decx-analysis.db");

  // If DB exists, check for matching session — if found, recreate DB from scratch.
  // This lets re-init overwrite stale/incompatible data for the same session.
  const isExisting = existsSync(dbPath);
  let reused = false;
  if (isExisting) {
    let db = new DatabaseSync(dbPath);
    try {
      const existing = db.prepare("SELECT 1 FROM projects WHERE session = ?").get(sessionName);
      if (existing) {
        db.close();
        unlinkSync(dbPath);
        reused = true;
      } else {
        // Different session in same DB — validate v2 schema
        const cols = db.prepare("PRAGMA table_info(facts)").all();
        if (!cols.some(c => c.name === "prefix")) {
          db.close();
          fail(`database at ${dbPath} has an incompatible v1 schema. Delete it and re-run 'init'.`);
        }
      }
    } catch {
      // No projects table or other v1 artifact — recreate
      db.close();
      unlinkSync(dbPath);
      reused = true;
    } finally {
      try { db.close(); } catch {}
    }
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, session, kind, status, reason_seq, created_at)
     VALUES (?, ?, ?, 'active', 0, ?)`
  ).run(id, sessionName, kind, now());

  const row = db.prepare("SELECT id, kind FROM projects WHERE session = ?").get(sessionName);
  db.close();
  console.log(JSON.stringify({
    ok: true,
    action: reused ? "reinit" : (isExisting ? "project-added" : "init"),
    session: sessionName,
    project_id: row.id,
    kind: row.kind,
    db: dbPath,
  }));
}

function cmdIntent(args, targetDir) {
  const goal = getOpt(args, "--goal");
  if (!goal) fail("--goal <text> is required");
  const fromRaw = getOpt(args, "--from");
  const priority = parseInt(getOpt(args, "--priority") || "0", 10);
  const phase = getOpt(args, "--phase") || "trace";

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const fromIds = fromRaw ? fromRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
    for (const fid of fromIds) {
      if (!factExists(db, projectId, fid)) fail(`source fact not found: ${fid}`);
    }

    const id = nextId(db, projectId, "intents", "i");
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO intents (id, project_id, goal, phase, status, priority, created_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`
      ).run(id, projectId, goal, phase, priority, now());
      for (const fid of fromIds) {
        db.prepare(
          "INSERT OR IGNORE INTO intent_sources (project_id, intent_id, fact_id) VALUES (?, ?, ?)"
        ).run(projectId, id, fid);
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }

    console.log(JSON.stringify({ ok: true, id, project_id: projectId, goal, phase, from: fromIds, priority }));
  } finally { db.close(); }
}

function cmdSolve(args, targetDir) {
  const intentId = args[0];
  if (!intentId) fail("<intentId> is required (positional argument)");
  const concludeFactId = getOpt(args, "--conclude");
  const failReason = getOpt(args, "--fail");
  const sourceLabel = getOpt(args, "--source") || "subagent";

  if (!concludeFactId && !failReason) {
    fail("must provide --conclude <factId> or --fail <reason>");
  }

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const intent = getIntent(db, projectId, intentId);
    if (!intent) fail(`intent not found: ${intentId}`);
    if (intent.status !== "open") fail(`intent is not open: ${intentId} (status: ${intent.status})`);

    const sourceFacts = getIntentSources(db, projectId, intentId);
    const adjCache = buildAdjacency(db, projectId);
    let resultFactId = null;

    db.exec("BEGIN");
    try {
      if (failReason) {
        const deadId = insertFact(db, projectId, {
          prefix: "dead-end",
          body: `intent ${intentId} failed: ${failReason}`,
          source: sourceLabel,
        });
        resultFactId = deadId;
        for (const sfid of sourceFacts) {
          insertEdge(db, projectId, { from: sfid, to: deadId, kind: "proves" }, adjCache);
        }
        db.prepare(
          "UPDATE intents SET status = 'failed', result_fact = ?, resolved_at = ? WHERE id = ? AND project_id = ?"
        ).run(resultFactId, now(), intentId, projectId);
      } else {
        if (!factExists(db, projectId, concludeFactId)) {
          fail(`conclude fact not found: ${concludeFactId}`);
        }
        resultFactId = concludeFactId;
        db.prepare(
          "UPDATE intents SET status = 'done', result_fact = ?, resolved_at = ? WHERE id = ? AND project_id = ?"
        ).run(resultFactId, now(), intentId, projectId);
      }
      db.prepare("UPDATE projects SET reason_seq = reason_seq + 1 WHERE id = ?").run(projectId);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }

    console.log(JSON.stringify({
      ok: true,
      id: intentId,
      status: failReason ? "failed" : "done",
      result_fact: resultFactId,
    }));
  } finally { db.close(); }
}

function cmdFact(args, targetDir) {
  const prefix = getOpt(args, "--prefix");
  if (!prefix) fail("--prefix <type> is required");
  const body = getOpt(args, "--body");
  if (!body) fail("--body <text> is required");
  const evidence = getOpt(args, "--evidence");
  const confidence = parseFloat(getOpt(args, "--confidence") || "1.0");
  const source = getOpt(args, "--source") || "main";

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const id = insertFact(db, projectId, { prefix, body, evidence, confidence, source });
    console.log(JSON.stringify({ ok: true, id, project_id: projectId, prefix, body }));
  } finally { db.close(); }
}

function cmdEdge(args, targetDir) {
  const from = getOpt(args, "--from");
  const to = getOpt(args, "--to");
  if (!from) fail("--from <factId> is required");
  if (!to) fail("--to <factId> is required");
  const kind = getOpt(args, "--kind") || "proves";

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const id = insertEdge(db, projectId, { from, to, kind }, buildAdjacency(db, projectId));
    console.log(JSON.stringify({ ok: true, id, project_id: projectId, from, to, kind }));
  } finally { db.close(); }
}

function cmdIntents(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const status = getOpt(args, "--status");
    const phase = getOpt(args, "--phase");
    const limit = parseInt(getOpt(args, "--limit") || "100", 10);
    let sql = `
      SELECT i.*, GROUP_CONCAT(s.fact_id, ',') as source_facts
      FROM intents i
      LEFT JOIN intent_sources s ON i.project_id = s.project_id AND i.id = s.intent_id
      WHERE i.project_id = ?
    `;
    const params = [projectId];
    if (status) { sql += " AND i.status = ?"; params.push(status); }
    if (phase) { sql += " AND i.phase = ?"; params.push(phase); }
    sql += " GROUP BY i.id ORDER BY i.priority DESC, i.created_at ASC LIMIT ?";
    params.push(limit);
    console.log(JSON.stringify(db.prepare(sql).all(...params)));
  } finally { db.close(); }
}

function cmdExport(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const format = getOpt(args, "--format") || "json";

    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    const facts = db.prepare("SELECT * FROM facts WHERE project_id = ? ORDER BY created_at").all(projectId);
    const intents = db.prepare("SELECT * FROM intents WHERE project_id = ? ORDER BY created_at").all(projectId);
    const intentSources = db.prepare(
      "SELECT * FROM intent_sources WHERE project_id = ? ORDER BY intent_id, fact_id"
    ).all(projectId);
    const edges = db.prepare("SELECT * FROM edges WHERE project_id = ? ORDER BY created_at").all(projectId);

    if (format === "ndjson") {
      for (const f of facts) console.log(JSON.stringify({ kind: "fact", ...f }));
      for (const i of intents) console.log(JSON.stringify({ kind: "intent", ...i }));
      for (const e of edges) console.log(JSON.stringify({ kind: "edge", ...e }));
    } else {
      console.log(JSON.stringify({ project, facts, intents, intent_sources: intentSources, edges }));
    }
  } finally { db.close(); }
}

function cmdPath(args, targetDir) {
  const fromFact = getOpt(args, "--from");
  const toFact = getOpt(args, "--to");
  if (!fromFact || !toFact) fail("--from and --to fact IDs are required");
  const kindFilter = getOpt(args, "--kind");

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));

    let edgeSql = "SELECT id, from_fact, to_fact, kind FROM edges WHERE project_id = ?";
    const edgeParams = [projectId];
    if (kindFilter) {
      const kinds = kindFilter.split(",").map(s => s.trim()).filter(Boolean);
      const placeholders = kinds.map(() => "?").join(",");
      edgeSql += ` AND kind IN (${placeholders})`;
      edgeParams.push(...kinds);
    }
    const edges = db.prepare(edgeSql).all(...edgeParams);

    const adj = new Map();
    for (const e of edges) {
      if (!adj.has(e.from_fact)) adj.set(e.from_fact, []);
      adj.get(e.from_fact).push({ to: e.to_fact, edgeId: e.id, kind: e.kind });
    }

    const visited = new Set();
    const queue = [[fromFact, [{ id: fromFact, kind: "fact" }]]];
    let found = null;
    let head = 0;

    while (head < queue.length && !found) {
      const [current, path] = queue[head++];
      if (current === toFact) { found = path; break; }
      if (visited.has(current)) continue;
      visited.add(current);

      for (const next of adj.get(current) || []) {
        if (!visited.has(next.to)) {
          queue.push([
            next.to,
            [...path, { id: next.edgeId, kind: next.kind }, { id: next.to, kind: "fact" }],
          ]);
        }
      }
    }

    if (found) {
      const factIds = found.filter(n => n.kind === "fact").map(n => n.id);
      const placeholders = factIds.map(() => "?").join(",");
      const factRows = factIds.length > 0
        ? db.prepare(`SELECT id, prefix, body FROM facts WHERE project_id = ? AND id IN (${placeholders})`).all(projectId, ...factIds)
        : [];
      const factMap = new Map(factRows.map(f => [f.id, { prefix: f.prefix, body: f.body }]));

      const resolved = found.map(n => {
        if (n.kind === "fact") {
          const f = factMap.get(n.id);
          return { id: n.id, kind: "fact", prefix: f?.prefix || null, body: f?.body || null };
        }
        return { id: n.id, kind: n.kind };
      });

      console.log(JSON.stringify({ found: true, path: resolved, length: Math.floor(resolved.length / 2) + 1 }));
    } else {
      console.log(JSON.stringify({ found: false, path: null }));
    }
  } finally { db.close(); }
}

// ── Query commands ──────────────────────────────────────────────────────────

function cmdFacts(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const prefix = getOpt(args, "--prefix");
    const minConf = getOpt(args, "--min-confidence");
    const source = getOpt(args, "--source");
    const limit = parseInt(getOpt(args, "--limit") || "200", 10);

    let sql = "SELECT * FROM facts WHERE project_id = ?";
    const params = [projectId];
    if (prefix) { sql += " AND prefix = ?"; params.push(prefix); }
    if (minConf) { sql += " AND confidence >= ?"; params.push(parseFloat(minConf)); }
    if (source) { sql += " AND source = ?"; params.push(source); }
    sql += " ORDER BY created_at LIMIT ?";
    params.push(limit);
    console.log(JSON.stringify(db.prepare(sql).all(...params)));
  } finally { db.close(); }
}

function cmdEdges(args, targetDir) {
  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    const from = getOpt(args, "--from");
    const to = getOpt(args, "--to");
    const kind = getOpt(args, "--kind");
    const limit = parseInt(getOpt(args, "--limit") || "200", 10);

    let sql = "SELECT * FROM edges WHERE project_id = ?";
    const params = [projectId];
    if (from) { sql += " AND from_fact = ?"; params.push(from); }
    if (to) { sql += " AND to_fact = ?"; params.push(to); }
    if (kind) { sql += " AND kind = ?"; params.push(kind); }
    sql += " ORDER BY created_at LIMIT ?";
    params.push(limit);
    console.log(JSON.stringify(db.prepare(sql).all(...params)));
  } finally { db.close(); }
}

function cmdUpdate(args, targetDir) {
  const factId = args[0];
  if (!factId) fail("<factId> is required (positional argument)");
  const confidenceStr = getOpt(args, "--confidence");
  if (confidenceStr === undefined) fail("--confidence <0-1> is required");
  const confidence = parseFloat(confidenceStr);
  if (isNaN(confidence) || confidence < 0 || confidence > 1) fail("--confidence must be 0.0–1.0");
  const source = getOpt(args, "--source");

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    if (!factExists(db, projectId, factId)) fail(`fact not found: ${factId}`);
    const sets = ["confidence = ?"];
    const params = [confidence];
    if (source) { sets.push("source = ?"); params.push(source); }
    params.push(factId, projectId);
    db.prepare(`UPDATE facts SET ${sets.join(", ")} WHERE id = ? AND project_id = ?`).run(...params);
    console.log(JSON.stringify({ ok: true, id: factId, confidence, source: source || undefined }));
  } finally { db.close(); }
}

// ── Graph traversal commands ────────────────────────────────────────────────

function buildFilteredAdjacency(db, projectId, kindFilter) {
  let sql = "SELECT from_fact, to_fact, kind FROM edges WHERE project_id = ?";
  const params = [projectId];
  if (kindFilter) {
    const kinds = kindFilter.split(",").map(s => s.trim()).filter(Boolean);
    const placeholders = kinds.map(() => "?").join(",");
    sql += ` AND kind IN (${placeholders})`;
    params.push(...kinds);
  }
  const rows = db.prepare(sql).all(...params);
  return buildAdjacencyFromRows(rows);
}

function buildAdjacencyFromRows(rows) {
  const adj = new Map();
  for (const r of rows) {
    if (!adj.has(r.from_fact)) adj.set(r.from_fact, []);
    adj.get(r.from_fact).push(r.to_fact);
  }
  return adj;
}

function buildReverseAdjacency(db, projectId, kindFilter) {
  let sql = "SELECT from_fact, to_fact, kind FROM edges WHERE project_id = ?";
  const params = [projectId];
  if (kindFilter) {
    const kinds = kindFilter.split(",").map(s => s.trim()).filter(Boolean);
    const placeholders = kinds.map(() => "?").join(",");
    sql += ` AND kind IN (${placeholders})`;
    params.push(...kinds);
  }
  const rows = db.prepare(sql).all(...params);
  const adj = new Map();
  for (const r of rows) {
    if (!adj.has(r.to_fact)) adj.set(r.to_fact, []);
    adj.get(r.to_fact).push(r.from_fact);
  }
  return adj;
}

function bfsAll(adj, start) {
  const visited = new Set();
  const queue = [start];
  const result = [];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (cur !== start) result.push(cur);
    for (const next of adj.get(cur) || []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return result;
}

function enrichFacts(db, projectId, factIds) {
  if (factIds.length === 0) return [];
  const placeholders = factIds.map(() => "?").join(",");
  return db.prepare(
    `SELECT id, prefix, body, confidence, source FROM facts WHERE project_id = ? AND id IN (${placeholders}) ORDER BY id`
  ).all(projectId, ...factIds);
}

function cmdAncestors(args, targetDir) {
  const factId = getOpt(args, "--fact");
  if (!factId) fail("--fact <factId> is required");
  const kindFilter = getOpt(args, "--kind");

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    if (!factExists(db, projectId, factId)) fail(`fact not found: ${factId}`);

    const revAdj = buildReverseAdjacency(db, projectId, kindFilter);
    const ancestorIds = bfsAll(revAdj, factId);
    const ancestors = enrichFacts(db, projectId, ancestorIds);
    const target = db.prepare("SELECT id, prefix, body, confidence FROM facts WHERE project_id = ? AND id = ?").get(projectId, factId);

    console.log(JSON.stringify({ fact: target, ancestors, count: ancestors.length }));
  } finally { db.close(); }
}

function cmdDescendants(args, targetDir) {
  const factId = getOpt(args, "--fact");
  if (!factId) fail("--fact <factId> is required");
  const kindFilter = getOpt(args, "--kind");

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));
    if (!factExists(db, projectId, factId)) fail(`fact not found: ${factId}`);

    const adj = buildFilteredAdjacency(db, projectId, kindFilter);
    const descendantIds = bfsAll(adj, factId);
    const descendants = enrichFacts(db, projectId, descendantIds);
    const source = db.prepare("SELECT id, prefix, body, confidence FROM facts WHERE project_id = ? AND id = ?").get(projectId, factId);

    console.log(JSON.stringify({ fact: source, descendants, count: descendants.length }));
  } finally { db.close(); }
}

function cmdChains(args, targetDir) {
  const rootPrefix = getOpt(args, "--root-prefix");
  const leafPrefix = getOpt(args, "--leaf-prefix");
  const kindFilter = getOpt(args, "--kind");
  const limit = parseInt(getOpt(args, "--limit") || "20", 10);

  const db = openDb(targetDir);
  try {
    const projectId = getProjectId(db, getOpt(args, "--session"));

    // Build adjacency for DFS
    const adj = buildFilteredAdjacency(db, projectId, kindFilter);

    // Roots: facts with no incoming edges (respecting kind filter)
    let rootSql = `SELECT id FROM facts WHERE project_id = ? AND id NOT IN (
      SELECT to_fact FROM edges WHERE project_id = ?`;
    const rootParams = [projectId, projectId];
    if (kindFilter) {
      const kinds = kindFilter.split(",").map(s => s.trim()).filter(Boolean);
      const placeholders = kinds.map(() => "?").join(",");
      rootSql += ` AND kind IN (${placeholders})`;
      rootParams.push(...kinds);
    }
    rootSql += ")";
    if (rootPrefix) { rootSql += " AND prefix = ?"; rootParams.push(rootPrefix); }
    const roots = db.prepare(rootSql).all(...rootParams).map(r => r.id);

    // Leaves: facts with no outgoing edges (respecting kind filter)
    let leafSql = `SELECT id FROM facts WHERE project_id = ? AND id NOT IN (
      SELECT from_fact FROM edges WHERE project_id = ?`;
    const leafParams = [projectId, projectId];
    if (kindFilter) {
      const kinds = kindFilter.split(",").map(s => s.trim()).filter(Boolean);
      const placeholders = kinds.map(() => "?").join(",");
      leafSql += ` AND kind IN (${placeholders})`;
      leafParams.push(...kinds);
    }
    leafSql += ")";
    if (leafPrefix) { leafSql += " AND prefix = ?"; leafParams.push(leafPrefix); }
    const leaves = db.prepare(leafSql).all(...leafParams).map(r => r.id);

    // DFS from each root, collect all root→leaf paths
    const chains = [];
    const factMap = new Map(
      db.prepare("SELECT id, prefix, body FROM facts WHERE project_id = ?").all(projectId)
        .map(f => [f.id, f])
    );

    function dfs(node, path, visited) {
      if (leaves.includes(node) && path.length > 1) {
        chains.push([...path]);
        if (chains.length >= limit) return;
      }
      for (const next of adj.get(node) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          dfs(next, [...path, next], visited);
          visited.delete(next);
        }
        if (chains.length >= limit) return;
      }
    }

    for (const root of roots) {
      const visited = new Set([root]);
      dfs(root, [root], visited);
      if (chains.length >= limit) break;
    }

    // Enrich chain facts with prefix+body
    const enriched = chains.map((chain, idx) => ({
      chain_id: idx + 1,
      length: chain.length,
      facts: chain.map(fid => ({
        id: fid,
        prefix: factMap.get(fid)?.prefix || null,
        body: factMap.get(fid)?.body || null,
      })),
    }));

    console.log(JSON.stringify({ chains: enriched, count: enriched.length, roots: roots.length, leaves: leaves.length }));
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
  case "init":        cmdInit(rest, targetDir); break;
  case "intent":      cmdIntent(rest, targetDir); break;
  case "solve":       cmdSolve(rest, targetDir); break;
  case "fact":        cmdFact(rest, targetDir); break;
  case "edge":        cmdEdge(rest, targetDir); break;
  case "update":      cmdUpdate(rest, targetDir); break;
  case "facts":       cmdFacts(rest, targetDir); break;
  case "edges":       cmdEdges(rest, targetDir); break;
  case "intents":     cmdIntents(rest, targetDir); break;
  case "export":      cmdExport(rest, targetDir); break;
  case "path":        cmdPath(rest, targetDir); break;
  case "ancestors":   cmdAncestors(rest, targetDir); break;
  case "descendants": cmdDescendants(rest, targetDir); break;
  case "chains":      cmdChains(rest, targetDir); break;
  default:
    console.error(`error: unknown command '${command}'`);
    console.error(HELP_TOP);
    process.exit(1);
}

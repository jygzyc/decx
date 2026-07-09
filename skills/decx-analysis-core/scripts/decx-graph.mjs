#!/usr/bin/env node
/**
 * decx-graph.mjs — minimal DECX analysis DAG.
 *
 * Core graph primitives are only Fact, Intent, and Hint.
 * Links are structural provenance, not domain semantics. Domain skills define
 * fact kinds, target opening, allowed tools, evidence gates, and routing rules.
 */

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const DB_NAME = "decx-analysis.db";
const TYPES = new Set(["fact", "intent", "hint"]);
const TERMINAL = new Set(["solved", "failed", "cancelled"]);
const DEFAULT_LEASE_MS = 30 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  session     TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  evidence    TEXT,
  confidence  REAL NOT NULL DEFAULT 1.0,
  root        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS intents (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  goal        TEXT NOT NULL,
  phase       TEXT NOT NULL DEFAULT 'trace',
  status      TEXT NOT NULL DEFAULT 'open',
  priority    INTEGER NOT NULL DEFAULT 0,
  root        INTEGER NOT NULL DEFAULT 0,
  failure     TEXT,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  claimed_by  TEXT,
  claim_expires_at TEXT,
  resolved_at TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (status IN ('open','running','solved','failed','cancelled'))
);

CREATE TABLE IF NOT EXISTS hints (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  body        TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT 'human',
  root        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS links (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  from_type   TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_type     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, from_type, from_id, to_type, to_id, kind),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (from_type IN ('fact','intent','hint')),
  CHECK (to_type IN ('fact','intent','hint')),
  CHECK (from_type != to_type OR from_id != to_id)
);

CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(project_id, status);
CREATE INDEX IF NOT EXISTS idx_intents_phase ON intents(project_id, phase);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(project_id, from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(project_id, to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_links_kind ON links(project_id, kind);
`;

const HELP = `Usage: node decx-graph.mjs <command> <graph-dir> [options]

Core primitives: fact, intent, hint. The stored graph is a provenance DAG. One <graph-dir> is one analysis session and contains decx-analysis.db. Intent start is an atomic claim for parallel workers.

Write:
  init       <graph-dir>  Create one session database
  fact       <graph-dir>  Add accepted evidence fact (root or produced by one intent)
  intent     <graph-dir>  Create an analysis task from facts/intents/hints
  hint       <graph-dir>  Add human-authored guidance
  start      <graph-dir>  Atomically claim one open/expired intent as running
  renew      <graph-dir>  Renew the current worker claim for one running intent
  solve      <graph-dir>  Mark one intent solved/failed/cancelled
  link       <graph-dir>  Add a provenance link with DAG validation

Query:
  facts      <graph-dir>  List facts
  intents    <graph-dir>  List intents
  hints      <graph-dir>  List hints
  links      <graph-dir>  List links
  path       <graph-dir>  Find a shortest DAG path
  ancestors  <graph-dir>  List transitive predecessors
  descendants <graph-dir> List transitive successors
  chains     <graph-dir>  List root-to-leaf paths with chain confidence (sorted desc)
  confidence <graph-dir>  Aggregate confidence forward from a node (min over chain, max over merge)
  gate       <graph-dir>  Check an evidence gate: which required fact kinds are present on a path
  export     <graph-dir>  Export graph JSON
  check      <graph-dir>  Validate references, acyclicity, and root traceability

Confidence (0..1) is set per fact via 'fact --confidence'. Chain confidence is the
min over the facts on a chain (weakest-link rule); merging chains take the max.
'gate --from <fact> --kinds a,b,c [--threshold 0.7]' reports which required kinds
have accepted evidence on the forward path and the path's chain confidence; the
kind set is domain-defined (core never validates kind names).
`;

function die(msg) { console.error(`error: ${msg}`); process.exit(1); }
function now() { return new Date().toISOString(); }
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === "root" || key === "json") { out[key] = true; continue; }
    const val = argv[++i];
    if (val == null) die(`missing value for --${key}`);
    out[key] = val;
  }
  return out;
}
function dbPath(dir) { return join(dir, DB_NAME); }
function openDb(dir, { create = false } = {}) {
  if (create) mkdirSync(dir, { recursive: true });
  const path = dbPath(dir);
  if (!create && !existsSync(path)) die(`database not found: ${path}`);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  ensureMigrations(db);
  return db;
}

function ensureMigrations(db) {
  const cols = new Set(db.prepare("PRAGMA table_info(intents)").all().map((r) => r.name));
  if (!cols.has("claimed_by")) db.exec("ALTER TABLE intents ADD COLUMN claimed_by TEXT");
  if (!cols.has("claim_expires_at")) db.exec("ALTER TABLE intents ADD COLUMN claim_expires_at TEXT");
}

function getProject(db) {
  const p = db.prepare("SELECT * FROM projects LIMIT 1").get();
  if (!p) die("project not initialized");
  return p;
}
function nextId(db, table, prefix, projectId) {
  const rows = db.prepare(`SELECT id FROM ${table} WHERE project_id = ?`).all(projectId);
  let max = 0;
  for (const r of rows) {
    const m = String(r.id).match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}
function parseNode(raw) {
  const s = String(raw || "").trim();
  if (!s) die("empty node id");
  if (s.includes(":")) {
    const [type, id] = s.split(":", 2);
    if (!TYPES.has(type) || !id) die(`invalid node ref: ${s}`);
    return { type, id };
  }
  const p = s[0];
  if (p === "f") return { type: "fact", id: s };
  if (p === "i") return { type: "intent", id: s };
  if (p === "h") return { type: "hint", id: s };
  die(`cannot infer node type: ${s}`);
}
function parseNodes(raw) {
  if (!raw) return [];
  return String(raw).split(",").map(parseNode);
}
function tableFor(type) { return type === "fact" ? "facts" : type === "intent" ? "intents" : "hints"; }
function nodeExists(db, projectId, node) {
  return !!db.prepare(`SELECT 1 FROM ${tableFor(node.type)} WHERE project_id = ? AND id = ?`).get(projectId, node.id);
}
function assertNode(db, projectId, node) {
  if (!nodeExists(db, projectId, node)) die(`missing ${node.type}: ${node.id}`);
}
function allLinks(db, projectId) {
  return db.prepare("SELECT from_type, from_id, to_type, to_id, kind FROM links WHERE project_id = ?").all(projectId);
}
function key(n) { return `${n.type}:${n.id}`; }
function wouldCycle(db, projectId, from, to) {
  const target = key(from);
  const start = key(to);
  const adj = new Map();
  for (const l of allLinks(db, projectId)) {
    const a = `${l.from_type}:${l.from_id}`;
    const b = `${l.to_type}:${l.to_id}`;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }
  const stack = [start];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of adj.get(cur) || []) stack.push(n);
  }
  return false;
}
function insertLink(db, projectId, from, to, kind = "derives") {
  assertNode(db, projectId, from);
  assertNode(db, projectId, to);
  if (wouldCycle(db, projectId, from, to)) die(`link would create cycle: ${key(from)} -> ${key(to)}`);
  const id = nextId(db, "links", "l", projectId);
  db.prepare("INSERT OR IGNORE INTO links (id, project_id, from_type, from_id, to_type, to_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, projectId, from.type, from.id, to.type, to.id, kind, now());
  return id;
}
function print(data) { console.log(JSON.stringify(data, null, 2)); }
function roots(db, projectId) {
  return [
    ...db.prepare("SELECT 'fact' type, id FROM facts WHERE project_id=? AND root=1").all(projectId),
    ...db.prepare("SELECT 'intent' type, id FROM intents WHERE project_id=? AND root=1").all(projectId),
    ...db.prepare("SELECT 'hint' type, id FROM hints WHERE project_id=? AND root=1").all(projectId),
  ];
}
function reachableFromRoots(db, projectId) {
  const r = roots(db, projectId).map(key);
  const adj = new Map();
  for (const l of allLinks(db, projectId)) {
    const a = `${l.from_type}:${l.from_id}`;
    const b = `${l.to_type}:${l.to_id}`;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }
  const seen = new Set();
  const stack = [...r];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of adj.get(cur) || []) stack.push(n);
  }
  return seen;
}
function allNodes(db, projectId) {
  return [
    ...db.prepare("SELECT 'fact' type, id, root FROM facts WHERE project_id=?").all(projectId),
    ...db.prepare("SELECT 'intent' type, id, root FROM intents WHERE project_id=?").all(projectId),
    ...db.prepare("SELECT 'hint' type, id, root FROM hints WHERE project_id=?").all(projectId),
  ];
}
function shortestPath(db, projectId, from, to) {
  const adj = new Map();
  for (const l of allLinks(db, projectId)) {
    const a = `${l.from_type}:${l.from_id}`;
    const b = `${l.to_type}:${l.to_id}`;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ key: b, link: l });
  }
  const start = key(from), goal = key(to);
  const q = [{ k: start, path: [start], links: [] }];
  const seen = new Set([start]);
  while (q.length) {
    const cur = q.shift();
    if (cur.k === goal) return cur;
    for (const e of adj.get(cur.k) || []) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      q.push({ k: e.key, path: [...cur.path, e.key], links: [...cur.links, e.link] });
    }
  }
  return null;
}
function topoHasCycle(db, projectId) {
  const adj = new Map();
  for (const l of allLinks(db, projectId)) {
    const a = `${l.from_type}:${l.from_id}`;
    const b = `${l.to_type}:${l.to_id}`;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }
  const visiting = new Set();
  const done = new Set();
  const visit = (n) => {
    if (visiting.has(n)) return true;
    if (done.has(n)) return false;
    visiting.add(n);
    for (const m of adj.get(n) || []) if (visit(m)) return true;
    visiting.delete(n); done.add(n); return false;
  };
  return allNodes(db, projectId).some((n) => visit(key(n)));
}

function cmdInit(dir, opts) {
  if (!opts.session) die("--session required");
  const db = openDb(dir, { create: true });
  const existing = db.prepare("SELECT * FROM projects LIMIT 1").get();
  if (existing) die("project already initialized");
  db.prepare("INSERT INTO projects (id, session, kind, created_at) VALUES (?, ?, ?, ?)")
    .run("p001", opts.session, opts.kind || "analysis", now());
  print({ ok: true, db: dbPath(dir), project: { id: "p001", session: opts.session, kind: opts.kind || "analysis" } });
}
function cmdFact(dir, opts) {
  const db = openDb(dir); const p = getProject(db);
  if (!opts.kind) die("--kind required");
  if (!opts.body) die("--body required");
  const from = opts.from ? parseNode(opts.from) : null;
  if (!opts.root && (!from || from.type !== "intent")) die("fact requires --from <intentId> or --root");
  if (opts.root && from) die("root fact cannot also have --from");
  if (from) assertNode(db, p.id, from);
  const id = nextId(db, "facts", "f", p.id);
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO facts (id, project_id, kind, body, evidence, confidence, root, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, p.id, opts.kind, opts.body, opts.evidence || null, Number(opts.confidence ?? 1), opts.root ? 1 : 0, now());
    if (from) insertLink(db, p.id, from, { type: "fact", id }, "produces");
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  print({ id, type: "fact" });
}
function cmdHint(dir, opts) {
  const db = openDb(dir); const p = getProject(db);
  if (!opts.body) die("--body required");
  const sources = parseNodes(opts.from);
  if (!opts.root && sources.length === 0) die("hint requires --from <node,...> or --root");
  const id = nextId(db, "hints", "h", p.id);
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO hints (id, project_id, body, author, root, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, p.id, opts.body, opts.author || "human", opts.root ? 1 : 0, now());
    for (const s of sources) insertLink(db, p.id, s, { type: "hint", id }, "annotates");
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  print({ id, type: "hint" });
}
function cmdIntent(dir, opts) {
  const db = openDb(dir); const p = getProject(db);
  if (!opts.goal) die("--goal required");
  const sources = parseNodes(opts.from);
  if (!opts.root && sources.length === 0) die("intent requires --from <node,...> or --root");
  const id = nextId(db, "intents", "i", p.id);
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO intents (id, project_id, goal, phase, status, priority, root, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)")
      .run(id, p.id, opts.goal, opts.phase || "trace", Number(opts.priority ?? 0), opts.root ? 1 : 0, now());
    for (const s of sources) insertLink(db, p.id, s, { type: "intent", id }, "motivates");
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  print({ id, type: "intent" });
}
function leaseUntil(opts) {
  const ms = Number(opts.leaseMs ?? opts["lease-ms"] ?? DEFAULT_LEASE_MS);
  if (!Number.isFinite(ms) || ms <= 0) die("--lease-ms must be a positive number");
  return new Date(Date.now() + ms).toISOString();
}
function cmdStart(dir, opts) {
  const intentId = opts._[0]; if (!intentId) die("intent id required");
  const worker = opts.by || opts.worker; if (!worker) die("--by <generator-id> required");
  const db = openDb(dir); const p = getProject(db);
  const t = now(); const until = leaseUntil(opts);
  const result = db.prepare(`
    UPDATE intents
       SET status='running', started_at=COALESCE(started_at, ?), claimed_by=?, claim_expires_at=?
     WHERE project_id=? AND id=?
       AND (status='open' OR (status='running' AND claim_expires_at IS NOT NULL AND claim_expires_at < ?))
  `).run(t, worker, until, p.id, intentId, t);
  if (result.changes !== 1) {
    const row = db.prepare("SELECT status, claimed_by, claim_expires_at FROM intents WHERE project_id=? AND id=?").get(p.id, intentId);
    if (!row) die(`missing intent: ${intentId}`);
    die(`intent is ${row.status}${row.claimed_by ? ` claimed_by=${row.claimed_by}` : ""}${row.claim_expires_at ? ` until=${row.claim_expires_at}` : ""}, expected open or expired running`);
  }
  print({ id: intentId, status: "running", claimed_by: worker, claim_expires_at: until });
}
function cmdRenew(dir, opts) {
  const intentId = opts._[0]; if (!intentId) die("intent id required");
  const worker = opts.by || opts.worker; if (!worker) die("--by <generator-id> required");
  const db = openDb(dir); const p = getProject(db);
  const until = leaseUntil(opts);
  const result = db.prepare("UPDATE intents SET claim_expires_at=? WHERE project_id=? AND id=? AND status='running' AND claimed_by=?")
    .run(until, p.id, intentId, worker);
  if (result.changes !== 1) die(`cannot renew: ${intentId} is not running for ${worker}`);
  print({ id: intentId, status: "running", claimed_by: worker, claim_expires_at: until });
}
function cmdSolve(dir, opts) {
  const intentId = opts._[0]; if (!intentId) die("intent id required");
  const status = opts.status || (opts.fail ? "failed" : "solved");
  if (!TERMINAL.has(status)) die("--status must be solved|failed|cancelled");
  const db = openDb(dir); const p = getProject(db);
  const row = db.prepare("SELECT status FROM intents WHERE project_id=? AND id=?").get(p.id, intentId);
  if (!row) die(`missing intent: ${intentId}`);
  if (TERMINAL.has(row.status)) die(`intent already terminal: ${row.status}`);
  if (status === "failed" && !(opts.fail || opts.reason)) die("failed intent requires --fail or --reason");
  db.prepare("UPDATE intents SET status=?, failure=?, resolved_at=? WHERE project_id=? AND id=?")
    .run(status, opts.fail || opts.reason || null, now(), p.id, intentId);
  print({ id: intentId, status });
}
function cmdLink(dir, opts) {
  const db = openDb(dir); const p = getProject(db);
  if (!opts.from || !opts.to) die("--from and --to required");
  const id = insertLink(db, p.id, parseNode(opts.from), parseNode(opts.to), opts.kind || "derives");
  print({ id, type: "link" });
}
function listTable(dir, table, opts) {
  const db = openDb(dir); const p = getProject(db);
  let sql = `SELECT * FROM ${table} WHERE project_id=?`; const args = [p.id];
  if (table === "facts" && opts.kind) { sql += " AND kind=?"; args.push(opts.kind); }
  if (table === "intents" && opts.status) { sql += " AND status=?"; args.push(opts.status); }
  if (table === "intents" && opts.phase) { sql += " AND phase=?"; args.push(opts.phase); }
  sql += table === "intents" ? " ORDER BY priority DESC, id" : " ORDER BY id";
  print(db.prepare(sql).all(...args));
}
function cmdExport(dir) {
  const db = openDb(dir); const p = getProject(db);
  print({
    project: p,
    facts: db.prepare("SELECT * FROM facts WHERE project_id=? ORDER BY id").all(p.id),
    intents: db.prepare("SELECT * FROM intents WHERE project_id=? ORDER BY id").all(p.id),
    hints: db.prepare("SELECT * FROM hints WHERE project_id=? ORDER BY id").all(p.id),
    links: db.prepare("SELECT * FROM links WHERE project_id=? ORDER BY id").all(p.id),
  });
}
function cmdPath(dir, opts) {
  const db = openDb(dir); const p = getProject(db);
  if (!opts.from || !opts.to) die("--from and --to required");
  const res = shortestPath(db, p.id, parseNode(opts.from), parseNode(opts.to));
  print(res || { path: null });
}
function walk(dir, opts, reverse = false) {
  const db = openDb(dir); const p = getProject(db);
  const start = parseNode(opts.from || opts.node || opts.fact || opts.intent || opts.hint);
  assertNode(db, p.id, start);
  const adj = new Map();
  for (const l of allLinks(db, p.id)) {
    const a = `${l.from_type}:${l.from_id}`, b = `${l.to_type}:${l.to_id}`;
    const from = reverse ? b : a, to = reverse ? a : b;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }
  const seen = new Set(); const stack = [key(start)];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of adj.get(cur) || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  }
  print([...seen].sort());
}
function cmdChains(dir) {
  const db = openDb(dir); const p = getProject(db);
  const nodes = allNodes(db, p.id).map(key);
  const incoming = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map();
  for (const l of allLinks(db, p.id)) {
    const a = `${l.from_type}:${l.from_id}`, b = `${l.to_type}:${l.to_id}`;
    incoming.set(b, (incoming.get(b) || 0) + 1);
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }
  const starts = nodes.filter((n) => (incoming.get(n) || 0) === 0);
  const paths = [];
  const dfs = (n, path) => {
    const next = adj.get(n) || [];
    if (next.length === 0) {
      // Chain confidence = min confidence over the facts on this path (weakest link).
      const confs = path
        .filter((k) => k.startsWith("fact:"))
        .map((k) => nodeConfidence(db, p.id, { type: "fact", id: k.slice(5) }));
      const chainConfidence = confs.length ? Math.min(...confs) : null;
      paths.push({ path, chain_confidence: chainConfidence });
      return;
    }
    for (const m of next) dfs(m, [...path, m]);
  };
  for (const s of starts) dfs(s, [s]);
  // Sort by chain confidence descending (nulls last) so the strongest
  // evidence-backed chains surface first.
  paths.sort((a, b) => {
    if (a.chain_confidence === null) return 1;
    if (b.chain_confidence === null) return -1;
    return b.chain_confidence - a.chain_confidence;
  });
  print(paths);
}
function cmdCheck(dir) {
  const db = openDb(dir); const p = getProject(db);
  const errors = [];
  for (const l of allLinks(db, p.id)) {
    if (!nodeExists(db, p.id, { type: l.from_type, id: l.from_id })) errors.push(`dangling from ${l.id}`);
    if (!nodeExists(db, p.id, { type: l.to_type, id: l.to_id })) errors.push(`dangling to ${l.id}`);
  }
  if (topoHasCycle(db, p.id)) errors.push("cycle detected");
  const reachable = reachableFromRoots(db, p.id);
  for (const n of allNodes(db, p.id)) {
    if (!n.root && !reachable.has(key(n))) errors.push(`unreachable non-root ${key(n)}`);
  }
  print({ ok: errors.length === 0, errors });
  if (errors.length) process.exitCode = 1;
}

// --- confidence propagation ----------------------------------------------
// A fact carries its own confidence (0..1); intents/hints contribute 1.0.
// Chain confidence = min over the facts on that chain (weakest-link rule:
// a speculation-only chain is dominated by its least-proven step, which is
// what precision-first vuln hunting wants). When multiple chains merge at a
// node, take the max (the strongest supporting evidence wins).
function nodeConfidence(db, projectId, node) {
  if (node.type !== "fact") return 1;
  const row = db.prepare("SELECT confidence FROM facts WHERE project_id=? AND id=?").get(projectId, node.id);
  return row ? Number(row.confidence) : 0;
}

// Build forward adjacency (from -> [to]) over the whole graph.
function forwardAdj(db, projectId) {
  const adj = new Map();
  for (const l of allLinks(db, projectId)) {
    const a = `${l.from_type}:${l.from_id}`;
    const b = `${l.to_type}:${l.to_id}`;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ key: b, type: l.to_type, id: l.to_id });
  }
  return adj;
}

function cmdConfidence(dir, opts) {
  const db = openDb(dir); const p = getProject(db);
  if (!opts.from) die("--from <node> required");
  const start = parseNode(opts.from);
  assertNode(db, p.id, start);
  const adj = forwardAdj(db, p.id);
  // BFS forward; for each visited node keep the max chain confidence reaching it.
  // A chain confidence to a node = min(node's own confidence, max over incoming edges).
  const best = new Map();
  const startKey = key(start);
  best.set(startKey, nodeConfidence(db, p.id, start));
  const queue = [startKey];
  while (queue.length) {
    const cur = queue.shift();
    const curConf = best.get(cur);
    for (const e of adj.get(cur) || []) {
      const own = nodeConfidence(db, p.id, { type: e.type, id: e.id });
      const via = Math.min(curConf, own);
      const prev = best.get(e.key);
      if (prev === undefined || via > prev) {
        best.set(e.key, via);
        queue.push(e.key);
      }
    }
  }
  print({ from: startKey, confidence: best.get(startKey), descendants: [...best.entries()]
    .filter(([k]) => k !== startKey)
    .map(([node, confidence]) => ({ node, confidence }))
    .sort((a, b) => b.confidence - a.confidence) });
}

// --- evidence gate ---------------------------------------------------------
// A domain passes --kinds <csv> (e.g. entrypoint,reachability,control,guard,sink,impact).
// Core walks the forward DAG from --from <fact>, collects every fact reachable,
// and reports which required kinds have accepted evidence + the chain confidence.
// Core never validates kind names — that is the domain skill's contract.
function cmdGate(dir, opts) {
  const db = openDb(dir); const p = getProject(db);
  if (!opts.from) die("--from <fact> required");
  if (!opts.kinds) die("--kinds <a,b,c> required");
  const start = parseNode(opts.from);
  if (start.type !== "fact") die("--from must reference a fact");
  assertNode(db, p.id, start);

  const required = String(opts.kinds).split(",").map((s) => s.trim()).filter(Boolean);
  const threshold = opts.threshold !== undefined ? Number(opts.threshold) : null;

  // Collect all facts reachable forward from the entry fact (inclusive).
  const adj = forwardAdj(db, p.id);
  const reachable = new Set([key(start)]);
  const stack = [key(start)];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of adj.get(cur) || []) {
      if (!reachable.has(e.key)) { reachable.add(e.key); stack.push(e.key); }
    }
  }

  // Map kind -> best (highest-confidence) fact of that kind in the reachable set.
  const rows = db.prepare("SELECT id, kind, confidence FROM facts WHERE project_id=?").all(p.id);
  const byKind = new Map();
  for (const r of rows) {
    if (!reachable.has(`fact:${r.id}`)) continue;
    const prev = byKind.get(r.kind);
    if (prev === undefined || Number(r.confidence) > Number(prev.confidence)) {
      byKind.set(r.kind, { fact: r.id, kind: r.kind, confidence: Number(r.confidence) });
    }
  }

  const report = required.map((k) => byKind.get(k) || { kind: k, fact: null, confidence: null });
  const present = report.filter((r) => r.fact !== null);
  const missing = report.filter((r) => r.fact === null).map((r) => r.kind);
  // Chain confidence = min confidence over the present required facts (weakest link).
  const chainConfidence = present.length
    ? Math.min(...present.map((r) => r.confidence))
    : null;
  const complete = missing.length === 0;
  let meetsThreshold = null;
  if (threshold !== null && chainConfidence !== null) {
    meetsThreshold = chainConfidence >= threshold;
  }

  print({
    from: key(start),
    complete,
    missing,
    chain_confidence: chainConfidence,
    ...(threshold !== null ? { threshold, meets_threshold: meetsThreshold } : {}),
    required: report,
  });
}

const [cmd, dir, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "--help" || cmd === "-h") { console.log(HELP); process.exit(0); }
if (!dir) die("target dir required");
const opts = parseArgs(rest);

try {
  switch (cmd) {
    case "init": cmdInit(dir, opts); break;
    case "fact": cmdFact(dir, opts); break;
    case "hint": cmdHint(dir, opts); break;
    case "intent": cmdIntent(dir, opts); break;
    case "start": cmdStart(dir, opts); break;
    case "renew": cmdRenew(dir, opts); break;
    case "solve": cmdSolve(dir, opts); break;
    case "link": cmdLink(dir, opts); break;
    case "facts": listTable(dir, "facts", opts); break;
    case "intents": listTable(dir, "intents", opts); break;
    case "hints": listTable(dir, "hints", opts); break;
    case "links": listTable(dir, "links", opts); break;
    case "export": cmdExport(dir); break;
    case "path": cmdPath(dir, opts); break;
    case "ancestors": walk(dir, opts, true); break;
    case "descendants": walk(dir, opts, false); break;
    case "chains": cmdChains(dir); break;
    case "confidence": cmdConfidence(dir, opts); break;
    case "gate": cmdGate(dir, opts); break;
    case "check": cmdCheck(dir); break;
    default: die(`unknown command: ${cmd}`);
  }
} catch (e) {
  die(e.message || String(e));
}

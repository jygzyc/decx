import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const DB_NAME = "decx-analysis.db";
const NODE_TYPES = new Set(["fact", "intent", "hint"]);
const FACT_STATUSES = new Set(["candidate", "accepted", "rejected"]);
const INTENT_STATUSES = new Set(["open", "claimed", "done", "failed"]);
const AGENT_ROLES = new Set(["explorer", "evaluator", "metacog"]);
const AGENT_STATUSES = new Set(["active", "stopped", "completed", "context_full"]);
const HINT_STATUSES = new Set(["open", "responded", "ignored"]);
const DEFAULT_LEASE_MS = 30 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  session     TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id              TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  description     TEXT NOT NULL,
  evidence        TEXT NOT NULL DEFAULT '[]',
  source          TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  status          TEXT NOT NULL,
  parent_intent_id TEXT,
  reviewer_reason TEXT,
  root            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (status IN ('candidate','accepted','rejected'))
);

CREATE TABLE IF NOT EXISTS intents (
  id              TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  description     TEXT NOT NULL,
  creator         TEXT NOT NULL,
  parent_fact_ids TEXT NOT NULL DEFAULT '[]',
  parent_hint_ids TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'open',
  parent_intent_id TEXT,
  priority        INTEGER NOT NULL DEFAULT 0,
  root            INTEGER NOT NULL DEFAULT 0,
  failure_reason  TEXT,
  concluded_fact_id TEXT,
  created_at      TEXT NOT NULL,
  claimed_at      TEXT,
  claimed_by      TEXT,
  claim_expires_at TEXT,
  concluded_at    TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (status IN ('open','claimed','done','failed'))
);

CREATE TABLE IF NOT EXISTS hints (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  content     TEXT NOT NULL,
  creator     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  response_action TEXT,
  response_reason TEXT,
  response_target TEXT,
  responded_by TEXT,
  responded_at TEXT,
  root        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (status IN ('open','responded','ignored'))
);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  role        TEXT NOT NULL,
  session_id  TEXT,
  parent_session_id TEXT,
  target_intent_id TEXT,
  target_fact_id TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  stop_reason TEXT,
  cycle_ms    INTEGER,
  context_generation INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  last_heartbeat_at TEXT,
  stopped_at  TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (role IN ('explorer','evaluator','metacog')),
  CHECK (status IN ('active','stopped','completed','context_full'))
);

CREATE TABLE IF NOT EXISTS links (
  id          TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  from_type   TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_type     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  evidence    TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, from_type, from_id, to_type, to_id, kind),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (from_type IN ('fact','intent','hint')),
  CHECK (to_type IN ('fact','intent','hint')),
  CHECK (from_type != to_type OR from_id != to_id)
);

CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_facts_parent_intent ON facts(project_id, parent_intent_id);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(project_id, status);
CREATE INDEX IF NOT EXISTS idx_hints_status ON hints(project_id, status);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(project_id, role, status);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(project_id, from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(project_id, to_type, to_id);
`;

function die(message) { throw new Error(message); }
function now() { return new Date().toISOString(); }
function print(data) { return JSON.stringify(data, null, 2); }
function dbPath(dir) { return join(dir, DB_NAME); }

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { out._.push(arg); continue; }
    const key = arg.slice(2);
    if (["root", "json", "contextFull"].includes(key)) { out[key] = true; continue; }
    const value = argv[++i];
    if (value == null) die(`missing value for --${key}`);
    out[key] = value;
  }
  return out;
}

function parseJsonList(raw, fallback = []) {
  if (raw == null || raw === "") return fallback;
  if (Array.isArray(raw)) return raw;
  const s = String(raw).trim();
  if (!s) return fallback;
  if (s.startsWith("[")) return JSON.parse(s);
  return s.split(",").map((v) => v.trim()).filter(Boolean);
}

function openDb(dir, { create = false } = {}) {
  if (create) mkdirSync(dir, { recursive: true });
  const path = dbPath(dir);
  if (!create && !existsSync(path)) die(`database not found: ${path}`);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

function getProject(db) {
  const project = db.prepare("SELECT * FROM projects LIMIT 1").get();
  if (!project) die("project not initialized");
  return project;
}

function nextId(db, table, prefix, projectId) {
  const rows = db.prepare(`SELECT id FROM ${table} WHERE project_id=?`).all(projectId);
  let max = 0;
  for (const row of rows) {
    const match = String(row.id).match(new RegExp(`^${prefix}(\\d+)$`));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

function parseNode(raw) {
  const value = String(raw || "").trim();
  if (!value) die("empty node id");
  if (value.includes(":")) {
    const [type, id] = value.split(":", 2);
    if (!NODE_TYPES.has(type) || !id) die(`invalid node ref: ${value}`);
    return { type, id };
  }
  if (value.startsWith("f")) return { type: "fact", id: value };
  if (value.startsWith("i")) return { type: "intent", id: value };
  if (value.startsWith("h")) return { type: "hint", id: value };
  die(`cannot infer node type: ${value}`);
}

function tableFor(type) {
  if (type === "fact") return "facts";
  if (type === "intent") return "intents";
  return "hints";
}

function nodeExists(db, projectId, node) {
  return !!db.prepare(`SELECT 1 FROM ${tableFor(node.type)} WHERE project_id=? AND id=?`).get(projectId, node.id);
}

function assertNode(db, projectId, node) {
  if (!nodeExists(db, projectId, node)) die(`missing ${node.type}: ${node.id}`);
}

function allLinks(db, projectId) {
  return db.prepare("SELECT * FROM links WHERE project_id=? ORDER BY id").all(projectId);
}

function nodeKey(node) { return `${node.type}:${node.id}`; }

function wouldCycle(db, projectId, from, to) {
  const target = nodeKey(from);
  const start = nodeKey(to);
  const adj = new Map();
  for (const link of allLinks(db, projectId)) {
    const a = `${link.from_type}:${link.from_id}`;
    const b = `${link.to_type}:${link.to_id}`;
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
    for (const next of adj.get(cur) || []) stack.push(next);
  }
  return false;
}

function insertLink(db, projectId, from, to, kind = "derives", evidence = []) {
  assertNode(db, projectId, from);
  assertNode(db, projectId, to);
  if (wouldCycle(db, projectId, from, to)) die(`link would create cycle: ${nodeKey(from)} -> ${nodeKey(to)}`);
  const id = nextId(db, "links", "l", projectId);
  db.prepare("INSERT OR IGNORE INTO links (id, project_id, from_type, from_id, to_type, to_id, kind, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, projectId, from.type, from.id, to.type, to.id, kind, JSON.stringify(evidence), now());
  return id;
}

function openHints(db, projectId) {
  return db.prepare("SELECT * FROM hints WHERE project_id=? AND status='open' ORDER BY id").all(projectId);
}

function requireNoOpenHints(db, projectId, action, addressedHintIds = []) {
  const addressed = new Set(addressedHintIds);
  const blocking = openHints(db, projectId).filter((hint) => !addressed.has(hint.id));
  if (blocking.length) die(`${action} blocked by open hints: ${blocking.map((h) => h.id).join(",")}`);
}

function respondHintRows(db, projectId, hintIds, action, reason, target) {
  for (const hintId of hintIds) {
    const hint = db.prepare("SELECT * FROM hints WHERE project_id=? AND id=?").get(projectId, hintId);
    if (!hint) die(`missing hint: ${hintId}`);
    if (hint.status !== "open") die(`hint is not open: ${hintId} (status=${hint.status})`);
    db.prepare("UPDATE hints SET status=?, response_action=?, response_reason=?, response_target=?, responded_by='planner', responded_at=? WHERE project_id=? AND id=?")
      .run(action === "ignore" ? "ignored" : "responded", action, reason || null, target || null, now(), projectId, hintId);
  }
}

function requireAcceptedFact(db, projectId, factId, label) {
  const fact = db.prepare("SELECT * FROM facts WHERE project_id=? AND id=?").get(projectId, factId);
  if (!fact) die(`missing ${label}: ${factId}`);
  if (fact.status !== "accepted") die(`${label} must be accepted: ${factId} (status=${fact.status})`);
  return fact;
}

function requireActiveAgent(db, projectId, role, agentId) {
  if (!agentId) die(`${role} action requires --by <${role}-id>`);
  const agent = db.prepare("SELECT * FROM agents WHERE project_id=? AND id=? AND role=? AND status='active'").get(projectId, agentId, role);
  if (!agent) die(`active ${role} not found: ${agentId}`);
  return agent;
}

function cmdInit(dir, opts) {
  if (!opts.session) die("--session required");
  const db = openDb(dir, { create: true });
  if (db.prepare("SELECT 1 FROM projects LIMIT 1").get()) die("project already initialized");
  db.prepare("INSERT INTO projects (id, session, kind, created_at) VALUES (?, ?, ?, ?)")
    .run("p001", opts.session, opts.kind || "analysis", now());
  return print({ ok: true, db: dbPath(dir), project: { id: "p001", session: opts.session, kind: opts.kind || "analysis" } });
}

function cmdFact(dir, opts) {
  const db = openDb(dir); const project = getProject(db);
  if (!opts.root) die("planner fact requires --root");
  if (!opts.body && !opts.description) die("fact requires --body or --description");
  requireNoOpenHints(db, project.id, "add root fact");
  const id = nextId(db, "facts", "f", project.id);
  db.prepare("INSERT INTO facts (id, project_id, description, evidence, source, confidence, status, root, created_at) VALUES (?, ?, ?, ?, 'planner', ?, 'accepted', 1, ?)")
    .run(id, project.id, opts.description || opts.body, JSON.stringify(parseJsonList(opts.evidence)), Number(opts.confidence ?? 1), now());
  return print({ id, type: "fact", status: "accepted" });
}

function cmdIntent(dir, opts) {
  const db = openDb(dir); const project = getProject(db);
  if (!opts.goal && !opts.description) die("intent requires --goal or --description");
  const parentFactIds = parseJsonList(opts.from || opts.parentFactIds);
  const parentHintIds = parseJsonList(opts.fromHints || opts.parentHintIds || opts.hints);
  if (!opts.root && parentFactIds.length === 0 && parentHintIds.length === 0) die("intent requires --root, --from, or --fromHints");
  requireNoOpenHints(db, project.id, "create intent", parentHintIds);
  for (const factId of parentFactIds) requireAcceptedFact(db, project.id, factId, "parent fact");
  for (const hintId of parentHintIds) assertNode(db, project.id, { type: "hint", id: hintId });
  const id = nextId(db, "intents", "i", project.id);
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO intents (id, project_id, description, creator, parent_fact_ids, parent_hint_ids, status, parent_intent_id, priority, root, created_at) VALUES (?, ?, ?, 'planner', ?, ?, 'open', ?, ?, ?, ?)")
      .run(id, project.id, opts.description || opts.goal, JSON.stringify(parentFactIds), JSON.stringify(parentHintIds), opts.parentIntentId || null, Number(opts.priority ?? 0), opts.root ? 1 : 0, now());
    for (const factId of parentFactIds) insertLink(db, project.id, { type: "fact", id: factId }, { type: "intent", id }, "motivates");
    for (const hintId of parentHintIds) insertLink(db, project.id, { type: "hint", id: hintId }, { type: "intent", id }, "corrects");
    if (parentHintIds.length) respondHintRows(db, project.id, parentHintIds, "create_intent", opts.responseReason || "planner created intent from hint", `intent:${id}`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return print({ id, type: "intent", status: "open" });
}

function cmdHint(dir, opts) {
  const db = openDb(dir); const project = getProject(db);
  if (!opts.body && !opts.content) die("hint requires --body or --content");
  const requestedCreator = opts.creator || opts.author || "human";
  const creator = requestedCreator === "metacog"
    ? requireActiveAgent(db, project.id, "metacog", opts.by).id
    : requestedCreator;
  const from = parseJsonList(opts.from);
  const id = nextId(db, "hints", "h", project.id);
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO hints (id, project_id, content, creator, status, root, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?)")
      .run(id, project.id, opts.content || opts.body, creator, from.length === 0 ? 1 : 0, now());
    for (const raw of from) insertLink(db, project.id, parseNode(raw), { type: "hint", id }, "flags");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return print({ id, type: "hint", status: "open", creator });
}

function cmdRespondHint(dir, opts) {
  const hintIds = parseJsonList(opts.hints || opts.hint || opts._[0]);
  if (!hintIds.length) die("respond-hint requires --hint/--hints");
  const action = opts.action || "acknowledge";
  if (!opts.reason) die("respond-hint requires --reason");
  const db = openDb(dir); const project = getProject(db);
  respondHintRows(db, project.id, hintIds, action, opts.reason, opts.target || null);
  return print({ ok: true, hints: hintIds, action, target: opts.target || null });
}

function leaseUntil(opts) {
  const ms = Number(opts.leaseMs ?? opts["lease-ms"] ?? DEFAULT_LEASE_MS);
  if (!Number.isFinite(ms) || ms <= 0) die("--lease-ms must be positive");
  return new Date(Date.now() + ms).toISOString();
}

function cmdClaim(dir, opts) {
  const intentId = opts._[0]; if (!intentId) die("claim requires intent id");
  const worker = opts.by || opts.worker; if (!worker) die("claim requires --by <explorer-id>");
  const db = openDb(dir); const project = getProject(db);
  const agent = db.prepare("SELECT * FROM agents WHERE project_id=? AND id=? AND role='explorer' AND status='active'").get(project.id, worker);
  if (!agent) die(`active explorer not found: ${worker}`);
  if (agent.target_intent_id && agent.target_intent_id !== intentId) die(`explorer ${worker} is bound to ${agent.target_intent_id}`);
  const claimedAt = now(); const expiresAt = leaseUntil(opts);
  const result = db.prepare("UPDATE intents SET status='claimed', claimed_at=COALESCE(claimed_at, ?), claimed_by=?, claim_expires_at=? WHERE project_id=? AND id=? AND (status='open' OR (status='claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at < ?))")
    .run(claimedAt, worker, expiresAt, project.id, intentId, claimedAt);
  if (result.changes !== 1) die(`intent cannot be claimed: ${intentId}`);
  return print({ id: intentId, status: "claimed", claimed_by: worker, claim_expires_at: expiresAt });
}

function cmdRenew(dir, opts) {
  const intentId = opts._[0]; if (!intentId) die("renew requires intent id");
  const worker = opts.by || opts.worker; if (!worker) die("renew requires --by <explorer-id>");
  const db = openDb(dir); const project = getProject(db);
  const agent = db.prepare("SELECT * FROM agents WHERE project_id=? AND id=? AND role='explorer' AND status='active'").get(project.id, worker);
  if (!agent) die(`active explorer not found: ${worker}`);
  const expiresAt = leaseUntil(opts);
  const result = db.prepare("UPDATE intents SET claim_expires_at=? WHERE project_id=? AND id=? AND status='claimed' AND claimed_by=?")
    .run(expiresAt, project.id, intentId, worker);
  if (result.changes !== 1) die(`cannot renew: ${intentId} is not claimed by ${worker}`);
  return print({ id: intentId, status: "claimed", claimed_by: worker, claim_expires_at: expiresAt });
}

function cmdCandidate(dir, opts) {
  const db = openDb(dir); const project = getProject(db);
  if (!opts.from) die("candidate requires --from <intentId>");
  if (!opts.body && !opts.description) die("candidate requires --body or --description");
  requireNoOpenHints(db, project.id, "add candidate fact");
  const agent = requireActiveAgent(db, project.id, "explorer", opts.by);
  if (agent.target_intent_id && agent.target_intent_id !== opts.from) die(`explorer ${agent.id} is bound to ${agent.target_intent_id}`);
  const intent = db.prepare("SELECT * FROM intents WHERE project_id=? AND id=?").get(project.id, opts.from);
  if (!intent) die(`missing intent: ${opts.from}`);
  if (intent.status !== "claimed") die(`intent is not claimed: ${opts.from} (status=${intent.status})`);
  if (intent.claimed_by !== agent.id) die(`intent ${opts.from} is claimed by ${intent.claimed_by || "nobody"}`);
  const id = nextId(db, "facts", "f", project.id);
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO facts (id, project_id, description, evidence, source, confidence, status, parent_intent_id, root, created_at) VALUES (?, ?, ?, ?, 'explorer', ?, 'candidate', ?, 0, ?)")
      .run(id, project.id, opts.description || opts.body, JSON.stringify(parseJsonList(opts.evidence)), Number(opts.confidence ?? 0.7), opts.from, now());
    insertLink(db, project.id, { type: "intent", id: opts.from }, { type: "fact", id }, "produces");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return print({ id, type: "fact", status: "candidate" });
}

function cmdConclude(dir, opts) {
  const intentId = opts._[0]; if (!intentId) die("conclude requires intent id");
  const factId = opts.fact || opts.factId;
  const db = openDb(dir); const project = getProject(db);
  requireNoOpenHints(db, project.id, "conclude intent");
  const agent = requireActiveAgent(db, project.id, "explorer", opts.by);
  if (agent.target_intent_id && agent.target_intent_id !== intentId) die(`explorer ${agent.id} is bound to ${agent.target_intent_id}`);
  if (factId) {
    const fact = db.prepare("SELECT * FROM facts WHERE project_id=? AND id=?").get(project.id, factId);
    if (!fact) die(`missing fact: ${factId}`);
    if (fact.source !== "explorer") die(`concluded fact must be explorer-produced: ${factId}`);
    if (fact.parent_intent_id !== intentId) die(`concluded fact ${factId} belongs to ${fact.parent_intent_id || "no intent"}, not ${intentId}`);
    if (fact.status === "rejected") die(`concluded fact is rejected: ${factId}`);
  }
  const result = db.prepare("UPDATE intents SET status='done', concluded_fact_id=?, concluded_at=? WHERE project_id=? AND id=? AND status='claimed' AND claimed_by=?")
    .run(factId || null, now(), project.id, intentId, agent.id);
  if (result.changes !== 1) die(`cannot conclude intent: ${intentId}`);
  db.prepare("UPDATE agents SET status='completed', stopped_at=? WHERE project_id=? AND id=? AND role='explorer' AND status='active'").run(now(), project.id, agent.id);
  return print({ id: intentId, status: "done", concluded_fact_id: factId || null });
}

function cmdFailIntent(dir, opts) {
  const intentId = opts.intent || opts._[0]; if (!intentId) die("fail-intent requires intent id");
  const factId = opts.fact || opts.factId; if (!factId) die("fail-intent requires --fact <acceptedFactId>");
  if (!opts.reason) die("fail-intent requires --reason");
  const hintIds = parseJsonList(opts.hints || opts.hint);
  const db = openDb(dir); const project = getProject(db);
  requireNoOpenHints(db, project.id, "fail intent", hintIds);
  requireAcceptedFact(db, project.id, factId, "failure evidence fact");
  const result = db.prepare("UPDATE intents SET status='failed', failure_reason=?, concluded_fact_id=?, concluded_at=?, claimed_by=NULL, claim_expires_at=NULL WHERE project_id=? AND id=? AND status IN ('open','claimed','done')")
    .run(opts.reason, factId, now(), project.id, intentId);
  if (result.changes !== 1) die(`cannot fail intent: ${intentId}`);
  if (hintIds.length) respondHintRows(db, project.id, hintIds, "fail_intent", opts.reason, `intent:${intentId}`);
  return print({ id: intentId, status: "failed", failure_reason: opts.reason, evidence_fact_id: factId });
}

function cmdVerdict(dir, opts) {
  const factId = opts.fact || opts._[0]; if (!factId) die("verdict requires --fact or fact id argument");
  const decision = opts.decision; if (!["accept", "reject", "demote"].includes(decision)) die("--decision must be accept|reject|demote");
  if (!opts.reason) die("verdict requires --reason");
  const db = openDb(dir); const project = getProject(db);
  const agent = requireActiveAgent(db, project.id, "evaluator", opts.by);
  if (agent.target_fact_id && agent.target_fact_id !== factId) die(`evaluator ${agent.id} is bound to ${agent.target_fact_id}`);
  const fact = db.prepare("SELECT * FROM facts WHERE project_id=? AND id=?").get(project.id, factId);
  if (!fact) die(`missing fact: ${factId}`);
  if (fact.status !== "candidate") die(`fact is not candidate: ${factId} (status=${fact.status})`);
  const status = decision === "reject" ? "rejected" : "accepted";
  const confidence = decision === "demote" && opts.confidence != null ? Number(opts.confidence) : fact.confidence;
  db.prepare("UPDATE facts SET status=?, confidence=?, reviewer_reason=? WHERE project_id=? AND id=?")
    .run(status, confidence, opts.reason, project.id, factId);
  db.prepare("UPDATE agents SET status='completed', stopped_at=? WHERE project_id=? AND id=? AND role='evaluator' AND status='active'").run(now(), project.id, agent.id);
  return print({ id: factId, type: "fact", status, decision, confidence, reviewer_reason: opts.reason });
}

function cmdSpawnAgent(dir, opts) {
  const role = opts.role; if (!AGENT_ROLES.has(role)) die("spawn-agent --role must be explorer|evaluator|metacog");
  const db = openDb(dir); const project = getProject(db);
  requireNoOpenHints(db, project.id, `spawn ${role}`);
  if (role === "explorer") {
    if (!opts.intent) die("spawn explorer requires --intent");
    const intent = db.prepare("SELECT * FROM intents WHERE project_id=? AND id=?").get(project.id, opts.intent);
    if (!intent || !["open", "claimed"].includes(intent.status)) die(`explorer target intent must be open/claimed: ${opts.intent}`);
    if (db.prepare("SELECT 1 FROM agents WHERE project_id=? AND role='explorer' AND target_intent_id=? AND status='active'").get(project.id, opts.intent)) {
      die(`active explorer already exists for intent: ${opts.intent}`);
    }
  }
  if (role === "evaluator") {
    if (!opts.fact) die("spawn evaluator requires --fact");
    const fact = db.prepare("SELECT * FROM facts WHERE project_id=? AND id=?").get(project.id, opts.fact);
    if (!fact || fact.status !== "candidate") die(`evaluator target fact must be candidate: ${opts.fact}`);
    if (db.prepare("SELECT 1 FROM agents WHERE project_id=? AND role='evaluator' AND target_fact_id=? AND status='active'").get(project.id, opts.fact)) {
      die(`active evaluator already exists for fact: ${opts.fact}`);
    }
  }
  if (role === "metacog" && db.prepare("SELECT 1 FROM agents WHERE project_id=? AND role='metacog' AND status='active'").get(project.id)) die("active metacog already exists");
  const id = nextId(db, "agents", role[0], project.id);
  db.prepare("INSERT INTO agents (id, project_id, role, session_id, parent_session_id, target_intent_id, target_fact_id, status, cycle_ms, created_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)")
    .run(id, project.id, role, opts.sessionId || null, opts.parentSessionId || null, opts.intent || null, opts.fact || null, Number(opts.cycleMs ?? 30000), now(), now());
  return print({ id, type: "agent", role, status: "active", session_id: opts.sessionId || null, target_intent_id: opts.intent || null, target_fact_id: opts.fact || null, cycle_ms: Number(opts.cycleMs ?? 30000) });
}

function cmdStopAgent(dir, opts) {
  const agentId = opts.agent || opts._[0]; if (!agentId) die("stop-agent requires agent id");
  if (!opts.reason) die("stop-agent requires --reason");
  const hintIds = parseJsonList(opts.hints || opts.hint);
  const db = openDb(dir); const project = getProject(db);
  requireNoOpenHints(db, project.id, "stop agent", hintIds);
  const agent = db.prepare("SELECT * FROM agents WHERE project_id=? AND id=? AND status='active'").get(project.id, agentId);
  if (!agent) die(`active agent not found: ${agentId}`);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE agents SET status=?, stop_reason=?, stopped_at=? WHERE project_id=? AND id=?")
      .run(opts.contextFull ? "context_full" : "stopped", opts.reason, now(), project.id, agentId);
    if (agent.role === "explorer" && agent.target_intent_id) {
      db.prepare("UPDATE intents SET status='open', claimed_at=NULL, claimed_by=NULL, claim_expires_at=NULL WHERE project_id=? AND id=? AND status='claimed' AND claimed_by=?")
        .run(project.id, agent.target_intent_id, agentId);
    }
    if (hintIds.length) respondHintRows(db, project.id, hintIds, "stop_agent", opts.reason, `agent:${agentId}`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return print({ id: agentId, type: "agent", status: opts.contextFull ? "context_full" : "stopped", reason: opts.reason, session_id: agent.session_id || null });
}

function cmdHeartbeatAgent(dir, opts) {
  const agentId = opts.agent || opts._[0]; if (!agentId) die("heartbeat-agent requires agent id");
  const db = openDb(dir); const project = getProject(db);
  const result = db.prepare("UPDATE agents SET last_heartbeat_at=? WHERE project_id=? AND id=? AND status='active'").run(now(), project.id, agentId);
  if (result.changes !== 1) die(`active agent not found: ${agentId}`);
  return print({ id: agentId, heartbeat_at: now() });
}

function cmdSetAgentSession(dir, opts) {
  const agentId = opts.agent || opts._[0]; if (!agentId) die("set-agent-session requires agent id");
  if (!opts.sessionId) die("set-agent-session requires --sessionId");
  const db = openDb(dir); const project = getProject(db);
  const result = db.prepare("UPDATE agents SET session_id=? WHERE project_id=? AND id=? AND status='active'")
    .run(opts.sessionId, project.id, agentId);
  if (result.changes !== 1) die(`active agent not found: ${agentId}`);
  return print({ id: agentId, session_id: opts.sessionId });
}

function listTable(dir, table, opts) {
  const db = openDb(dir); const project = getProject(db);
  let sql = `SELECT * FROM ${table} WHERE project_id=?`; const args = [project.id];
  if (table === "facts" && opts.status) { sql += " AND status=?"; args.push(opts.status); }
  if (table === "facts" && opts.source) { sql += " AND source=?"; args.push(opts.source); }
  if (table === "intents" && opts.status) { sql += " AND status=?"; args.push(opts.status); }
  if (table === "hints" && opts.status) { sql += " AND status=?"; args.push(opts.status); }
  if (table === "agents" && opts.role) { sql += " AND role=?"; args.push(opts.role); }
  if (table === "agents" && opts.status) { sql += " AND status=?"; args.push(opts.status); }
  sql += table === "intents" ? " ORDER BY priority DESC, id" : " ORDER BY id";
  return print(db.prepare(sql).all(...args));
}

function cmdExport(dir) {
  const db = openDb(dir); const project = getProject(db);
  return print({
    project,
    facts: db.prepare("SELECT * FROM facts WHERE project_id=? ORDER BY id").all(project.id),
    intents: db.prepare("SELECT * FROM intents WHERE project_id=? ORDER BY id").all(project.id),
    hints: db.prepare("SELECT * FROM hints WHERE project_id=? ORDER BY id").all(project.id),
    agents: db.prepare("SELECT * FROM agents WHERE project_id=? ORDER BY id").all(project.id),
    links: db.prepare("SELECT * FROM links WHERE project_id=? ORDER BY id").all(project.id),
  });
}

function roots(db, projectId) {
  return [
    ...db.prepare("SELECT 'fact' type, id FROM facts WHERE project_id=? AND root=1").all(projectId),
    ...db.prepare("SELECT 'intent' type, id FROM intents WHERE project_id=? AND root=1").all(projectId),
    ...db.prepare("SELECT 'hint' type, id FROM hints WHERE project_id=? AND root=1").all(projectId),
  ];
}

function allNodes(db, projectId) {
  return [
    ...db.prepare("SELECT 'fact' type, id, root FROM facts WHERE project_id=?").all(projectId),
    ...db.prepare("SELECT 'intent' type, id, root FROM intents WHERE project_id=?").all(projectId),
    ...db.prepare("SELECT 'hint' type, id, root FROM hints WHERE project_id=?").all(projectId),
  ];
}

function reachableFromRoots(db, projectId) {
  const adj = new Map();
  for (const link of allLinks(db, projectId)) {
    const from = `${link.from_type}:${link.from_id}`;
    const to = `${link.to_type}:${link.to_id}`;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }
  const stack = roots(db, projectId).map(nodeKey);
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) || []) stack.push(next);
  }
  return seen;
}

function shortestPath(db, projectId, from, to) {
  const adj = new Map();
  for (const link of allLinks(db, projectId)) {
    const a = `${link.from_type}:${link.from_id}`;
    const b = `${link.to_type}:${link.to_id}`;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }
  const start = nodeKey(from); const goal = nodeKey(to);
  const queue = [{ key: start, path: [start] }];
  const seen = new Set([start]);
  while (queue.length) {
    const cur = queue.shift();
    if (cur.key === goal) return cur.path;
    for (const next of adj.get(cur.key) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ key: next, path: [...cur.path, next] });
    }
  }
  return null;
}

function cmdPath(dir, opts) {
  if (!opts.from || !opts.to) die("path requires --from and --to");
  const db = openDb(dir); const project = getProject(db);
  return print({ path: shortestPath(db, project.id, parseNode(opts.from), parseNode(opts.to)) });
}

function walk(dir, opts, reverse = false) {
  const start = parseNode(opts.from || opts.node || opts.fact || opts.intent || opts.hint);
  const db = openDb(dir); const project = getProject(db);
  assertNode(db, project.id, start);
  const adj = new Map();
  for (const link of allLinks(db, project.id)) {
    const a = `${link.from_type}:${link.from_id}`;
    const b = `${link.to_type}:${link.to_id}`;
    const from = reverse ? b : a;
    const to = reverse ? a : b;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }
  const seen = new Set(); const stack = [nodeKey(start)];
  while (stack.length) {
    const cur = stack.pop();
    for (const next of adj.get(cur) || []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
  }
  return print([...seen].sort());
}

function cmdChains(dir) {
  const db = openDb(dir); const project = getProject(db);
  const nodes = allNodes(db, project.id).map(nodeKey);
  const incoming = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map();
  for (const link of allLinks(db, project.id)) {
    const from = `${link.from_type}:${link.from_id}`;
    const to = `${link.to_type}:${link.to_id}`;
    incoming.set(to, (incoming.get(to) || 0) + 1);
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }
  const paths = [];
  const dfs = (node, path) => {
    const next = adj.get(node) || [];
    if (!next.length) { paths.push(path); return; }
    for (const child of next) dfs(child, [...path, child]);
  };
  for (const node of nodes.filter((n) => (incoming.get(n) || 0) === 0)) dfs(node, [node]);
  return print(paths);
}

function cmdProofChains(dir) {
  const db = openDb(dir); const project = getProject(db);
  const acceptedFacts = new Set(db.prepare("SELECT id FROM facts WHERE project_id=? AND status='accepted'").all(project.id).map((row) => `fact:${row.id}`));
  const usefulIntents = new Set(db.prepare("SELECT id FROM intents WHERE project_id=? AND status!='failed'").all(project.id).map((row) => `intent:${row.id}`));
  const allowedNode = (key) => {
    if (key.startsWith("fact:")) return acceptedFacts.has(key);
    if (key.startsWith("intent:")) return usefulIntents.has(key);
    return false;
  };
  const nodes = [...acceptedFacts, ...usefulIntents];
  const incoming = new Map(nodes.map((node) => [node, 0]));
  const adj = new Map();
  for (const link of allLinks(db, project.id)) {
    const from = `${link.from_type}:${link.from_id}`;
    const to = `${link.to_type}:${link.to_id}`;
    if (!allowedNode(from) || !allowedNode(to)) continue;
    incoming.set(to, (incoming.get(to) || 0) + 1);
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }
  const paths = [];
  const dfs = (node, path) => {
    const next = adj.get(node) || [];
    if (!next.length) {
      if (path.some((item) => item.startsWith("fact:"))) paths.push(path);
      return;
    }
    for (const child of next) dfs(child, [...path, child]);
  };
  for (const node of nodes.filter((item) => allowedNode(item) && (incoming.get(item) || 0) === 0)) dfs(node, [node]);
  return print(paths);
}

function cmdCheck(dir) {
  const db = openDb(dir); const project = getProject(db);
  const errors = [];
  for (const link of allLinks(db, project.id)) {
    if (!nodeExists(db, project.id, { type: link.from_type, id: link.from_id })) errors.push(`dangling from ${link.id}`);
    if (!nodeExists(db, project.id, { type: link.to_type, id: link.to_id })) errors.push(`dangling to ${link.id}`);
  }
  const reachable = reachableFromRoots(db, project.id);
  for (const node of allNodes(db, project.id)) {
    if (!node.root && !reachable.has(nodeKey(node))) errors.push(`unreachable non-root ${nodeKey(node)}`);
  }
  const activeMetacog = db.prepare("SELECT COUNT(*) count FROM agents WHERE project_id=? AND role='metacog' AND status='active'").get(project.id).count;
  if (activeMetacog > 1) errors.push("more than one active metacog");
  const duplicateExplorers = db.prepare("SELECT target_intent_id, COUNT(*) count FROM agents WHERE project_id=? AND role='explorer' AND status='active' AND target_intent_id IS NOT NULL GROUP BY target_intent_id HAVING COUNT(*) > 1").all(project.id);
  for (const row of duplicateExplorers) errors.push(`multiple active explorers for intent ${row.target_intent_id}`);
  const duplicateEvaluators = db.prepare("SELECT target_fact_id, COUNT(*) count FROM agents WHERE project_id=? AND role='evaluator' AND status='active' AND target_fact_id IS NOT NULL GROUP BY target_fact_id HAVING COUNT(*) > 1").all(project.id);
  for (const row of duplicateEvaluators) errors.push(`multiple active evaluators for fact ${row.target_fact_id}`);
  for (const fact of db.prepare("SELECT * FROM facts WHERE project_id=? AND source='explorer'").all(project.id)) {
    if (!fact.parent_intent_id) errors.push(`explorer fact without parent intent ${fact.id}`);
    if (fact.parent_intent_id && !nodeExists(db, project.id, { type: "intent", id: fact.parent_intent_id })) errors.push(`explorer fact ${fact.id} points to missing intent ${fact.parent_intent_id}`);
  }
  for (const intent of db.prepare("SELECT * FROM intents WHERE project_id=? AND concluded_fact_id IS NOT NULL").all(project.id)) {
    const fact = db.prepare("SELECT * FROM facts WHERE project_id=? AND id=?").get(project.id, intent.concluded_fact_id);
    if (!fact) errors.push(`intent ${intent.id} concludes missing fact ${intent.concluded_fact_id}`);
    else if (fact.parent_intent_id !== intent.id) errors.push(`intent ${intent.id} concludes fact ${fact.id} from ${fact.parent_intent_id || "no intent"}`);
    else if (fact.status === "rejected") errors.push(`intent ${intent.id} concludes rejected fact ${fact.id}`);
  }
  if (errors.length) throw new Error(JSON.stringify({ ok: false, errors }, null, 2));
  return print({ ok: true, errors });
}

export const graphCommands = Object.freeze([
  "init", "fact", "intent", "hint", "respond-hint", "claim", "renew", "candidate", "conclude", "fail-intent", "verdict",
  "spawn-agent", "stop-agent", "heartbeat-agent",
  "set-agent-session",
  "facts", "intents", "hints", "agents", "links", "export", "path", "ancestors", "descendants", "chains", "proof-chains", "check",
]);

export function runDecxGraph(command, dir, argv = []) {
  if (!command) throw new Error("command required");
  if (!dir) throw new Error("target dir required");
  const opts = parseArgs(argv);
  switch (command) {
    case "init": return cmdInit(dir, opts);
    case "fact": return cmdFact(dir, opts);
    case "intent": return cmdIntent(dir, opts);
    case "hint": return cmdHint(dir, opts);
    case "respond-hint": return cmdRespondHint(dir, opts);
    case "claim": return cmdClaim(dir, opts);
    case "renew": return cmdRenew(dir, opts);
    case "candidate": return cmdCandidate(dir, opts);
    case "conclude": return cmdConclude(dir, opts);
    case "fail-intent": return cmdFailIntent(dir, opts);
    case "verdict": return cmdVerdict(dir, opts);
    case "spawn-agent": return cmdSpawnAgent(dir, opts);
    case "stop-agent": return cmdStopAgent(dir, opts);
    case "heartbeat-agent": return cmdHeartbeatAgent(dir, opts);
    case "set-agent-session": return cmdSetAgentSession(dir, opts);
    case "facts": return listTable(dir, "facts", opts);
    case "intents": return listTable(dir, "intents", opts);
    case "hints": return listTable(dir, "hints", opts);
    case "agents": return listTable(dir, "agents", opts);
    case "links": return listTable(dir, "links", opts);
    case "export": return cmdExport(dir);
    case "path": return cmdPath(dir, opts);
    case "ancestors": return walk(dir, opts, true);
    case "descendants": return walk(dir, opts, false);
    case "chains": return cmdChains(dir);
    case "proof-chains": return cmdProofChains(dir);
    case "check": return cmdCheck(dir);
    default: throw new Error(`unknown command: ${command}`);
  }
}

export function decxGraphDbPath(dir) {
  return dbPath(dir);
}

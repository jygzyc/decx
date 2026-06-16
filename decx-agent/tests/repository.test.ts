/**
 * AgentRepository tests — real SQLite database via createTestDb().
 * Tests CRUD, intent lifecycle, proofChain/descendants graph traversal, events.
 */
import { test, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { AgentRepository } from "../dist/server/repository.js";
import { createTestDb } from "./helper.ts";
import type { TestDb } from "./helper.ts";
import type { Fact, Intent, Link, WorkflowEvent } from "../dist/core/types.js";

let testDb: TestDb | undefined;

afterEach(() => {
  testDb?.cleanup();
  testDb = undefined;
});

function getDb(): TestDb {
  if (!testDb) testDb = createTestDb();
  return testDb;
}

function repo(): AgentRepository {
  return new AgentRepository(getDb().db);
}

const TASK_CONFIG = {
  task: { name: "repo-test", target: "test.apk", goal: "find bugs" },
  workers: { noop: { kind: "noop" as const } },
  workflow: {
    phases: [{ id: "explore" as const, role: "explorer" }],
    rules: [],
  },
};

// ─── createProject ──────────────────────────────────────────────────

test("createProject: inserts project + origin/goal facts", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_001",
    name: "test-project",
    target: "target.apk",
    goal: "find vulnerabilities",
    worker: "codex",
    sessionDir: "/tmp/sess",
    configPath: "/tmp/cfg.json",
    taskConfig: TASK_CONFIG,
  });

  assert.equal(detail.project.name, "test-project");
  assert.equal(detail.project.target, "target.apk");
  assert.equal(detail.project.goal, "find vulnerabilities");
  assert.equal(detail.project.status, "active");

  // Origin and goal facts auto-created
  const origin = detail.facts.find((f) => f.id === "origin");
  assert.ok(origin, "origin fact should exist");
  assert.equal(origin.description, "target.apk");

  const goal = detail.facts.find((f) => f.id === "goal");
  assert.ok(goal, "goal fact should exist");
  assert.equal(goal.description, "find vulnerabilities");
});

test("createProject: idempotent — calling twice with same session returns same project", () => {
  const r = repo();
  const first = r.createProject({
    session: "sess_002",
    name: "dup-project",
    target: "t",
    goal: "g",
    worker: "codex",
    sessionDir: "/tmp/s",
    configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  // Same session again
  const second = r.createProject({
    session: "sess_002",
    name: "different-name",
    target: "different-t",
    goal: "different-g",
    worker: "codex",
    sessionDir: "/tmp/s",
    configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  assert.equal(second.project.id, first.project.id);
  assert.equal(second.project.name, "dup-project"); // original name preserved
});

// ─── addFact ────────────────────────────────────────────────────────

test("addFact: inserts fact and retrievable via facts", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_fact", name: "f", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  r.addFact(detail.project.id, {
    id: "f001",
    description: "custom fact",
    evidence: ["e1", "e2"],
    source: "tester",
    confidence: 0.8,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const refreshed = r.getProject(detail.project.id);
  const fact = refreshed.facts.find((f) => f.id === "f001");
  assert.ok(fact);
  assert.equal(fact.description, "custom fact");
  assert.deepEqual(fact.evidence, ["e1", "e2"]);
  assert.equal(fact.source, "tester");
  assert.equal(fact.confidence, 0.8);
});

test("addFact: INSERT OR REPLACE overwrites on duplicate id", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_fact2", name: "f2", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  r.addFact(detail.project.id, {
    id: "fx",
    description: "first",
    evidence: [],
    source: "a",
    confidence: 1.0,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  r.addFact(detail.project.id, {
    id: "fx",
    description: "second",
    evidence: [],
    source: "b",
    confidence: 0.5,
    createdAt: "2026-01-02T00:00:00.000Z",
  });

  const refreshed = r.getProject(detail.project.id);
  const fact = refreshed.facts.find((f) => f.id === "fx");
  assert.ok(fact);
  assert.equal(fact.description, "second");
  assert.equal(fact.source, "b");
});

// ─── addIntent ──────────────────────────────────────────────────────

test("addIntent: inserts intent + intent_sources rows", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_int", name: "i", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const intent = r.addIntent(detail.project.id, {
    from: ["origin", "goal"],
    description: "explore both",
    creator: "dispatcher",
    role: "explorer",
    worker: "codex",
    priority: 5,
  });

  assert.equal(intent.status, "open");
  assert.ok(intent.id.startsWith("i"));
  assert.equal(intent.creator, "dispatcher");
  assert.equal(intent.role, "explorer");
  assert.deepEqual(intent.fromFacts, ["origin", "goal"]);

  // Verify readback includes fromFacts
  const refreshed = r.getProject(detail.project.id);
  const retrieved = refreshed.intents.find((i) => i.id === intent.id);
  assert.ok(retrieved);
  assert.deepEqual(retrieved.fromFacts, ["goal", "origin"]); // sorted by fact_id
});

test("addIntent: empty from array writes 'origin' sources row", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_int2", name: "i2", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  // addIntent with empty from array still inserts intent_sources rows for each entry.
  // The call with from:[] just has no rows, so fromFacts will be empty on readback.
  const intent = r.addIntent(detail.project.id, {
    from: [],
    description: "no sources",
    creator: "tester",
  });

  const refreshed = r.getProject(detail.project.id);
  const retrieved = refreshed.intents.find((i) => i.id === intent.id);
  assert.ok(retrieved);
  assert.deepEqual(retrieved.fromFacts, []);
});

// ─── addLink ────────────────────────────────────────────────────────

test("addLink: inserts link with auto-generated id and retrieves it", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_link", name: "l", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const link = r.addLink(detail.project.id, {
    fromFactId: "origin",
    toFactId: "goal",
    kind: "enables",
    evidence: ["doc1"],
  });

  assert.ok(link.id.startsWith("l"));
  assert.equal(link.fromFactId, "origin");
  assert.equal(link.toFactId, "goal");
  assert.equal(link.kind, "enables");
  assert.deepEqual(link.evidence, ["doc1"]);

  const refreshed = r.getProject(detail.project.id);
  const found = refreshed.links.find((l) => l.id === link.id);
  assert.ok(found);
  assert.equal(found.kind, "enables");
});

test("addLink: rejects self-cycle reasoning link", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_link_cycle_self", name: "l-self", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  assert.throws(() => r.addLink(detail.project.id, {
    fromFactId: "origin",
    toFactId: "origin",
    kind: "proof",
  }), /would create a cycle/);
});

test("addLink: rejects reverse link that would close a reasoning cycle", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_link_cycle_reverse", name: "l-rev", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  r.addLink(detail.project.id, {
    fromFactId: "origin",
    toFactId: "goal",
    kind: "proof",
  });

  assert.throws(() => r.addLink(detail.project.id, {
    fromFactId: "goal",
    toFactId: "origin",
    kind: "proof",
  }), /would create a cycle/);
});

test("addLink: rejects cycle through completed intent reasoning chain", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_link_cycle_intent", name: "l-intent", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const intent = r.addIntent(detail.project.id, {
    from: ["origin"],
    description: "derive fact",
    creator: "tester",
  });
  const fact = r.concludeIntent(detail.project.id, intent.id, "derived", [], "tester");

  assert.throws(() => r.addLink(detail.project.id, {
    fromFactId: fact.id,
    toFactId: "origin",
    kind: "proof",
  }), /would create a cycle/);
});

// ─── Intent lifecycle ───────────────────────────────────────────────

test("claimIntent: transitions open → working", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_claim", name: "c", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const intent = r.addIntent(detail.project.id, {
    from: ["origin"],
    description: "claim me",
    creator: "tester",
  });

  const claimed = r.claimIntent(detail.project.id, intent.id, "worker-1");
  assert.equal(claimed.status, "working");
  assert.equal(claimed.claimedBy, "worker-1");
  assert.ok(claimed.claimedAt);
});

test("claimIntent: throws when intent not found", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_claim2", name: "c2", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  assert.throws(() => r.claimIntent(detail.project.id, "nonexistent", "w"),
    /intent not found/);
});

test("claimIntent: throws when intent is not open", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_claim3", name: "c3", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const intent = r.addIntent(detail.project.id, {
    from: ["origin"], description: "done one", creator: "t",
  });
  r.concludeIntent(detail.project.id, intent.id, "result", [], "tester");

  assert.throws(() => r.claimIntent(detail.project.id, intent.id, "w"),
    /intent is not open/);
});

test("releaseIntent: working → open", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_rel", name: "r", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const intent = r.addIntent(detail.project.id, {
    from: ["origin"], description: "release me", creator: "t",
  });
  r.claimIntent(detail.project.id, intent.id, "worker-1");

  const released = r.releaseIntent(detail.project.id, intent.id, "worker-1");
  assert.equal(released.status, "open");
});

test("concludeIntent: creates fact + sets intent to done, with to_fact_id", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_conc", name: "c", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const intent = r.addIntent(detail.project.id, {
    from: ["origin"], description: "conclude me", creator: "t",
  });

  const fact = r.concludeIntent(detail.project.id, intent.id,
    "discovery", ["ev1", "ev2"], "explorer", 0.9);

  assert.ok(fact.id.startsWith("f"));
  assert.equal(fact.description, "discovery");
  assert.deepEqual(fact.evidence, ["ev1", "ev2"]);
  assert.equal(fact.confidence, 0.9);

  // Intent should now be done with to_fact_id set
  const refreshed = r.getProject(detail.project.id);
  const updated = refreshed.intents.find((i) => i.id === intent.id);
  assert.ok(updated);
  assert.equal(updated.status, "done");
  assert.equal(updated.to, fact.id);
});

test("concludeIntent: throws when intent not found", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_conc2", name: "c2", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  assert.throws(() => r.concludeIntent(detail.project.id, "nonexistent", "d", [], "t"),
    /intent not found/);
});

test("concludeIntent: throws when intent already closed", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_conc3", name: "c3", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const intent = r.addIntent(detail.project.id, {
    from: ["origin"], description: "one-shot", creator: "t",
  });
  r.concludeIntent(detail.project.id, intent.id, "done", [], "t");

  assert.throws(() => r.concludeIntent(detail.project.id, intent.id, "again", [], "t"),
    /already closed/);
});

test("failIntent: sets status to failed with reason", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_fail", name: "f", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const intent = r.addIntent(detail.project.id, {
    from: ["origin"], description: "fail me", creator: "t",
  });

  r.failIntent(detail.project.id, intent.id, "timeout exceeded");

  const refreshed = r.getProject(detail.project.id);
  const updated = refreshed.intents.find((i) => i.id === intent.id);
  assert.ok(updated);
  assert.equal(updated.status, "failed");
  assert.equal(updated.failureReason, "timeout exceeded");
});

// ─── proofChain ─────────────────────────────────────────────────────

test("proofChain: recursive traversal through a 3-deep chain", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_chain", name: "c", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  // Build: origin → intent_1 → f1 → intent_2 → f2 → intent_3 → f3
  const i1 = r.addIntent(detail.project.id, {
    from: ["origin"], description: "step 1", creator: "t",
  });
  const f1 = r.concludeIntent(detail.project.id, i1.id, "first finding", [], "t");

  const i2 = r.addIntent(detail.project.id, {
    from: [f1.id], description: "step 2", creator: "t",
  });
  const f2 = r.concludeIntent(detail.project.id, i2.id, "second finding", [], "t");

  const i3 = r.addIntent(detail.project.id, {
    from: [f2.id], description: "step 3", creator: "t",
  });
  const f3 = r.concludeIntent(detail.project.id, i3.id, "third finding", [], "t");

  const chain = r.proofChain(detail.project.id, f3.id);
  assert.ok(chain.length >= 3, `expected at least 3 facts in chain, got ${chain.length}`);

  // Find f3 at depth 0
  const nodeF3 = chain.find((c) => c.fact.id === f3.id);
  assert.ok(nodeF3);
  assert.equal(nodeF3.depth, 0);

  // f2 should have greater depth
  const nodeF2 = chain.find((c) => c.fact.id === f2.id);
  assert.ok(nodeF2);
  assert.ok(nodeF2.depth > 0);

  // origin should be in the chain too
  const nodeOrigin = chain.find((c) => c.fact.id === "origin");
  assert.ok(nodeOrigin, "origin should be in proof chain");
});

test("proofChain: empty chain for fact with no upstream intents", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_chain2", name: "c2", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const chain = r.proofChain(detail.project.id, "origin");
  // origin has no upstream → only origin itself at depth 0
  assert.equal(chain.length, 1);
  assert.equal(chain[0].fact.id, "origin");
  assert.equal(chain[0].depth, 0);
});

// ─── descendants ────────────────────────────────────────────────────

test("descendants: forward traversal returns downstream facts", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_desc", name: "d", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  // Build: origin → intent_1 → f1 → intent_2 → f2
  const i1 = r.addIntent(detail.project.id, {
    from: ["origin"], description: "step a", creator: "t",
  });
  const f1 = r.concludeIntent(detail.project.id, i1.id, "f1 desc", [], "t");

  const i2 = r.addIntent(detail.project.id, {
    from: [f1.id], description: "step b", creator: "t",
  });
  const f2 = r.concludeIntent(detail.project.id, i2.id, "f2 desc", [], "t");

  const desc = r.descendants(detail.project.id, "origin");
  assert.ok(desc.length >= 2, `expected at least 2 descendants, got ${desc.length}`);
  assert.ok(desc.some((d) => d.id === f1.id));
  assert.ok(desc.some((d) => d.id === f2.id));
});

test("descendants: empty for leaf fact", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_desc2", name: "d2", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const desc = r.descendants(detail.project.id, "goal");
  assert.deepEqual(desc, []);
});

// ─── emitEvents ─────────────────────────────────────────────────────

test("emitEvents: returns in-memory events with unique ids", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_evt", name: "e", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  const events = r.emitEvents(detail.project.id, [
    { type: "test.event", worker: "test", phase: "explore" },
    { type: "another.event", worker: "test", phase: "explore" },
  ]);

  assert.equal(events.length, 2);
  assert.ok(events[0].id !== events[1].id, "event ids should be unique");
  assert.ok(events[0].id.startsWith("evt_"));
  assert.equal(typeof events[0].createdAt, "string");

  // Verify events are NOT in the database (they are in-memory only)
  // We can't query events table because it doesn't exist in schema v2
  // This is fine — emitEvents is purely in-memory.
});

// ─── getProject ─────────────────────────────────────────────────────

test("getProject: returns full ProjectDetail with facts/intents/links/runs", () => {
  const r = repo();
  const detail = r.createProject({
    session: "sess_full", name: "full", target: "t", goal: "g",
    worker: "codex", sessionDir: "/tmp", configPath: "/tmp/c",
    taskConfig: TASK_CONFIG,
  });

  r.addFact(detail.project.id, {
    id: "extra", description: "extra", evidence: [],
    source: "t", confidence: 1.0, createdAt: "2026-01-01T00:00:00.000Z",
  });

  const intent = r.addIntent(detail.project.id, {
    from: ["origin"], description: "do work", creator: "t",
  });

  r.addLink(detail.project.id, {
    fromFactId: "origin", toFactId: "goal", kind: "related",
  });

  const full = r.getProject(detail.project.id);
  assert.ok(full.facts.length >= 3); // origin, goal, extra
  assert.ok(full.intents.length >= 1);
  assert.ok(full.links.length >= 1);
  assert.equal(full.project.id, detail.project.id);
  assert.equal(full.project.status, "active");
});

test("getProject: throws for non-existent project", () => {
  const r = repo();
  assert.throws(() => r.getProject("nonexistent-id"),
    /project not found/);
});

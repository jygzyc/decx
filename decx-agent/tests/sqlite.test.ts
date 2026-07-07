import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGraph } from "../dist/graph/sqlite-graph.js";
import { SessionManager } from "../dist/session/session-manager.js";
import { FederatedGraph } from "../dist/graph/federated-graph.js";
import type { TaskConfig } from "../dist/agent/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "decx-sqlite-"));
}

function config(): TaskConfig {
  const p = {
    runtime: { worker: "w" },
    prompt: { file: "prompts/x.md" },
    context: { graphView: "full" as const },
    permissions: [],
    output: { contract: "main_decision" as const },
    role: "test",
  };
  return {
    task: { target: "T", goal: "G" },
    profiles: { planner: p, explorer: p, evaluator: p },
    workers: { w: { kind: "mock" } },
    workflow: { limits: {} },
  };
}

test("SqliteGraph: createProject + addFact + resolveFact roundtrip", () => {
  const dir = tempDir();
  const dbPath = join(dir, "test.db");
  const g = new SqliteGraph(dbPath);

  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  assert.equal(p.status, "active");
  assert.equal(g.facts(p.id).length, 0);

  const f = g.addFact(p.id, { description: "test fact", source: "explorer", confidence: 0.8 });
  assert.equal(f.id, "f001");
  assert.equal(f.status, "candidate");

  g.resolveFact(p.id, f.id, { decision: "accept", reason: "ok" });
  assert.equal(g.getFact(p.id, f.id)!.status, "accepted");

  g.close();
});

test("SqliteGraph: blocked fact persists and can be promoted", () => {
  const dir = tempDir();
  const dbPath = join(dir, "test.db");
  const g = new SqliteGraph(dbPath);
  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  const f = g.addFact(p.id, { description: "conditional", source: "explorer", confidence: 0.8 });
  g.resolveFact(p.id, f.id, { decision: "block", reason: "needs device state", requiredConditions: ["device unlocked"] });
  assert.equal(g.getFact(p.id, f.id)!.status, "blocked");
  assert.deepEqual(g.getFact(p.id, f.id)!.requiredConditions, ["device unlocked"]);
  assert.equal(g.progress(p.id).blockedFacts, 1);
  g.close();

  const g2 = new SqliteGraph(dbPath);
  const loaded = g2.getProject("s1")!;
  assert.equal(g2.getFact(loaded.id, f.id)!.status, "blocked");
  g2.resolveFact(loaded.id, f.id, { decision: "accept", reason: "condition satisfied", confidence: 0.7 });
  assert.equal(g2.getFact(loaded.id, f.id)!.status, "accepted");
  g2.close();
});


test("SqliteGraph: intent lifecycle (add → claim → conclude)", () => {
  const dir = tempDir();
  const g = new SqliteGraph(join(dir, "test.db"));
  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  const intent = g.addIntent(p.id, { description: "do x", creator: "planner" });
  assert.equal(intent.status, "open");

  g.claimIntent(p.id, intent.id, "w1", 60000);
  assert.equal(g.getIntent(p.id, intent.id)!.status, "claimed");

  const fact = g.addFact(p.id, { description: "result", source: "explorer" });
  g.concludeIntent(p.id, intent.id, fact.id);
  assert.equal(g.getIntent(p.id, intent.id)!.status, "done");
  g.close();
});

test("SqliteGraph: failIntent with killedBy", () => {
  const dir = tempDir();
  const g = new SqliteGraph(join(dir, "test.db"));
  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  const intent = g.addIntent(p.id, { description: "do x", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 60000);
  g.failIntent(p.id, intent.id, "wrong direction", false, "planner");
  const failed = g.getIntent(p.id, intent.id);
  assert.equal(failed!.status, "failed");
  assert.equal(failed!.killedBy, "planner");
  g.close();
});

test("SqliteGraph: hint with kind and targetIntentId", () => {
  const dir = tempDir();
  const g = new SqliteGraph(join(dir, "test.db"));
  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  const h = g.addHint(p.id, {
    content: "stop this", creator: "metacog",
    kind: "stop-explorer", targetIntentId: intent.id,
  });
  assert.equal(h.kind, "stop-explorer");
  assert.equal(h.targetIntentId, intent.id);
  assert.equal(g.unconsumedHints(p.id).length, 1);
  g.consumeHint(p.id, h.id);
  assert.equal(g.unconsumedHints(p.id).length, 0);
  g.close();
});

test("SqliteGraph: persistence survives reopen", () => {
  const dir = tempDir();
  const dbPath = join(dir, "persist.db");
  const g1 = new SqliteGraph(dbPath);
  const p = g1.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  g1.addFact(p.id, { description: "persisted fact", source: "explorer", confidence: 0.9 });
  g1.close();

  const g2 = new SqliteGraph(dbPath);
  const loaded = g2.getProject("s1");
  assert.ok(loaded);
  const facts = g2.facts(loaded!.id);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].description, "persisted fact");
  g2.close();
});

test("SqliteGraph: progress computes correctly", () => {
  const dir = tempDir();
  const g = new SqliteGraph(join(dir, "test.db"));
  const p = g.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: dir, configPath: "/tmp", taskConfig: config(),
  });
  g.addFact(p.id, { description: "f1", source: "explorer" });
  g.addFact(p.id, { description: "f2", source: "explorer" });
  const pr = g.progress(p.id);
  assert.equal(pr.totalFacts, 2);
  assert.equal(pr.candidateFacts, 2);
  assert.equal(pr.acceptedFacts, 0);
  g.close();
});

test("SessionManager: open, list, delete", () => {
  const base = tempDir();
  const sm = new SessionManager(base);
  const g1 = sm.open("session-a");
  const g2 = sm.open("session-b");
  assert.ok(sm.info("session-a").exists);
  assert.ok(sm.info("session-b").exists);
  const sessions = sm.listSessions();
  assert.ok(sessions.includes("session-a"));
  assert.ok(sessions.includes("session-b"));
  sm.delete("session-a");
  assert.ok(!sm.info("session-a").exists);
  assert.ok(sm.info("session-b").exists);
  if (g1 instanceof SqliteGraph) g1.close();
  if (g2 instanceof SqliteGraph) g2.close();
});

test("FederatedGraph: search facts across sessions", () => {
  const base = tempDir();
  const sm = new SessionManager(base);
  const fed = new FederatedGraph(sm);

  const g1 = sm.open("app-a") as SqliteGraph;
  const g2 = sm.open("app-b") as SqliteGraph;

  const p1 = g1.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: base, configPath: "/tmp",
    taskConfig: config(),
  });
  g1.addFact(p1.id, { description: "WebView vulnerability in app-a", source: "explorer", confidence: 0.9 });

  const p2 = g2.createProject({
    session: "s2", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: base, configPath: "/tmp",
    taskConfig: config(),
  });
  g2.addFact(p2.id, { description: "WebView bypass in app-b", source: "explorer", confidence: 0.8 });

  const allAccepted = fed.searchFactsAcrossSessions(["app-a", "app-b"], { status: "candidate" });
  assert.equal(allAccepted.length, 2);

  const webviewOnly = fed.searchFactsAcrossSessions(["app-a", "app-b"], { query: "WebView" });
  assert.equal(webviewOnly.length, 2);

  const appAOnly = fed.searchFactsAcrossSessions(["app-a", "app-b"], { query: "app-a" });
  assert.equal(appAOnly.length, 1);
  assert.equal(appAOnly[0].sessionId, "app-a");

  g1.close();
  g2.close();
});

test("FederatedGraph: search intents across sessions", () => {
  const base = tempDir();
  const sm = new SessionManager(base);
  const fed = new FederatedGraph(sm);

  const g1 = sm.open("sess-x") as SqliteGraph;
  const g2 = sm.open("sess-y") as SqliteGraph;

  const p1 = g1.createProject({
    session: "s1", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: base, configPath: "/tmp",
    taskConfig: config(),
  });
  g1.addIntent(p1.id, { description: "analyze crypto module", creator: "planner" });

  const p2 = g2.createProject({
    session: "s2", name: "n", target: "T", goal: "G",
    worker: "w", sessionDir: base, configPath: "/tmp",
    taskConfig: config(),
  });
  g2.addIntent(p2.id, { description: "analyze network module", creator: "planner" });

  const results = fed.searchIntentsAcrossSessions(["sess-x", "sess-y"], "crypto");
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, "sess-x");
  assert.equal(results[0].intent.description, "analyze crypto module");

  g1.close();
  g2.close();
});

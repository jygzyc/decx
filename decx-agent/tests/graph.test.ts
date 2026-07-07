import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { createProject } from "./helper.ts";

test("createProject starts with zero facts", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  assert.equal(g.facts(p.id).length, 0);
});

test("addIntent starts as open", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const i = g.addIntent(p.id, { description: "do x", creator: "planner" });
  assert.equal(i.id, "i001");
  assert.equal(i.status, "open");
});

test("claimIntent transitions open → claimed", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  const claimed = g.claimIntent(p.id, intent.id, "w1", 1000);
  assert.equal(claimed.status, "claimed");
});

test("failIntent records killedBy", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 1000);
  g.failIntent(p.id, intent.id, "wrong direction", false, "planner");
  const failed = g.getIntent(p.id, intent.id);
  assert.equal(failed!.status, "failed");
  assert.equal(failed!.killedBy, "planner");
});

test("failIntent with recordDeadEnd=false does not record dead-end", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "Investigate X", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 1000);
  g.failIntent(p.id, intent.id, "transient", false);
  assert.ok(!g.isDeadEnd(p.id, "investigate x"));
});

test("hint defaults to kind=direction", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const h = g.addHint(p.id, { content: "try X", creator: "metacog" });
  assert.equal(h.kind, "direction");
  assert.equal(h.targetIntentId, undefined);
});

test("hint can carry stop-explorer kind + targetIntentId", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  const h = g.addHint(p.id, { content: "stop this", creator: "metacog", kind: "stop-explorer", targetIntentId: intent.id });
  assert.equal(h.kind, "stop-explorer");
  assert.equal(h.targetIntentId, intent.id);
});

test("sweepExpiredLeases releases claimed intents past expiry", async () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(g.sweepExpiredLeases() >= 1);
  assert.equal(g.getIntent(p.id, intent.id)!.status, "open");
});

test("directive queue filters by consumedAt", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  g.addDirective(p.id, { kind: "stop", payload: "done" });
  g.addDirective(p.id, { kind: "hint", payload: "try X" });
  assert.equal(g.unconsumedDirectives(p.id).length, 2);
  const dirs = g.unconsumedDirectives(p.id);
  g.consumeDirective(p.id, dirs[0].id);
  assert.equal(g.unconsumedDirectives(p.id).length, 1);
});

test("progress stagnation resets on fact accept", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 1000);
  g.failIntent(p.id, intent.id, "failed", false);
  assert.equal(g.progress(p.id).stagnationLevel, 1);
  const fact = g.addFact(p.id, { description: "good", source: "explorer" });
  g.resolveFact(p.id, fact.id, { decision: "accept", reason: "ok" });
  assert.equal(g.progress(p.id).stagnationLevel, 0);
});

test("blocked fact stays in graph, is low weight, and can be promoted later", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const f = g.addFact(p.id, { description: "reachable only after login", source: "explorer", confidence: 0.9 });

  g.resolveFact(p.id, f.id, {
    decision: "block",
    reason: "missing auth precondition",
    requiredConditions: ["valid login session"],
  });

  const blocked = g.getFact(p.id, f.id)!;
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.confidence, 0.35);
  assert.deepEqual(blocked.requiredConditions, ["valid login session"]);
  assert.equal(g.progress(p.id).blockedFacts, 1);

  g.resolveFact(p.id, f.id, { decision: "accept", reason: "precondition satisfied by another session", confidence: 0.75 });
  const accepted = g.getFact(p.id, f.id)!;
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.confidence, 0.75);
});


test("addLink creates a link between two facts", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const f1 = g.addFact(p.id, { description: "source fact", source: "explorer" });
  const f2 = g.addFact(p.id, { description: "derived fact", source: "explorer" });
  const link = g.addLink(p.id, { fromFactId: f1.id, toFactId: f2.id, kind: "supports" });
  assert.ok(link.id);
  assert.equal(link.fromFactId, f1.id);
  assert.equal(link.toFactId, f2.id);
  assert.equal(link.kind, "supports");
});

test("links() returns all links for a project", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const f1 = g.addFact(p.id, { description: "a", source: "explorer" });
  const f2 = g.addFact(p.id, { description: "b", source: "explorer" });
  const f3 = g.addFact(p.id, { description: "c", source: "explorer" });
  g.addLink(p.id, { fromFactId: f1.id, toFactId: f2.id, kind: "supports" });
  g.addLink(p.id, { fromFactId: f2.id, toFactId: f3.id, kind: "contradicts", evidence: ["x"] });
  const links = g.links(p.id);
  assert.equal(links.length, 2);
  assert.deepEqual(links[0]!.evidence, []);
  assert.deepEqual(links[1]!.evidence, ["x"]);
});

test("links() isolated per project", () => {
  const g = new InMemoryGraph();
  const p1 = createProject(g, { session: "s-link-1" });
  const p2 = createProject(g, { session: "s-link-2" });
  const f1 = g.addFact(p1.id, { description: "a", source: "explorer" });
  const f2 = g.addFact(p1.id, { description: "b", source: "explorer" });
  g.addLink(p1.id, { fromFactId: f1.id, toFactId: f2.id, kind: "supports" });
  assert.equal(g.links(p1.id).length, 1);
  assert.equal(g.links(p2.id).length, 0);
});

test("claimIntent on non-open intent throws", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 1000);
  assert.throws(
    () => g.claimIntent(p.id, intent.id, "w2", 1000),
    /is not open/,
  );
});

test("concludeIntent on already-done intent throws", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 1000);
  g.concludeIntent(p.id, intent.id, "f001");
  assert.throws(
    () => g.concludeIntent(p.id, intent.id, "f002"),
    /already concluded/,
  );
});

test("failIntent on already-failed intent throws", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.failIntent(p.id, intent.id, "first failure", false);
  assert.throws(
    () => g.failIntent(p.id, intent.id, "second failure", false),
    /already failed/,
  );
});

test("resolveFact on already-resolved fact throws", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const f = g.addFact(p.id, { description: "x", source: "explorer" });
  g.resolveFact(p.id, f.id, { decision: "accept", reason: "ok" });
  assert.throws(
    () => g.resolveFact(p.id, f.id, { decision: "reject", reason: "changed mind" }),
    /is not resolvable/,
  );
});

test("addFact sets stepDiscovered from current step counter", () => {
  const g = new InMemoryGraph();
  const p = createProject(g);
  const intent = g.addIntent(p.id, { description: "x", creator: "planner" });
  g.claimIntent(p.id, intent.id, "w1", 1000);
  g.concludeIntent(p.id, intent.id);
  const fact = g.addFact(p.id, { description: "post-step fact", source: "explorer" });
  assert.ok(fact.stepDiscovered !== undefined, "stepDiscovered should be set");
  assert.ok(fact.stepDiscovered! >= 1, "stepDiscovered should reflect executed steps");
});

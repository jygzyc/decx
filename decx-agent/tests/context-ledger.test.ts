import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ContextLedger } from "../dist/agent/context-ledger.js";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { createProject } from "./helper.ts";

function acceptFact(graph: ReturnType<typeof createProject> extends never ? never : import("../dist/graph/graph.js").Graph, projectId: string, description: string) {
  const f = graph.addFact(projectId, { description, source: "explorer", confidence: 0.9 });
  graph.resolveFact(projectId, f.id, { decision: "accept", reason: "ok" });
  return f;
}

test("ContextLedger: first call returns full (not delta)", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  acceptFact(graph, p.id, "fact 1");
  const ledger = new ContextLedger();
  const delta = ledger.computeDelta(p.id, "planner", graph, []);
  assert.equal(delta.isDelta, false);
});

test("ContextLedger: second call with no changes returns delta='No changes'", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  acceptFact(graph, p.id, "fact 1");
  const ledger = new ContextLedger();
  ledger.sync(p.id, "planner", graph, [], { stepsExecuted: 1 });
  const delta = ledger.computeDelta(p.id, "planner", graph, []);
  assert.equal(delta.isDelta, true);
  assert.match(delta.deltaBlock, /No changes/);
});

test("ContextLedger: new fact produces compact delta", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  for (let i = 0; i < 10; i++) acceptFact(graph, p.id, `fact ${i}`);
  const ledger = new ContextLedger();
  ledger.sync(p.id, "planner", graph, [], { stepsExecuted: 1 });
  acceptFact(graph, p.id, "new fact");
  const delta = ledger.computeDelta(p.id, "planner", graph, []);
  assert.equal(delta.isDelta, true);
  assert.match(delta.deltaBlock, /New accepted facts/);
  assert.match(delta.deltaBlock, /new fact/);
  assert.equal(delta.newFactIds.length, 1);
});

test("ContextLedger: falls back to full when delta exceeds threshold", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  acceptFact(graph, p.id, "old fact");
  const ledger = new ContextLedger();
  ledger.sync(p.id, "planner", graph, [], { stepsExecuted: 1 });
  for (let i = 0; i < 5; i++) {
    acceptFact(graph, p.id, `new ${i}`);
  }
  const delta = ledger.computeDelta(p.id, "planner", graph, []);
  assert.equal(delta.isDelta, false, "should fall back to full sync (not delta)");
  assert.equal(delta.newFactIds.length, 6, "full sync should report all 6 fact ids as new");
});

test("ContextLedger: sync records all fact/intent/verdict ids", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const f1 = acceptFact(graph, p.id, "fact");
  const i1 = graph.addIntent(p.id, { description: "intent", creator: "planner" });
  const verdicts = [{ factId: f1.id, verdict: { decision: "accept" as const, reason: "ok" } }];
  const ledger = new ContextLedger();
  ledger.sync(p.id, "planner", graph, verdicts, { stepsExecuted: 1 });
  const entry = ledger.get(p.id, "planner");
  assert.ok(entry);
  assert.ok(entry!.factIds.has(f1.id));
  assert.ok(entry!.intentIds.has(i1.id));
  assert.ok(entry!.verdictSigs.has(`${f1.id}:accept`));
});

test("ContextLedger: reset clears entry so next call is full", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  graph.addFact(p.id, { description: "fact", source: "explorer", confidence: 0.9 });
  const ledger = new ContextLedger();
  ledger.sync(p.id, "planner", graph, [], { stepsExecuted: 1 });
  ledger.reset(p.id, "planner");
  const delta = ledger.computeDelta(p.id, "planner", graph, []);
  assert.equal(delta.isDelta, false);
});

test("ContextLedger: new verdicts appear in delta", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const f1 = graph.addFact(p.id, { description: "fact", source: "explorer", confidence: 0.9 });
  const ledger = new ContextLedger();
  ledger.sync(p.id, "planner", graph, [], { stepsExecuted: 1 });
  const verdicts = [{ factId: f1.id, verdict: { decision: "accept" as const, reason: "good" } }];
  const delta = ledger.computeDelta(p.id, "planner", graph, verdicts);
  assert.equal(delta.isDelta, true);
  assert.match(delta.deltaBlock, /New verdicts/);
  assert.match(delta.deltaBlock, /accept/);
});

test("ContextLedger: delta produces shorter block than full context", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  for (let i = 0; i < 20; i++) acceptFact(graph, p.id, `fact ${i} with a fairly long description to pad token count`);
  const ledger = new ContextLedger();
  ledger.sync(p.id, "planner", graph, [], { stepsExecuted: 10 });
  acceptFact(graph, p.id, "new fact");

  const delta = ledger.computeDelta(p.id, "planner", graph, []);
  assert.equal(delta.isDelta, true);
  assert.ok(delta.deltaBlock.length < 200, `delta block should be compact, got ${delta.deltaBlock.length} chars`);

  ledger.sync(p.id, "planner", graph, [], { stepsExecuted: 11 });
  const noChangeDelta = ledger.computeDelta(p.id, "planner", graph, []);
  assert.equal(noChangeDelta.isDelta, true);
  assert.match(noChangeDelta.deltaBlock, /No changes/);
});

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { renderGraphView } from "../dist/agent/graph-view.js";
import { buildDynamicContext } from "../dist/agent/context-builder.js";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { createProject } from "./helper.ts";

function fact(id: string, desc: string, evidence: string[] = []) {
  return {
    id, projectId: "p", description: desc, evidence,
    source: "explorer", confidence: 0.9, status: "accepted" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

test("graph-view: full renders accepted facts + rejected + intents", () => {
  const text = renderGraphView({
    acceptedFacts: [fact("f001", "first")],
    rejectedFacts: [fact("f002", "dead")],
    openIntents: [{ id: "i001", projectId: "p", description: "task", creator: "planner", parentFactIds: [], status: "open" as const, priority: 0, createdAt: "" }],
  }, { view: "full" });
  assert.match(text, /Accepted Facts/);
  assert.match(text, /f001/);
  assert.match(text, /Rejected/);
  assert.match(text, /Current Intents/);
});

test("graph-view: focused renders context + dead-ends only", () => {
  const text = renderGraphView({
    acceptedFacts: [fact("f001", "ctx")],
    rejectedFacts: [fact("f002", "dead")],
  }, { view: "focused" });
  assert.match(text, /Context/);
  assert.match(text, /Dead-Ends/);
  assert.doesNotMatch(text, /Accepted Facts/);
});

test("graph-view: evidence-only filters out facts without evidence", () => {
  const text = renderGraphView({
    acceptedFacts: [
      fact("f001", "with evidence", ["proof"]),
      fact("f002", "no evidence"),
    ],
  }, { view: "evidence-only" });
  assert.match(text, /f001/);
  assert.doesNotMatch(text, /f002/);
});

test("graph-view: summary shows counts not bodies", () => {
  const text = renderGraphView({
    acceptedFacts: [fact("f001", "secret")],
    rejectedFacts: [],
    progress: {
      totalFacts: 1, acceptedFacts: 1, candidateFacts: 0, rejectedFacts: 0, blockedFacts: 0,
      openIntents: 0, claimedIntents: 0, chainedIntents: 0,
      stepsExecuted: 5, lastActivityAt: "", stagnationLevel: 0,
    },
  }, { view: "summary", includeProgress: true });
  assert.match(text, /Progress/);
  assert.match(text, /Accepted facts: 1/);
  assert.doesNotMatch(text, /secret/);
});

test("graph-view: maxFacts caps rendered fact count", () => {
  const facts = [];
  for (let i = 1; i <= 10; i++) facts.push(fact(`f${i}`, `fact ${i}`));
  const text = renderGraphView({ acceptedFacts: facts }, { view: "full", maxFacts: 3 });
  assert.doesNotMatch(text, /fact 1\b/);
  assert.match(text, /fact 8/);
  assert.match(text, /fact 9/);
  assert.match(text, /fact 10/);
});

test("context-builder: buildDynamicContext reads from graph", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const fact = graph.addFact(p.id, { description: "discovered fact", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, fact.id, { decision: "accept", reason: "ok" });
  const text = buildDynamicContext({
    projectId: p.id, graph,
    spec: { graphView: "full", includeProgress: true },
  });
  assert.match(text, /discovered fact/);
});

test("context-builder: relevanceScope=chain filters to linked facts only", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);

  const f1 = graph.addFact(p.id, { description: "root fact", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f1.id, { decision: "accept", reason: "ok" });
  const f2 = graph.addFact(p.id, { description: "linked fact", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f2.id, { decision: "accept", reason: "ok" });
  const f3 = graph.addFact(p.id, { description: "unrelated fact", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f3.id, { decision: "accept", reason: "ok" });

  graph.addLink(p.id, { fromFactId: f1.id, toFactId: f2.id, kind: "supports" });

  const intent = graph.addIntent(p.id, { description: "investigate", creator: "planner", parentFactIds: [f1.id] });

  const text = buildDynamicContext({
    projectId: p.id, graph,
    spec: { graphView: "focused", relevanceScope: "chain" },
    intent,
  });

  assert.match(text, /root fact/, "root fact should be included");
  assert.match(text, /linked fact/, "linked fact should be included via link traversal");
  assert.doesNotMatch(text, /unrelated fact/, "unrelated fact should be filtered out");
});

test("context-builder: relevanceScope=all includes everything (default)", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);

  const f1 = graph.addFact(p.id, { description: "fact A", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f1.id, { decision: "accept", reason: "ok" });
  const f2 = graph.addFact(p.id, { description: "fact B", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f2.id, { decision: "accept", reason: "ok" });

  const text = buildDynamicContext({
    projectId: p.id, graph,
    spec: { graphView: "focused", relevanceScope: "all" },
  });

  assert.match(text, /fact A/);
  assert.match(text, /fact B/);
});

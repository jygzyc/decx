import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[] = []) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun: null });
}

test("directive stop: project moves to stopped, step returns completed", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "INITIAL" }]));
  worker.register(/INITIAL/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  graph.addDirective(p.id, { kind: "stop", payload: "human requested stop" });
  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.step(p.id);

  assert.equal(result.type, "completed");
  assert.equal(graph.getProject(p.id)!.status, "stopped");
});

test("directive pause: project moves to paused, step returns idle", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions());
  graph.addDirective(p.id, { kind: "pause", payload: "break time" });

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.step(p.id);
  assert.equal(result.type, "idle");
  assert.equal(graph.getProject(p.id)!.status, "paused");
});

test("directive resume: paused project returns to active via directive", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  graph.updateProjectStatus(p.id, "paused");
  graph.addDirective(p.id, { kind: "resume", payload: "" });

  worker.register(/Planner Role/i, decisions([{ description: "RESUMED-TASK" }]));
  worker.register(/RESUMED-TASK/i, env("fact", { description: "r", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  assert.equal(graph.getProject(p.id)!.status, "active");
});

test("directive hint: adds hint to graph, consumed by planner", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "INITIAL" }]));
  worker.register(/## Hints Requiring Response/i, decisions([]));
  worker.register(/INITIAL/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  graph.addDirective(p.id, { kind: "hint", payload: "check auth bypass" });

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  // hint should be consumed after planner sees it
  const hints = graph.unconsumedHints(p.id);
  assert.equal(hints.length, 0);
  const events = graph.events(p.id).filter((e) => e.type === "directive.hint");
  assert.equal(events.length, 1);
});

test("directive kill-intent: fails the targeted intent", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);

  // First step: planner creates an intent
  worker.register(/Planner Role/i, decisions([{ description: "TARGET-INTENT" }]));
  worker.register(/TARGET-INTENT/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);

  const intent = graph.intents(p.id).find((i) => i.description === "TARGET-INTENT");
  assert.ok(intent);

  // Add kill-intent directive targeting this intent
  graph.addDirective(p.id, { kind: "kill-intent", payload: intent!.id });
  await loop.step(p.id);

  const killed = graph.getIntent(p.id, intent!.id);
  assert.equal(killed!.status, "failed");
});

test("directive spawn-intent: adds new intent to graph", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions());
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  graph.addDirective(p.id, { kind: "spawn-intent", payload: "human-defined task" });

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);

  const spawned = graph.intents(p.id).find((i) => i.description === "human-defined task");
  assert.ok(spawned);
  assert.equal(spawned!.creator, "human");
});

test("directive: multiple directives consumed in order", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions());
  worker.register(/## Hints Requiring Response/i, decisions([{ description: "FROM-HINT" }]));
  worker.register(/FROM-HINT/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  graph.addDirective(p.id, { kind: "hint", payload: "first hint" });
  graph.addDirective(p.id, { kind: "spawn-intent", payload: "spawned task" });

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);

  assert.equal(graph.unconsumedDirectives(p.id).length, 0);
});

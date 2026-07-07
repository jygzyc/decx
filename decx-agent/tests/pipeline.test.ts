import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[], failIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents, consumeHints: [], concludeRun });
}

test("e2e: planner creates intent, explorer executes, evaluator accepts, stopGate fires", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.stopGate = { requireNoOpenIntents: true };
  const p = createProject(graph, { goal: "ACHIEVE_X" });
  worker.register(/Planner Role/i, decisions([{ description: "SOLVE: achieve X" }]));
  worker.register(/SOLVE: achieve X/i, env("fact", { description: "X achieved", confidence: 0.95 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));
  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id, { maxSteps: 20, idlePollMs: 5 });
  assert.equal(result.type, "completed");
  assert.ok(graph.facts(p.id, "accepted").map((f) => f.description).includes("X achieved"));
});

test("e2e: planner fails intent (kills explorer) in response to stop-explorer hint", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "WRONG-DIR" }]));
  worker.register(/WRONG-DIR/i, env("fact", { description: "partial", confidence: 0.3 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "x" }));
  worker.register(/## Hints Requiring Response/i, decisions([], [{ intentId: "i001", reason: "hint says stop" }]));
  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  graph.addHint(p.id, { content: "stop WRONG-DIR", creator: "metacog", kind: "stop-explorer", targetIntentId: "i001" });
  await loop.run(p.id, { maxSteps: 20, idlePollMs: 5 });
  const i001 = graph.getIntent(p.id, "i001");
  assert.ok(i001);
  assert.equal(i001!.status, "failed");
  assert.equal(i001!.killedBy, "planner");
  const unconsumedHints = graph.unconsumedHints(p.id);
  assert.equal(unconsumedHints.length, 0, "hint should be consumed after planner acts on it");
});

test("e2e: explorer blocked → candidate describing obstacle → evaluator rejects → planner fails intent", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "BLOCKED-TASK" }]));
  worker.register(/BLOCKED-TASK/i, env("fact", { description: "blocked: missing tool", confidence: 0.2 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "reject", reason: "no progress" }));
  worker.register(/## Recent Evaluator Verdicts/i, decisions([], [{ intentId: "i001", reason: "rejected by evaluator" }]));
  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { maxSteps: 20, idlePollMs: 5 });
  const i001 = graph.getIntent(p.id, "i001");
  assert.ok(i001);
  assert.equal(i001!.status, "failed");
});

test("e2e: planner can conclude the run via concludeRun decision", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "TASK-Z" }]));
  worker.register(/TASK-Z/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "reject", reason: "goal met" }));
  worker.register(/## Recent Evaluator Verdicts/i, decisions([], [], { description: "goal achieved" }));
  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id, { maxSteps: 15, idlePollMs: 5 });
  assert.equal(result.type, "completed");
  assert.equal(graph.getProject(p.id)!.status, "completed");
});

test("tick: multiple projects step concurrently", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.stopGate = { requireNoOpenIntents: true };
  const p1 = createProject(graph, { session: "s1" });
  const p2 = createProject(graph, { session: "s2" });
  worker.register(/Planner Role/i, decisions([{ description: "TASK-Z" }]));
  worker.register(/TASK-Z/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));
  const loop = new SessionLoop(graph, worker, config);
  for (let i = 0; i < 10; i++) {
    await loop.tick();
    if (graph.listProjects("active").length === 0) break;
  }
  assert.equal(graph.getProject(p1.id)!.status, "completed");
  assert.equal(graph.getProject(p2.id)!.status, "completed");
});

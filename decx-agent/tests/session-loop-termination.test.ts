import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun });
}

test("termination: maxSteps exceeded fails the project", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.limits.maxSteps = 2;
  config.workflow.limits.maxStagnation = 0;

  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "TASK-A" }, { description: "TASK-B" }]));
  worker.register(/TASK-A/i, env("fact", { description: "a", confidence: 0.9 }));
  worker.register(/TASK-B/i, env("fact", { description: "b", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  await loop.step(p.id);
  const result = await loop.step(p.id);

  assert.equal(result.type, "failed");
  assert.equal(graph.getProject(p.id)!.status, "failed");
});

test("termination: stopGate with requireNoOpenIntents completes project", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.stopGate = { requireNoOpenIntents: true };

  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "ONLY-TASK" }]));
  worker.register(/ONLY-TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id, { maxSteps: 20, idlePollMs: 5 });

  assert.equal(result.type, "completed");
  assert.equal(graph.getProject(p.id)!.status, "completed");
});

test("termination: stopGate minFactConfidence blocks completion when avg below threshold", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.stopGate = { requireNoOpenIntents: true, minFactConfidence: 0.95 };

  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "LOW-CONF" }]));
  worker.register(/LOW-CONF/i, env("fact", { description: "done", confidence: 0.5 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  // Run multiple steps — avg confidence 0.5 < 0.95, should NOT complete via stopGate
  for (let i = 0; i < 5; i++) await loop.step(p.id);

  // Project should still be active (stopGate blocked)
  assert.notEqual(graph.getProject(p.id)!.status, "completed");
});

test("termination: stagnation pauses project when maxStagnation reached", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.limits.maxStagnation = 3;
  config.workflow.limits.maxSteps = 100;

  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([
    { description: "ERR-A" }, { description: "ERR-B" }, { description: "ERR-C" },
  ]));
  // Explorers return invalid output → StageError → intent fails → stagnation++
  for (const d of ["ERR-A", "ERR-B", "ERR-C"]) {
    worker.register(new RegExp(d), "not valid json");
  }
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));
  worker.register(/## Recent Evaluator Verdicts/i, decisions([]));

  const loop = new SessionLoop(graph, worker, config);
  for (let i = 0; i < 20; i++) {
    const r = await loop.step(p.id);
    if (r.type === "idle" || r.type === "completed" || r.type === "failed") break;
  }

  const status = graph.getProject(p.id)!.status;
  assert.equal(status, "paused", `expected paused, got ${status}`);
  const stagnationEvents = graph.events(p.id).filter((e) => e.type === "project.stagnation_paused");
  assert.equal(stagnationEvents.length, 1, "should have a stagnation_paused event");
});

test("termination: completed project returns completed step result (via concludeRun)", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);

  worker.register(/Planner Role/i, decisions([{ description: "TASK" }]));
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "reject", reason: "done" }));
  worker.register(/## Recent Evaluator Verdicts/i, env("decisions", { createIntents: [], failIntents: [], consumeHints: [], concludeRun: { description: "goal achieved" } }));

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.run(p.id, { maxSteps: 15, idlePollMs: 5 });
  assert.equal(result.type, "completed",
    `expected completed, got ${result.type}`);
});

test("termination: paused project returns idle step result", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);
  graph.updateProjectStatus(p.id, "paused");

  const loop = new SessionLoop(graph, worker, config);
  const result = await loop.step(p.id);
  assert.equal(result.type, "idle");
  assert.match(result.reason!, /paused/);
});

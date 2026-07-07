import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env } from "./helper.ts";

test("SubagentRun tracking: explorer dispatch creates a tracked run", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.stopGate = { requireNoOpenIntents: true };

  const p = createProject(graph);
  worker.register(/Planner Role/i, env("decisions", { createIntents: [{ description: "FIND-X" }], failIntents: [], consumeHints: [], concludeRun: null }));
  worker.register(/FIND-X/i, env("fact", { description: "found", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { maxSteps: 20, idlePollMs: 5 });

  const explorerRuns = graph.subagentRuns(p.id, { profileId: "explorer" });
  assert.ok(explorerRuns.length >= 1, "at least one explorer run tracked");
  const completed = explorerRuns.find((r) => r.status === "completed");
  assert.ok(completed, "an explorer run completed");
  assert.ok(completed!.factId, "completed explorer run has factId");
});

test("SubagentRun tracking: evaluator dispatch creates a tracked run", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/Planner Role/i, env("decisions", { createIntents: [{ description: "TASK" }], failIntents: [], consumeHints: [], concludeRun: null }));
  worker.register(/TASK/i, env("fact", { description: "result", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { maxSteps: 20, idlePollMs: 5 });

  const evaluatorRuns = graph.subagentRuns(p.id, { profileId: "evaluator" });
  assert.ok(evaluatorRuns.length >= 1);
  const completed = evaluatorRuns.find((r) => r.status === "completed");
  assert.ok(completed);
});

test("SubagentRun tracking: failed explorer marks run as failed", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  // Explorer returns invalid output → StageError → run marked failed
  worker.register(/Planner Role/i, env("decisions", { createIntents: [{ description: "BAD-TASK" }], failIntents: [], consumeHints: [], concludeRun: null }));
  worker.register(/BAD-TASK/i, "not json at all");

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { maxSteps: 10, idlePollMs: 5 });

  const explorerRuns = graph.subagentRuns(p.id, { profileId: "explorer" });
  const failed = explorerRuns.find((r) => r.status === "failed");
  assert.ok(failed, "an explorer run is marked failed");
  assert.ok(failed!.errorMessage);
});

test("SubagentRun tracking: maxActive caps concurrent explorer runs", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  // Force maxActive=1 to serialize explorer runs
  config.profiles.explorer.maxActive = 1;
  config.workflow.limits.maxConcurrent = 5;
  config.workflow.limits.refillPerTick = 5;
  config.workflow.stopGate = { requireNoOpenIntents: true };

  const p = createProject(graph);
  worker.register(/Planner Role/i, env("decisions", {
    createIntents: [{ description: "TASK-A" }, { description: "TASK-B" }, { description: "TASK-C" }],
    failIntents: [], consumeHints: [], concludeRun: null,
  }));
  for (const desc of ["TASK-A", "TASK-B", "TASK-C"]) {
    worker.register(new RegExp(desc), env("fact", { description: `${desc} done`, confidence: 0.9 }));
  }
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { maxSteps: 30, idlePollMs: 5 });

  const explorerRuns = graph.subagentRuns(p.id, { profileId: "explorer" });
  // All three should eventually complete
  const completed = explorerRuns.filter((r) => r.status === "completed");
  assert.equal(completed.length, 3);
});

test("SubagentRun tracking: completed explorer run records inputTokens and usedDelta", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.stopGate = { requireNoOpenIntents: true };

  const p = createProject(graph);
  worker.register(/Planner Role/i, env("decisions", { createIntents: [{ description: "TOKEN-TASK" }], failIntents: [], consumeHints: [], concludeRun: null }));
  worker.register(/TOKEN-TASK/i, env("fact", { description: "found", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { maxSteps: 20, idlePollMs: 5 });

  const completed = graph.subagentRuns(p.id, { profileId: "explorer", status: "completed" });
  assert.ok(completed.length >= 1);
  const run = completed[0]!;
  assert.ok(run.inputTokens !== undefined && run.inputTokens > 0, "inputTokens should be positive");
  assert.equal(typeof run.usedDelta, "boolean");
});

test("SubagentRun tracking: failed run has errorMessage set", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/Planner Role/i, env("decisions", { createIntents: [{ description: "ERR-TASK" }], failIntents: [], consumeHints: [], concludeRun: null }));
  worker.register(/ERR-TASK/i, "not json");

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { maxSteps: 10, idlePollMs: 5 });

  const failed = graph.subagentRuns(p.id, { profileId: "explorer", status: "failed" });
  assert.ok(failed.length >= 1);
  assert.ok(failed[0]!.errorMessage, "failed run should have errorMessage");
});

test("SubagentRun tracking: fact created via SessionLoop has stepDiscovered set", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.stopGate = { requireNoOpenIntents: true };

  const p = createProject(graph);
  worker.register(/Planner Role/i, env("decisions", { createIntents: [{ description: "STEPFACT" }], failIntents: [], consumeHints: [], concludeRun: null }));
  worker.register(/STEPFACT/i, env("fact", { description: "found via loop", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { maxSteps: 20, idlePollMs: 5 });

  const facts = graph.facts(p.id);
  assert.ok(facts.length >= 1);
  for (const f of facts) {
    assert.ok(f.stepDiscovered !== undefined, `fact ${f.id} should have stepDiscovered set`);
    assert.ok(f.stepDiscovered! >= 0, `fact ${f.id} stepDiscovered should be non-negative`);
  }
});

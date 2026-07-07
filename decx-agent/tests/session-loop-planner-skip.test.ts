import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[] = [], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun });
}

test("planner-skip: accept verdict does NOT trigger planner with verdicts", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "TASK" }]));
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));
  let verdictBlockCallCount = 0;
  worker.register(/## Recent Evaluator Verdicts/i, () => { verdictBlockCallCount++; return decisions(); });

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  await loop.step(p.id);

  assert.equal(verdictBlockCallCount, 0);
});

test("planner-skip: reject verdict DOES trigger planner with verdicts", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "BAD-TASK" }]));
  worker.register(/BAD-TASK/i, env("fact", { description: "wrong", confidence: 0.2 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "reject", reason: "bad" }));
  let plannerWithVerdictsCalled = false;
  worker.register(/## Recent Evaluator Verdicts/i, () => {
    plannerWithVerdictsCalled = true;
    return decisions([{ description: "RETRY-TASK" }]);
  });
  worker.register(/RETRY-TASK/i, env("fact", { description: "better", confidence: 0.8 }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  await loop.step(p.id);

  assert.equal(plannerWithVerdictsCalled, true);
});

test("planner-skip: demote verdict DOES trigger planner", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();

  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "TASK" }]));
  worker.register(/TASK/i, env("fact", { description: "partial", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "demote", reason: "weak", confidence: 0.3 }));
  let plannerWithVerdictsCalled = false;
  worker.register(/## Recent Evaluator Verdicts/i, () => { plannerWithVerdictsCalled = true; return decisions(); });

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  await loop.step(p.id);

  assert.equal(plannerWithVerdictsCalled, true);
});

test("planner-skip: stop-explorer hint triggers planner even during cooldown", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.limits.plannerCooldownSteps = 0;

  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "TASK" }]));
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));
  let plannerWithHintsCalled = false;
  worker.register(/## Hints Requiring Response/i, () => { plannerWithHintsCalled = true; return decisions(); });

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);

  graph.addHint(p.id, { content: "stop that", creator: "human", kind: "stop-explorer" });
  await loop.step(p.id);

  assert.equal(plannerWithHintsCalled, true);
});

test("planner-skip: empty graph always runs planner", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const p = createProject(graph);

  let plannerCalled = false;
  worker.register(/Planner Role/i, () => {
    plannerCalled = true;
    return decisions([{ description: "INIT" }]);
  });
  worker.register(/INIT/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);

  assert.equal(plannerCalled, true);
});

test("planner-skip: with cooldown>0, planner NOT called again on accept verdict", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.limits.plannerCooldownSteps = 5;

  const p = createProject(graph);
  let plannerCallCount = 0;
  worker.register(/Planner Role/i, () => {
    plannerCallCount++;
    return decisions([{ description: "WORK-TASK" }]);
  });
  worker.register(/WORK-TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  const callsAfterStep1 = plannerCallCount;
  assert.equal(callsAfterStep1, 1, "planner should run once on empty graph");

  await loop.step(p.id);
  assert.equal(plannerCallCount, callsAfterStep1, "planner should NOT run again on accept verdict");
});

test("planner-skip: reject bypasses cooldown and triggers planner", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.limits.plannerCooldownSteps = 99;

  const p = createProject(graph);
  let plannerCallCount = 0;
  worker.register(/Planner Role/i, () => {
    plannerCallCount++;
    return decisions([{ description: "BAD-WORK" }]);
  });
  worker.register(/BAD-WORK/i, env("fact", { description: "wrong", confidence: 0.2 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "reject", reason: "bad" }));
  worker.register(/## Recent Evaluator Verdicts/i, () => {
    plannerCallCount++;
    return decisions([{ description: "RETRY" }]);
  });
  worker.register(/RETRY/i, env("fact", { description: "better", confidence: 0.8 }));

  const loop = new SessionLoop(graph, worker, config);
  await loop.step(p.id);
  const callsAfterStep1 = plannerCallCount;
  assert.ok(callsAfterStep1 >= 1);

  await loop.step(p.id);
  assert.ok(plannerCallCount > callsAfterStep1, "planner should run despite high cooldown on reject");
});

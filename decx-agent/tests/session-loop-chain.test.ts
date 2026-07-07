import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[] = []) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun: null });
}

test("chain: explorer chains intent, sub-intents execute, parent resumes with enriched context", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.limits.maxConcurrent = 3;
  config.workflow.limits.refillPerTick = 3;

  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "PARENT-TASK" }]));

  // First explorer call: chain with 2 sub-intents
  worker.register(/PARENT-TASK/i, env("chain", {
    reason: "need sub-info",
    subIntents: [{ description: "SUB-A" }, { description: "SUB-B" }],
    waitMode: "all",
  }));
  // Sub-intent explorers
  worker.register(/SUB-A/i, env("fact", { description: "sub A result", confidence: 0.9 }));
  worker.register(/SUB-B/i, env("fact", { description: "sub B result", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));
  // Parent resume: returns final fact
  worker.register(/Resume Context/i, env("fact", { description: "parent final", confidence: 0.95 }));

  const loop = new SessionLoop(graph, worker, config);
  for (let i = 0; i < 15; i++) {
    const r = await loop.step(p.id);
    if (r.type === "idle" || r.type === "completed") break;
  }

  const parentIntent = graph.intents(p.id).find((i) => i.description === "PARENT-TASK");
  assert.ok(parentIntent);
  assert.equal(parentIntent!.status, "done");
  assert.ok(parentIntent!.chain);
  assert.equal(parentIntent!.chain!.subIntentIds.length, 2);

  for (const subId of parentIntent!.chain!.subIntentIds) {
    const sub = graph.getIntent(p.id, subId);
    assert.ok(sub, `sub-intent ${subId} should exist`);
    assert.equal(sub!.parentIntentId, parentIntent!.id, `sub-intent ${subId} should have parentIntentId=${parentIntent!.id}`);
  }
});

test("chain: waitMode=any resumes parent when first sub completes", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.limits.maxConcurrent = 3;
  config.workflow.limits.refillPerTick = 3;

  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "ANY-PARENT" }]));

  worker.register(/ANY-PARENT/i, env("chain", {
    reason: "race",
    subIntents: [{ description: "RACER-1" }, { description: "RACER-2" }],
    waitMode: "any",
  }));
  worker.register(/RACER-1/i, env("fact", { description: "racer 1 done", confidence: 0.9 }));
  worker.register(/RACER-2/i, env("fact", { description: "racer 2 done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));
  worker.register(/Resume Context/i, env("fact", { description: "parent resumed", confidence: 0.9 }));

  const loop = new SessionLoop(graph, worker, config);
  for (let i = 0; i < 15; i++) {
    const r = await loop.step(p.id);
    if (r.type === "idle" || r.type === "completed") break;
  }

  const parent = graph.intents(p.id).find((i) => i.description === "ANY-PARENT");
  assert.ok(parent);
  assert.equal(parent!.status, "done");
});

test("chain: parent resumes even if a sub-intent fails", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.limits.maxConcurrent = 3;
  config.workflow.limits.refillPerTick = 3;

  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "FAIL-PARENT" }]));

  worker.register(/FAIL-PARENT/i, env("chain", {
    reason: "need info",
    subIntents: [{ description: "FAILING-SUB" }],
    waitMode: "all",
  }));
  // Sub fails (evaluator rejects)
  worker.register(/FAILING-SUB/i, env("fact", { description: "sub attempt", confidence: 0.1 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "reject", reason: "bad" }));
  worker.register(/## Recent Evaluator Verdicts/i, decisions([]));
  // Parent resume after sub failure
  worker.register(/Resume Context/i, env("fact", { description: "parent after fail", confidence: 0.7 }));

  const loop = new SessionLoop(graph, worker, config);
  for (let i = 0; i < 15; i++) {
    const r = await loop.step(p.id);
    if (r.type === "idle" || r.type === "completed") break;
  }

  const parent = graph.intents(p.id).find((i) => i.description === "FAIL-PARENT");
  assert.ok(parent);
  assert.equal(parent!.status, "done");
});

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { AgentRuntime } from "../dist/app/agent-runtime.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { minimalConfig, env } from "./helper.ts";

function decisions(createIntents: unknown[] = []) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun: null });
}

function makeRuntime(opts: { workerPool?: MockWorker } = {}) {
  const worker = opts.workerPool ?? new MockWorker();
  const config = minimalConfig();
  const runtime = new AgentRuntime(config, {
    workerPool: worker,
    useHttp: false,
    useMetacogSupervisor: false,
  });
  return { runtime, worker, config };
}

test("agent-runtime: createProject returns a project id", () => {
  const { runtime } = makeRuntime();
  const id = runtime.createProject({ session: "test-session" });
  assert.ok(id);
  assert.equal(typeof id, "string");
});

test("agent-runtime: step drives a single project step", async () => {
  const worker = new MockWorker();
  const { runtime } = makeRuntime({ workerPool: worker });

  worker.register(/Planner Role/i, decisions([{ description: "TASK" }]));
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const pid = runtime.createProject({ session: "s1" });
  const result = await runtime.step(pid);
  assert.ok(result.type === "stepped" || result.type === "completed");
});

test("agent-runtime: run drives to completion", async () => {
  const worker = new MockWorker();
  const { runtime, config } = makeRuntime({ workerPool: worker });
  config.workflow.stopGate = { requireNoOpenIntents: true };

  worker.register(/Planner Role/i, decisions([{ description: "TASK" }]));
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const pid = runtime.createProject({ session: "s1" });
  const result = await runtime.run(pid, { maxSteps: 20, idlePollMs: 5 });
  assert.equal(result.type, "completed");
});

test("agent-runtime: tick steps all active projects", async () => {
  const worker = new MockWorker();
  const { runtime, config } = makeRuntime({ workerPool: worker });
  config.workflow.stopGate = { requireNoOpenIntents: true };

  worker.register(/Planner Role/i, decisions([{ description: "TASK" }]));
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  runtime.createProject({ session: "s1" });
  runtime.createProject({ session: "s2" });
  const results = await runtime.tick();
  assert.equal(results.length, 2);
});

test("agent-runtime: addDirective injects directive into graph", () => {
  const { runtime } = makeRuntime();
  const pid = runtime.createProject({ session: "s1" });
  runtime.addDirective(pid, { kind: "hint", payload: "check X" });
  assert.equal(runtime.graph.unconsumedDirectives(pid).length, 1);
});

test("agent-runtime: startMetacog/stopMetacog are safe when supervisor disabled", () => {
  const { runtime } = makeRuntime();
  assert.equal(runtime.metacogSupervisor, undefined);
  assert.doesNotThrow(() => runtime.startMetacog());
  assert.doesNotThrow(() => runtime.stopMetacog());
});

test("agent-runtime: close does not throw", () => {
  const { runtime } = makeRuntime();
  assert.doesNotThrow(() => runtime.close());
});

test("agent-runtime: with metacog supervisor enabled, start/stop works", () => {
  const worker = new MockWorker();
  const config = minimalConfig();
  const runtime = new AgentRuntime(config, {
    workerPool: worker,
    useHttp: false,
    useMetacogSupervisor: true,
  });
  assert.ok(runtime.metacogSupervisor);
  runtime.startMetacog();
  assert.equal(runtime.metacogSupervisor!.isRunning, true);
  runtime.stopMetacog();
  assert.equal(runtime.metacogSupervisor!.isRunning, false);
  runtime.close();
});

test("agent-runtime: uses InMemoryGraph by default", () => {
  const { runtime } = makeRuntime();
  assert.ok(runtime.graph instanceof InMemoryGraph);
});

test("agent-runtime: createProject is idempotent for same session", () => {
  const { runtime } = makeRuntime();
  const id1 = runtime.createProject({ session: "dup" });
  const id2 = runtime.createProject({ session: "dup" });
  assert.equal(id1, id2);
});

test("agent-runtime: step on unknown project returns failed", async () => {
  const { runtime } = makeRuntime();
  const result = await runtime.step("nonexistent");
  assert.equal(result.type, "failed");
});

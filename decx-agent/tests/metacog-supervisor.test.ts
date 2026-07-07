import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { MetacogSupervisor } from "../dist/session/metacog-supervisor.js";
import { ProjectLockManager } from "../dist/session/project-lock.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function makeSupervisor(graph: InMemoryGraph, worker: MockWorker, intervalMs = 50) {
  return new MetacogSupervisor(graph, worker, minimalConfig(), new ProjectLockManager(), intervalMs);
}

function primeForMetacog(graph: InMemoryGraph, p: ReturnType<typeof createProject>) {
  const f = graph.addFact(p.id, { description: "accepted fact", source: "explorer", confidence: 0.9 });
  graph.resolveFact(p.id, f.id, { decision: "accept", reason: "ok" });
  return f;
}

test("metacog-supervisor: start sets running=true, stop sets running=false", () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const sup = makeSupervisor(graph, worker);
  assert.equal(sup.isRunning, false);
  sup.start();
  assert.equal(sup.isRunning, true);
  sup.stop();
  assert.equal(sup.isRunning, false);
});

test("metacog-supervisor: double start is idempotent", () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const sup = makeSupervisor(graph, worker);
  sup.start();
  sup.start();
  assert.equal(sup.isRunning, true);
  sup.stop();
});

test("metacog-supervisor: stop without start is safe", () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const sup = makeSupervisor(graph, worker);
  assert.doesNotThrow(() => sup.stop());
});

test("metacog-supervisor: runOnce produces hints and writes them to graph", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  primeForMetacog(graph, p);

  worker.register(/Metacog Role/i, env("hints", { hints: [{ content: "investigate X" }] }));

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  const hints = graph.unconsumedHints(p.id);
  assert.equal(hints.length, 1);
  assert.equal(hints[0]!.content, "investigate X");
});

test("metacog-supervisor: runOnce stop request stops the project", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  primeForMetacog(graph, p);

  worker.register(/Metacog Role/i, env("stop", { reason: "goal met" }));

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  assert.equal(graph.getProject(p.id)!.status, "stopped");
});

test("metacog-supervisor: runOnce creates tracked SubagentRun", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  primeForMetacog(graph, p);

  worker.register(/Metacog Role/i, env("hints", { hints: [] }));

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  const runs = graph.subagentRuns(p.id, { profileId: "metacog" });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, "completed");
});

test("metacog-supervisor: runOnce worker error marks run as failed", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  primeForMetacog(graph, p);

  worker.register(/Metacog Role/i, "this is not valid json");

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  const failedRuns = graph.subagentRuns(p.id, { profileId: "metacog", status: "failed" });
  assert.equal(failedRuns.length, 1);
  assert.ok(failedRuns[0]!.errorMessage);
});

test("metacog-supervisor: runOnce does NOT run for inactive projects", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const p = createProject(graph);
  graph.updateProjectStatus(p.id, "paused");
  primeForMetacog(graph, p);

  let metacogCalled = false;
  worker.register(/Metacog Role/i, () => { metacogCalled = true; return env("hints", { hints: [] }); });

  const sup = makeSupervisor(graph, worker);
  await sup.runOnce();

  assert.equal(metacogCalled, false);
  assert.equal(graph.subagentRuns(p.id).length, 0);
});

test("metacog-supervisor: maxActive=1 skips when a run is already running", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.profiles.metacog.maxActive = 1;

  const p = createProject(graph);
  primeForMetacog(graph, p);

  graph.createSubagentRun(p.id, {
    profileId: "metacog", role: "metacog", workerName: "mock",
    inputSummary: "pre-existing run",
  });
  graph.updateSubagentRun(p.id, graph.subagentRuns(p.id, { profileId: "metacog" })[0]!.id, { status: "running" });

  worker.register(/Metacog Role/i, env("hints", { hints: [{ content: "should not run" }] }));

  const sup = new MetacogSupervisor(graph, worker, config, new ProjectLockManager(), 1);
  await sup.runOnce();

  assert.equal(graph.subagentRuns(p.id, { profileId: "metacog" }).length, 1, "should not create a second run");
  assert.equal(graph.unconsumedHints(p.id).length, 0, "should not have written hints");
});

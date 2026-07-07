import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { createProject } from "./helper.ts";

test("SubagentRun: createSubagentRun returns pending run with generated id", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const run = graph.createSubagentRun(p.id, {
    profileId: "explorer",
    role: "explorer",
    workerName: "mock",
    intentId: "i001",
    inputSummary: "find X",
  });
  assert.ok(run.id.startsWith("run_"));
  assert.equal(run.status, "pending");
  assert.equal(run.profileId, "explorer");
  assert.equal(run.intentId, "i001");
});

test("SubagentRun: updateSubagentRun sets startedAt on running and finishedAt on terminal", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const run = graph.createSubagentRun(p.id, {
    profileId: "explorer", role: "explorer", workerName: "mock",
  });
  graph.updateSubagentRun(p.id, run.id, { status: "running" });
  const running = graph.getSubagentRun(p.id, run.id);
  assert.equal(running!.status, "running");
  assert.ok(running!.startedAt);

  graph.updateSubagentRun(p.id, run.id, { status: "completed", outputSummary: "done" });
  const done = graph.getSubagentRun(p.id, run.id);
  assert.equal(done!.status, "completed");
  assert.ok(done!.finishedAt);
  assert.equal(done!.outputSummary, "done");
});

test("SubagentRun: subagentRuns filters by profileId and status", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  graph.createSubagentRun(p.id, { profileId: "explorer", role: "explorer", workerName: "mock" });
  graph.createSubagentRun(p.id, { profileId: "explorer", role: "explorer", workerName: "mock" });
  graph.createSubagentRun(p.id, { profileId: "evaluator", role: "evaluator", workerName: "mock" });

  assert.equal(graph.subagentRuns(p.id).length, 3);
  assert.equal(graph.subagentRuns(p.id, { profileId: "explorer" }).length, 2);
  assert.equal(graph.subagentRuns(p.id, { profileId: "evaluator" }).length, 1);
});

test("SubagentRun: updateSubagentRun throws on unknown runId", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  assert.throws(() => graph.updateSubagentRun(p.id, "run_unknown", { status: "running" }), /not found/);
});

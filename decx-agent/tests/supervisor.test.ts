import { test } from "node:test";
import { strict as assert } from "node:assert";
import { GlobalSupervisor } from "../dist/session/supervisor.js";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[], concludeRun: unknown = null) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun });
}

test("GlobalSupervisor: register/unregister sessions", () => {
  const sup = new GlobalSupervisor();
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const loop = new SessionLoop(graph, worker, config);

  sup.register("s1", loop);
  assert.equal(sup.listSessions().length, 1);
  assert.equal(sup.get("s1"), loop);

  sup.unregister("s1");
  assert.equal(sup.listSessions().length, 0);
});

test("GlobalSupervisor: register throws on duplicate id", () => {
  const sup = new GlobalSupervisor();
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  const loop = new SessionLoop(graph, worker, config);

  sup.register("s1", loop);
  assert.throws(() => sup.register("s1", loop), /already registered/);
});

test("GlobalSupervisor: tick steps all registered sessions", async () => {
  const sup = new GlobalSupervisor();
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.stopGate = { requireNoOpenIntents: true };

  const p1 = createProject(graph, { session: "sess1" });
  const p2 = createProject(graph, { session: "sess2" });

  worker.register(/Planner Role/i, decisions([{ description: "TASK" }]));
  worker.register(/TASK/i, env("fact", { description: "done", confidence: 0.9 }));
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const loop1 = new SessionLoop(graph, worker, config);
  const loop2 = new SessionLoop(graph, worker, config);
  sup.register("sess1", loop1);
  sup.register("sess2", loop2);

  for (let i = 0; i < 10; i++) {
    await sup.tick();
    if (graph.listProjects("active").length === 0) break;
  }

  assert.equal(graph.getProject(p1.id)!.status, "completed");
  assert.equal(graph.getProject(p2.id)!.status, "completed");
});

test("GlobalSupervisor: owns a FederationBus", () => {
  const sup = new GlobalSupervisor();
  assert.ok(sup.federationBus);
  sup.federationBus.publishInsight(
    { sessionId: "s1", projectId: "p1", factId: "f1" },
    "test", 0.5,
  );
  assert.equal(sup.federationBus.recentInsights().length, 1);
});

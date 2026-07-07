import { test } from "node:test";
import { strict as assert } from "node:assert";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import { SessionLoop } from "../dist/session/session-loop.js";
import { HttpServer } from "../dist/server/http-server.js";
import { minimalConfig, createProject, env } from "./helper.ts";

function decisions(createIntents: unknown[]) {
  return env("decisions", { createIntents, failIntents: [], consumeHints: [], concludeRun: null });
}

async function startServer(graph: InMemoryGraph): Promise<{ server: HttpServer; base: string }> {
  const server = new HttpServer(graph);
  await server.start({ port: 0 });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

test("http-server: GET /api/projects returns project list", async () => {
  const graph = new InMemoryGraph();
  createProject(graph, { session: "s1" });
  createProject(graph, { session: "s2" });
  const { server, base } = await startServer(graph);
  try {
    const resp = await fetch(`${base}/api/projects`);
    const projects = await resp.json();
    assert.equal(projects.length, 2);
  } finally { await server.stop(); }
});

test("http-server: GET / serves dashboard HTML", async () => {
  const graph = new InMemoryGraph();
  const { server, base } = await startServer(graph);
  try {
    const resp = await fetch(`${base}/`);
    const html = await resp.text();
    assert.ok(html.includes("<title>decx-agent Dashboard</title>"));
  } finally { await server.stop(); }
});

test("http-server: POST /api/projects/:id/directives injects directive", async () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph, { session: "s1" });
  const { server, base } = await startServer(graph);
  try {
    const resp = await fetch(`${base}/api/projects/${p.id}/directives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "hint", payload: "check auth" }),
    });
    const dir = await resp.json();
    assert.equal(dir.kind, "hint");
    assert.equal(dir.payload, "check auth");
    assert.equal(graph.unconsumedDirectives(p.id).length, 1);
  } finally { await server.stop(); }
});

test("http-server: GET /api/projects/:id returns full detail", async () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph, { session: "s1" });
  graph.addFact(p.id, { description: "test fact", source: "explorer", confidence: 0.9 });
  graph.addIntent(p.id, { description: "do work", creator: "planner" });
  const { server, base } = await startServer(graph);
  try {
    const resp = await fetch(`${base}/api/projects/${p.id}`);
    const data = await resp.json();
    assert.equal(data.facts.length, 1);
    assert.equal(data.intents.length, 1);
    assert.ok(data.progress);
  } finally { await server.stop(); }
});

test("sessionLoop: multiple intents resolve to accepted facts", async () => {
  const graph = new InMemoryGraph();
  const worker = new MockWorker();
  const config = minimalConfig();
  config.workflow.stopGate = { requireNoOpenIntents: true };
  const p = createProject(graph);
  worker.register(/Planner Role/i, decisions([{ description: "JOB-ALPHA" }, { description: "JOB-BETA" }]));
  worker.register(/JOB-ALPHA/i, env("fact", { description: "alpha done", confidence: 0.9 }));
  worker.register(/JOB-BETA/i, env("fact", { description: "beta done", confidence: 0.9 }));
  worker.register(/Evaluator Role|Candidate Fact Under Review/i, env("verdict", { decision: "accept", reason: "ok" }));
  const loop = new SessionLoop(graph, worker, config);
  await loop.run(p.id, { maxSteps: 20, idlePollMs: 5 });
  const accepted = graph.facts(p.id, "accepted");
  assert.ok(accepted.length >= 2, `expected >= 2 accepted facts, got ${accepted.length}`);
});

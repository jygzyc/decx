import { test } from "node:test";
import { strict as assert } from "node:assert";
import { runSubagent, plannerExtra, explorerExtra, evaluatorExtra, metacogExtra } from "../dist/agent/subagent-runner.js";
import { MainAgent } from "../dist/agent/main-agent.js";
import { freshSetup, createProject, env, minimalConfig } from "./helper.ts";

test("planner via MainAgent: empty graph returns createIntents decisions", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  worker.register(/Planner Role/i, env("decisions", {
    createIntents: [{ description: "scan", from: [], priority: 2 }],
    failIntents: [], consumeHints: [], concludeRun: null,
  }));

  const agent = new MainAgent({ projectId: p.id, graph, config, workerPool: worker });
  const { decision } = await agent.run({});
  assert.equal(decision.createIntents.length, 1);
  assert.equal(decision.createIntents[0].description, "scan");
});

test("planner via MainAgent: hint-received returns failIntents", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const i1 = graph.addIntent(p.id, { description: "wrong dir", creator: "planner" });
  const h1 = graph.addHint(p.id, { content: "stop", creator: "metacog", kind: "stop-explorer", targetIntentId: i1.id });

  worker.register(/## Hints Requiring Response/i, env("decisions", {
    createIntents: [],
    failIntents: [{ intentId: i1.id, reason: "hint says stop" }],
    consumeHints: [h1.id], concludeRun: null,
  }));

  const agent = new MainAgent({ projectId: p.id, graph, config, workerPool: worker });
  const { decision } = await agent.run({ hints: [h1] });
  assert.equal(decision.failIntents.length, 1);
  assert.equal(decision.failIntents[0].intentId, i1.id);
  assert.deepEqual(decision.consumeHintIds, [h1.id]);
});

test("planner via MainAgent: verdict-driven can conclude", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  worker.register(/## Recent Evaluator Verdicts/i, env("decisions", {
    createIntents: [], failIntents: [], consumeHints: [],
    concludeRun: { description: "goal achieved" },
  }));

  const agent = new MainAgent({ projectId: p.id, graph, config, workerPool: worker });
  const { decision } = await agent.run({
    recentVerdicts: [{ factId: "f001", verdict: { decision: "accept", reason: "ok" } }],
  });
  assert.ok(decision.concludeRun);
  assert.equal(decision.concludeRun!.description, "goal achieved");
});

test("explorer via runSubagent: produces candidate fact", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "find X", creator: "planner" });
  worker.register(/Explorer Role/i, env("fact", { description: "X is 42", evidence: ["measured"], confidence: 0.9 }));

  const output = await runSubagent({
    profile: config.profiles.explorer, profileId: "explorer",
    projectId: p.id, graph, workerPool: worker, config,
    promptExtra: explorerExtra(intent.id, intent.description, intent.parentFactIds, [], false),
  });
  assert.equal(output.kind, "fact");
  assert.equal(output.fact.description, "X is 42");
  assert.equal(output.fact.confidence, 0.9);
});

test("explorer via runSubagent: emits chain when context insufficient", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "analyze subsystem", creator: "planner" });
  worker.register(/Explorer Role/i, env("chain", { reason: "need Y", subIntents: [{ description: "Y" }], waitMode: "all" }));

  const output = await runSubagent({
    profile: config.profiles.explorer, profileId: "explorer",
    projectId: p.id, graph, workerPool: worker, config,
    promptExtra: explorerExtra(intent.id, intent.description, intent.parentFactIds, [], false),
  });
  assert.equal(output.kind, "chain");
  assert.equal(output.chain.subIntents.length, 1);
});

test("evaluator via runSubagent: returns accept verdict", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const candidate = graph.addFact(p.id, { description: "X is 42", evidence: ["measured"], source: "explorer", confidence: 0.9 });
  worker.register(/Evaluator Role/i, env("verdict", { decision: "accept", reason: "ok" }));

  const output = await runSubagent({
    profile: config.profiles.evaluator, profileId: "evaluator",
    projectId: p.id, graph, workerPool: worker, config,
    promptExtra: evaluatorExtra(candidate),
  });
  assert.equal(output.kind, "verdict");
  assert.equal(output.verdict.decision, "accept");
});

test("evaluator via runSubagent: returns reject verdict", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const candidate = graph.addFact(p.id, { description: "wrong", source: "explorer" });
  worker.register(/Evaluator Role/i, env("verdict", { decision: "reject", reason: "bad" }));

  const output = await runSubagent({
    profile: config.profiles.evaluator, profileId: "evaluator",
    projectId: p.id, graph, workerPool: worker, config,
    promptExtra: evaluatorExtra(candidate),
  });
  assert.equal(output.verdict.decision, "reject");
});

test("evaluator via runSubagent: demote with adjusted confidence", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const candidate = graph.addFact(p.id, { description: "partial", source: "explorer", confidence: 0.9 });
  worker.register(/Evaluator Role/i, env("verdict", { decision: "demote", reason: "weak", confidence: 0.3 }));

  const output = await runSubagent({
    profile: config.profiles.evaluator, profileId: "evaluator",
    projectId: p.id, graph, workerPool: worker, config,
    promptExtra: evaluatorExtra(candidate),
  });
  assert.equal(output.verdict.decision, "demote");
  assert.equal(output.verdict.confidence, 0.3);
});

test("evaluator via runSubagent: throws on invalid decision", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const candidate = graph.addFact(p.id, { description: "x", source: "explorer" });
  worker.register(/Evaluator Role/i, env("verdict", { decision: "maybe", reason: "invalid" }));

  await assert.rejects(runSubagent({
    profile: config.profiles.evaluator, profileId: "evaluator",
    projectId: p.id, graph, workerPool: worker, config,
    promptExtra: evaluatorExtra(candidate),
  }));
});

test("metacog via runSubagent: produces hints", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  worker.register(/Metacog Role/i, env("hints", { hints: [{ content: "investigate auth" }] }));

  const output = await runSubagent({
    profile: config.profiles.metacog!, profileId: "metacog",
    projectId: p.id, graph, workerPool: worker, config,
    promptExtra: metacogExtra("scheduled"),
  });
  assert.equal(output.kind, "hints");
  assert.equal(output.hints.hints.length, 1);
  assert.equal(output.hints.hints[0].content, "investigate auth");
});

test("metacog via runSubagent: can request stop", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  worker.register(/Metacog Role/i, env("stop", { reason: "goal met" }));

  const output = await runSubagent({
    profile: config.profiles.metacog!, profileId: "metacog",
    projectId: p.id, graph, workerPool: worker, config,
    promptExtra: metacogExtra("stagnation"),
  });
  assert.equal(output.kind, "stop");
  assert.equal(output.stop.reason, "goal met");
});

test("plannerExtra: with hints renders hint response block", () => {
  const hints = [{ id: "h001", projectId: "p", content: "check auth", creator: "metacog" as const, kind: "direction" as const, createdAt: "" }];
  const text = plannerExtra(hints);
  assert.match(text, /Hints Requiring Response/);
  assert.match(text, /check auth/);
});

test("plannerExtra: with verdicts renders verdict block", () => {
  const verdicts = [{ factId: "f001", verdict: { decision: "reject" as const, reason: "bad" } }];
  const text = plannerExtra(undefined, verdicts);
  assert.match(text, /Recent Evaluator Verdicts/);
  assert.match(text, /reject/);
});

test("plannerExtra: empty input returns empty string", () => {
  const text = plannerExtra();
  assert.equal(text, "");
});

test("explorerExtra: includes intent id and description", () => {
  const text = explorerExtra("i001", "find bugs", ["f001"], [], false);
  assert.match(text, /i001/);
  assert.match(text, /find bugs/);
  assert.match(text, /f001/);
});

test("evaluatorExtra: includes candidate id and evidence", () => {
  const candidate = {
    id: "f005", projectId: "p", description: "finding",
    evidence: ["proof1", "proof2"], source: "explorer",
    confidence: 0.8, status: "candidate" as const, createdAt: "",
  };
  const text = evaluatorExtra(candidate);
  assert.match(text, /f005/);
  assert.match(text, /finding/);
  assert.match(text, /proof1/);
});

test("metacogExtra: includes trigger", () => {
  const text = metacogExtra("stagnation");
  assert.match(text, /stagnation/);
});

test("contract enforcement: explorer returning verdict is rejected", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "task", creator: "planner" });
  worker.register(/Explorer Role/i, env("verdict", { decision: "accept", reason: "wrong role" }));

  await assert.rejects(
    runSubagent({
      profile: config.profiles.explorer, profileId: "explorer",
      projectId: p.id, graph, workerPool: worker, config,
      promptExtra: explorerExtra(intent.id, intent.description, [], [], false),
    }),
    /contract="candidate_fact".*kind="verdict"/,
  );
});

test("contract enforcement: evaluator returning decisions is rejected", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  const candidate = graph.addFact(p.id, { description: "x", source: "explorer" });
  worker.register(/Evaluator Role/i, env("decisions", { createIntents: [], failIntents: [], consumeHints: [], concludeRun: null }));

  await assert.rejects(
    runSubagent({
      profile: config.profiles.evaluator, profileId: "evaluator",
      projectId: p.id, graph, workerPool: worker, config,
      promptExtra: evaluatorExtra(candidate),
    }),
    /contract="verdict".*kind="decisions"/,
  );
});

test("contract enforcement: metacog returning fact is rejected", async () => {
  const { graph, worker, config } = freshSetup();
  const p = createProject(graph);
  worker.register(/Metacog Role/i, env("fact", { description: "should not produce facts", evidence: [], confidence: 0.5 }));

  await assert.rejects(
    runSubagent({
      profile: config.profiles.metacog!, profileId: "metacog",
      projectId: p.id, graph, workerPool: worker, config,
      promptExtra: metacogExtra("scheduled"),
    }),
    /contract="hints".*kind="fact"/,
  );
});

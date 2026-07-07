import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyMainDecision } from "../dist/agent/decision-applier.js";
import { PermissionChecker } from "../dist/agent/permissions.js";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { minimalConfig, createProject } from "./helper.ts";
import type { MainDecision } from "../dist/agent/contracts.js";
import type { SubagentProfile, Permission } from "../dist/agent/types.js";

function perms(permissions: Permission[]): PermissionChecker {
  const profile: SubagentProfile = {
    role: "planner", runtime: { worker: "mock" },
    prompt: { file: "x.md" }, context: { graphView: "full" },
    permissions, output: { contract: "main_decision" },
  };
  return new PermissionChecker(profile);
}

function decision(partial: Partial<MainDecision>): MainDecision {
  return {
    createIntents: partial.createIntents ?? [],
    failIntents: partial.failIntents ?? [],
    consumeHintIds: partial.consumeHintIds ?? [],
    concludeRun: partial.concludeRun,
  };
}

test("decision-applier: creates intents from createIntents", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ createIntents: [{ description: "task A" }, { description: "task B" }] }),
    permissions: perms(["create_intent"]),
  });
  assert.equal(result.intentsCreated, 2);
  assert.equal(graph.intents(p.id).length, 2);
});

test("decision-applier: skips intents matching recorded dead-ends", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const intent = graph.addIntent(p.id, { description: "dead path", creator: "planner" });
  graph.failIntent(p.id, intent.id, "proven useless", true);

  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ createIntents: [{ description: "dead path" }, { description: "new path" }] }),
    permissions: perms(["create_intent"]),
  });
  assert.equal(result.intentsCreated, 1);
  assert.equal(graph.intents(p.id, "open").length, 1);
  const openDescriptions = graph.intents(p.id, "open").map((i) => i.description);
  assert.ok(!openDescriptions.includes("dead path"), "dead-end intent must NOT be created");
  assert.ok(openDescriptions.includes("new path"), "new path intent must be created");
});

test("decision-applier: fails intents from failIntents", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const i1 = graph.addIntent(p.id, { description: "wrong dir", creator: "planner" });

  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ failIntents: [{ intentId: i1.id, reason: "hint contradicts" }] }),
    permissions: perms(["fail_intent"]),
  });
  assert.equal(result.intentsFailed, 1);
  assert.equal(graph.getIntent(p.id, i1.id)!.status, "failed");
  assert.equal(graph.getIntent(p.id, i1.id)!.killedBy, "planner");
});

test("decision-applier: failing unknown intentId is silently ignored", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ failIntents: [{ intentId: "i999", reason: "nope" }] }),
    permissions: perms(["fail_intent"]),
  });
  assert.equal(result.intentsFailed, 0);
});

test("decision-applier: consumes hints from decision.consumeHintIds", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const h1 = graph.addHint(p.id, { content: "go left", creator: "metacog" });
  const h2 = graph.addHint(p.id, { content: "go right", creator: "metacog" });

  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ consumeHintIds: [h1.id] }),
    permissions: perms([]),
  });
  assert.equal(result.hintsConsumed, 1);
  assert.equal(graph.unconsumedHints(p.id).length, 1);
  assert.equal(graph.unconsumedHints(p.id)[0].id, h2.id);
});

test("decision-applier: falls back to hintIdsToConsume when consumeHintIds empty", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const h1 = graph.addHint(p.id, { content: "hint", creator: "metacog" });

  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({}),
    hintIdsToConsume: [h1.id],
    permissions: perms([]),
  });
  assert.equal(result.hintsConsumed, 1);
});

test("decision-applier: concludeRun sets project status to completed", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ concludeRun: { description: "goal achieved" } }),
    permissions: perms(["conclude_run"]),
  });
  assert.equal(result.concluded, true);
  assert.equal(graph.getProject(p.id)!.status, "completed");
});

test("decision-applier: throws PermissionDeniedError on createIntent without permission", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  assert.throws(
    () => applyMainDecision({
      projectId: p.id, graph, config: minimalConfig(),
      decision: decision({ createIntents: [{ description: "x" }] }),
      permissions: perms([]),
    }),
    /lacks permission "create_intent"/,
  );
});

test("decision-applier: throws PermissionDeniedError on failIntent without permission", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const i1 = graph.addIntent(p.id, { description: "x", creator: "planner" });
  assert.throws(
    () => applyMainDecision({
      projectId: p.id, graph, config: minimalConfig(),
      decision: decision({ failIntents: [{ intentId: i1.id, reason: "r" }] }),
      permissions: perms([]),
    }),
    /lacks permission "fail_intent"/,
  );
});

test("decision-applier: throws PermissionDeniedError on concludeRun without permission", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  assert.throws(
    () => applyMainDecision({
      projectId: p.id, graph, config: minimalConfig(),
      decision: decision({ concludeRun: { description: "done" } }),
      permissions: perms([]),
    }),
    /lacks permission "conclude_run"/,
  );
});

test("decision-applier: parentFactIds and priority passed through to addIntent", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const f1 = graph.addFact(p.id, { description: "fact", source: "explorer", confidence: 0.9 });
  applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({ createIntents: [{ description: "task", parentFactIds: [f1.id], priority: 5 }] }),
    permissions: perms(["create_intent"]),
  });
  const intent = graph.intents(p.id)[0];
  assert.deepEqual(intent.parentFactIds, [f1.id]);
  assert.equal(intent.priority, 5);
});

test("decision-applier: empty decision returns all-zero result", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);
  const result = applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({}),
    permissions: perms([]),
  });
  assert.equal(result.intentsCreated, 0);
  assert.equal(result.intentsFailed, 0);
  assert.equal(result.hintsConsumed, 0);
  assert.equal(result.concluded, false);
});

test("decision-applier: mid-decision permission error rolls back all mutations", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);

  const decision: MainDecision = {
    createIntents: [
      { description: "first intent" },
      { description: "second intent" },
      { description: "third intent" },
    ],
    failIntents: [],
    consumeHintIds: [],
    concludeRun: undefined,
  };

  const checker: PermissionChecker = new PermissionChecker({
    role: "planner",
    runtime: { worker: "mock" },
    prompt: { file: "x.md" },
    context: { graphView: "full" },
    permissions: ["create_intent", "fail_intent", "write_hint"],
    output: { contract: "main_decision" },
  });

  let callCount = 0;
  const wrapper: PermissionChecker = {
    role: "planner",
    has(p) {
      callCount++;
      if (callCount <= 2) return true;
      return false;
    },
    require(p) {
      callCount++;
      if (callCount > 2) {
        throw { message: `lacks permission "${p}"`, name: "PermissionDeniedError", permission: p };
      }
    },
    requireAny() {},
  } as unknown as PermissionChecker;

  assert.throws(() =>
    applyMainDecision({
      projectId: p.id, graph, config: minimalConfig(),
      decision,
      permissions: wrapper,
    }),
  );

  assert.equal(graph.intents(p.id).length, 0, "no intents should remain after rollback");
});

test("decision-applier: successful decision is fully persisted", () => {
  const graph = new InMemoryGraph();
  const p = createProject(graph);

  applyMainDecision({
    projectId: p.id, graph, config: minimalConfig(),
    decision: decision({
      createIntents: [{ description: "a" }, { description: "b" }],
    }),
    permissions: perms(["create_intent"]),
  });

  assert.equal(graph.intents(p.id).length, 2);
  assert.equal(graph.intents(p.id, "open").length, 2);
});

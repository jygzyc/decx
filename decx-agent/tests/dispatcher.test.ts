/**
 * DispatcherLoop tests — use command-based workers (real `node -e` subprocesses)
 * to control worker output. The JSON payload is passed as a separate argv argument
 * to avoid shell escaping issues: `node -e "console.log(process.argv[1])" '<json>'`
 */
import { test, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { AgentRepository } from "../dist/server/repository.js";
import { DispatcherLoop } from "../dist/dispatcher/loop.js";
import { createTestDb } from "./helper.ts";
import type { TestDb } from "./helper.ts";
import type { WorkerConfig, TaskConfig } from "../dist/core/types.js";

let testDb: TestDb | undefined;

afterEach(() => {
  testDb?.cleanup();
  testDb = undefined;
});

function getDb(): TestDb {
  if (!testDb) testDb = createTestDb();
  return testDb;
}

/** Build a worker config that uses `node -e` to output the given JSON payload. */
function nodeJsonWorker(json: unknown): Partial<WorkerConfig> {
  return {
    command: "node",
    args: ["-e", "console.log(process.argv[1])", JSON.stringify(json)],
  };
}

const BASE_TASK_CONFIG: TaskConfig = {
  task: { name: "disp-test", target: "test.apk", goal: "find bugs" },
  workers: {
    bootWorker: { kind: "agent", ...nodeJsonWorker({ accepted: true, data: { fact: { description: "boot fact", evidence: [] } } }) } as WorkerConfig,
    factWorker: { kind: "agent", ...nodeJsonWorker({ accepted: true, data: { fact: { description: "vuln found", evidence: ["path"] } } }) } as WorkerConfig,
    intentWorker: {
      kind: "agent",
      ...nodeJsonWorker({
        accepted: true,
        data: {
          intents: [
            { from: ["f001"], description: "analyze perms", role: "explorer" },
            { from: ["f001"], description: "check ipc", role: "explorer" },
          ],
        },
      }),
    } as WorkerConfig,
    failWorker: {
      kind: "agent",
      command: "node",
      args: ["-e", "console.error('boom'); process.exit(1)"],
    } as WorkerConfig,
    garbageWorker: {
      kind: "agent",
      command: "node",
      args: ["-e", "console.log('not json at all')"],
    } as WorkerConfig,
    completeWorker: {
      kind: "agent",
      ...nodeJsonWorker({
        accepted: true,
        data: { complete: { from: ["f999"], description: "mission accomplished" } },
      }),
    } as WorkerConfig,
    rejectWorker: {
      kind: "agent",
      ...nodeJsonWorker({ accepted: false, reason: "permission denied" }),
    } as WorkerConfig,
    completePayloadWorker: {
      kind: "agent",
      ...nodeJsonWorker({
        accepted: true,
        data: { complete: { from: ["origin"], description: "done early" } },
      }),
    } as WorkerConfig,
  } as Record<string, WorkerConfig>,
  workflow: {
    phases: [
      { id: "bootstrap", role: "planner" },
      { id: "reason", role: "dispatcher" },
      { id: "explore", role: "explorer" },
    ],
    rules: [],
  },
};

function createProject(repo: AgentRepository, worker: string, overrides?: Partial<TaskConfig>) {
  const config: TaskConfig = {
    ...BASE_TASK_CONFIG,
    ...overrides,
    workflow: {
      ...BASE_TASK_CONFIG.workflow,
      ...(overrides?.workflow ?? {}),
      rules: overrides?.workflow?.rules ?? BASE_TASK_CONFIG.workflow.rules,
    },
  };
  return repo.createProject({
    session: `disp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: "disp-test",
    target: "test.apk",
    goal: "find bugs",
    worker,
    sessionDir: "/tmp",
    configPath: "/tmp/task.json",
    taskConfig: config,
  });
}

// ─── Bootstrap phase produces a fact ────────────────────────────────

test("DispatcherLoop: bootstrap phase produces a fact", async () => {
  const repo = new AgentRepository(getDb().db);
  const detail = createProject(repo, "bootWorker");
  const loop = new DispatcherLoop(repo);

  await loop.runProject(detail.project.id, { maxSteps: 1 });

  const refreshed = repo.getProject(detail.project.id);
  const bootFact = refreshed.facts.find((f) => f.description === "boot fact");
  assert.ok(bootFact, `should have boot fact. Facts: ${refreshed.facts.map(f => f.description).join(", ")}`);
  assert.equal(refreshed.project.status, "active");
});

// ─── Explore phase concludes intent and produces fact ───────────────

test("DispatcherLoop: explore phase concludes intent and produces fact", async () => {
  const repo = new AgentRepository(getDb().db);
  const detail = createProject(repo, "factWorker");

  repo.addIntent(detail.project.id, {
    from: ["origin"],
    description: "investigate",
    creator: "dispatcher",
    role: "explorer",
  });

  const loop = new DispatcherLoop(repo);
  await loop.runProject(detail.project.id, { maxSteps: 1 });

  const refreshed = repo.getProject(detail.project.id);
  const vulnFact = refreshed.facts.find((f) => f.description === "vuln found");
  assert.ok(vulnFact, `should have vuln fact. Facts: ${refreshed.facts.map(f => f.description).join(", ")}`);

  const intents = refreshed.intents.filter((i) => i.description === "investigate");
  assert.equal(intents.length, 1);
  assert.equal(intents[0].status, "done");
  assert.ok(intents[0].to, "intent should have to_fact_id set");
});

test("DispatcherLoop: executes higher priority open intent first", async () => {
  const repo = new AgentRepository(getDb().db);
  const detail = createProject(repo, "factWorker");

  const low = repo.addIntent(detail.project.id, {
    from: ["origin"],
    description: "low priority",
    creator: "dispatcher",
    role: "explorer",
    priority: 1,
  });
  const high = repo.addIntent(detail.project.id, {
    from: ["origin"],
    description: "high priority",
    creator: "dispatcher",
    role: "explorer",
    priority: 9,
  });

  const loop = new DispatcherLoop(repo);
  await loop.runProject(detail.project.id, { maxSteps: 1 });

  const refreshed = repo.getProject(detail.project.id);
  assert.equal(refreshed.intents.find((i) => i.id === high.id)?.status, "done");
  assert.equal(refreshed.intents.find((i) => i.id === low.id)?.status, "open");
});

// ─── Reason phase produces intents ──────────────────────────────────

test("DispatcherLoop: reason phase produces intents", async () => {
  const repo = new AgentRepository(getDb().db);
  const detail = createProject(repo, "intentWorker");

  repo.addFact(detail.project.id, {
    id: "f001",
    description: "critical component",
    evidence: [],
    source: "planner",
    confidence: 1.0,
    createdAt: new Date().toISOString(),
  });

  const loop = new DispatcherLoop(repo);
  await loop.runProject(detail.project.id, { maxSteps: 1 });

  const refreshed = repo.getProject(detail.project.id);
  const openIntents = refreshed.intents.filter((i) => i.status === "open");
  assert.ok(openIntents.length >= 1,
    `expected at least 1 open intent, got ${openIntents.length}. Intents: ${JSON.stringify(refreshed.intents.map(i => i.description))}`);
  assert.ok(openIntents.some((i) => i.description === "analyze perms") ||
    openIntents.some((i) => i.description === "check ipc"));
});

// ─── Worker failure fails the intent ────────────────────────────────

test("DispatcherLoop: worker failure (returncode != 0) fails the intent", async () => {
  const repo = new AgentRepository(getDb().db);
  const detail = createProject(repo, "failWorker");

  repo.addIntent(detail.project.id, {
    from: ["origin"],
    description: "doomed intent",
    creator: "dispatcher",
  });

  const loop = new DispatcherLoop(repo);
  await loop.runProject(detail.project.id, { maxSteps: 1 });

  const refreshed = repo.getProject(detail.project.id);
  const doomed = refreshed.intents.find((i) => i.description === "doomed intent");
  assert.ok(doomed);
  assert.equal(doomed.status, "failed");
  assert.ok(doomed.failureReason, "should have failure reason");
});

// ─── Parse failure fails the intent ─────────────────────────────────

test("DispatcherLoop: parse failure fails the intent", async () => {
  const repo = new AgentRepository(getDb().db);
  const detail = createProject(repo, "garbageWorker");

  repo.addIntent(detail.project.id, {
    from: ["origin"],
    description: "garbled output",
    creator: "dispatcher",
    role: "explorer",
  });

  const loop = new DispatcherLoop(repo);
  await loop.runProject(detail.project.id, { maxSteps: 1 });

  const refreshed = repo.getProject(detail.project.id);
  const garbled = refreshed.intents.find((i) => i.description === "garbled output");
  assert.ok(garbled);
  assert.equal(garbled.status, "failed");
  assert.ok(garbled.failureReason, "should have a failure reason");
});

// ─── Autonomy violation fails the intent ────────────────────────────

test("DispatcherLoop: autonomy violation (complete by explorer) fails the intent", async () => {
  const repo = new AgentRepository(getDb().db);
  const detail = createProject(repo, "completePayloadWorker");

  repo.addIntent(detail.project.id, {
    from: ["origin"],
    description: "should not complete",
    creator: "dispatcher",
    role: "explorer",
  });

  const loop = new DispatcherLoop(repo);
  await loop.runProject(detail.project.id, { maxSteps: 1 });

  const refreshed = repo.getProject(detail.project.id);
  const intent = refreshed.intents.find((i) => i.description === "should not complete");
  assert.ok(intent);
  assert.equal(intent.status, "failed");
  assert.ok(intent.failureReason, "should have autonomy violation reason");
});

// ─── Rejection fails the intent ─────────────────────────────────────

test("DispatcherLoop: rejected payload fails the intent", async () => {
  const repo = new AgentRepository(getDb().db);
  const detail = createProject(repo, "rejectWorker");

  repo.addIntent(detail.project.id, {
    from: ["origin"],
    description: "worker says no",
    creator: "dispatcher",
    role: "explorer",
  });

  const loop = new DispatcherLoop(repo);
  await loop.runProject(detail.project.id, { maxSteps: 1 });

  const refreshed = repo.getProject(detail.project.id);
  const intent = refreshed.intents.find((i) => i.description === "worker says no");
  assert.ok(intent);
  assert.equal(intent.status, "failed");
});

// ─── Workflow rules fire on matching events ────────────────────────

test("DispatcherLoop: workflow rules fire on failure and create intents", async () => {
  const repo = new AgentRepository(getDb().db);

  const config: TaskConfig = {
    ...BASE_TASK_CONFIG,
    workflow: {
      ...BASE_TASK_CONFIG.workflow,
      rules: [
        {
          id: "danger-rule",
          when: { eventType: "worker.failed" },
          then: [
            { createIntent: { description: "Emergency: retry failed work", role: "explorer" } },
          ],
        },
      ],
    },
  };

  const detail = repo.createProject({
    session: `wf_${Date.now()}`,
    name: "wf-test",
    target: "t.apk",
    goal: "g",
    worker: "failWorker",
    sessionDir: "/tmp",
    configPath: "/tmp/c.json",
    taskConfig: config,
  });

  repo.addIntent(detail.project.id, {
    from: ["origin"],
    description: "dangerous intent",
    creator: "dispatcher",
    role: "explorer",
  });

  const loop = new DispatcherLoop(repo);
  await loop.runProject(detail.project.id, { maxSteps: 1 });

  const refreshed = repo.getProject(detail.project.id);

  const original = refreshed.intents.find((i) => i.description === "dangerous intent");
  assert.ok(original);
  assert.equal(original.status, "failed");

  const emergency = refreshed.intents.find((i) => i.description === "Emergency: retry failed work");
  assert.ok(emergency, `workflow rule should create emergency intent. Intents: ${JSON.stringify(refreshed.intents.map(i => i.description))}`);
  assert.equal(emergency.status, "open");
  assert.equal(emergency.creator, "workflow");
});

// ─── Complete closes project ────────────────────────────────────────

test("DispatcherLoop: complete payload closes the project", async () => {
  const repo = new AgentRepository(getDb().db);
  const detail = createProject(repo, "completeWorker");

  repo.addFact(detail.project.id, {
    id: "f999",
    description: "pre-existing",
    evidence: [],
    source: "planner",
    confidence: 1.0,
    createdAt: new Date().toISOString(),
  });

  const loop = new DispatcherLoop(repo);
  await loop.runProject(detail.project.id, { maxSteps: 1 });

  const refreshed = repo.getProject(detail.project.id);
  assert.equal(refreshed.project.status, "completed");
});

// ─── maxSteps limiting ──────────────────────────────────────────────

test("DispatcherLoop: stops at maxSteps", async () => {
  const repo = new AgentRepository(getDb().db);
  const detail = createProject(repo, "bootWorker");
  const loop = new DispatcherLoop(repo);

  await loop.runProject(detail.project.id, { maxSteps: 3 });

  const refreshed = repo.getProject(detail.project.id);
  // After 3 bootstrap steps: origin + goal + 3 boot facts = 5 facts
  const bootFacts = refreshed.facts.filter((f) => f.description === "boot fact");
  assert.equal(bootFacts.length, 3,
    `expected 3 boot facts, got ${bootFacts.length}. Facts: ${JSON.stringify(refreshed.facts.map(f => f.description))}`);
});

// ─── Bootstrap phase detection ──────────────────────────────────────

test("DispatcherLoop: step() on empty project runs bootstrap", async () => {
  const repo = new AgentRepository(getDb().db);
  const detail = createProject(repo, "bootWorker");
  const loop = new DispatcherLoop(repo);

  await loop.step(detail.project.id);

  const refreshed = repo.getProject(detail.project.id);
  assert.ok(refreshed.facts.length >= 3,
    `expected >=3 facts, got ${refreshed.facts.length}. Facts: ${JSON.stringify(refreshed.facts.map(f => f.description))}`);
  const boot = refreshed.facts.find((f) => f.description === "boot fact");
  assert.ok(boot, `should have boot fact. Facts: ${refreshed.facts.map(f => f.description).join(", ")}`);
});

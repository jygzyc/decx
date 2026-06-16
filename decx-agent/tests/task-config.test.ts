/**
 * Task config loading tests — creates real task.json files in tempdirs.
 */
import { test, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTaskConfigInput } from "../dist/core/task-config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "decx-agent-tsk-"));
  tempDirs.push(dir);
  return dir;
}

function writeTaskJson(dir: string, content: Record<string, unknown>): string {
  const path = join(dir, "task.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

// ─── Basic loading ──────────────────────────────────────────────────

test("loadTaskConfigInput: loads minimal task.json with target and goal", () => {
  const dir = makeTempDir();
  writeTaskJson(dir, {
    task: { target: "test.apk", goal: "analyze" },
  });

  const result = loadTaskConfigInput(join(dir, "task.json"));
  assert.equal(result.config.task.target, "test.apk");
  assert.equal(result.config.task.goal, "analyze");
  assert.ok(Object.keys(result.config.workers).length >= 0);
  assert.ok(Array.isArray(result.config.workflow.phases));
});

test("loadTaskConfigInput: resolves agent prompts from markdown file", () => {
  const dir = makeTempDir();
  writeFileSync(join(dir, "custom-agent.md"), "# Custom Agent\n\nYou are a custom agent.");
  writeTaskJson(dir, {
    task: { target: "t", goal: "g" },
    roles: {
      custom: {
        prompt: "custom-agent.md",
      },
    },
  });

  const result = loadTaskConfigInput(join(dir, "task.json"));
  const agents = result.config.agents;
  assert.ok(agents, "agents should exist");
  const custom = agents["custom"];
  assert.ok(custom, "custom agent should exist");
  assert.ok(custom.promptText?.includes("You are a custom agent"),
    `expected md content in promptText, got: ${custom.promptText}`);
  assert.equal(custom.prompt, "custom-agent.md");
});

test("loadTaskConfigInput: session name defaults to dir name", () => {
  const dir = makeTempDir();
  // Use a subdir with a meaningful name for the session
  const sessionDir = join(dir, "my-session");
  mkdirSync(sessionDir);
  writeTaskJson(sessionDir, {
    task: { target: "t", goal: "g" },
  });

  const result = loadTaskConfigInput(join(sessionDir, "task.json"));
  assert.equal(result.session, "my-session");
});

// ─── Worker config parsing ──────────────────────────────────────────

test("loadTaskConfigInput: parses worker config with kind and backend", () => {
  const dir = makeTempDir();
  writeTaskJson(dir, {
    task: { target: "t", goal: "g" },
    workers: {
      mycodex: { kind: "agent", backend: "codex", model: "gpt-5" },
      myapi: { kind: "api", provider: "anthropic" },
    },
  });

  const result = loadTaskConfigInput(join(dir, "task.json"));
  const workers = result.config.workers;
  assert.equal(workers.mycodex.kind, "agent");
  assert.equal(workers.mycodex.backend, "codex");
  assert.equal(workers.mycodex.model, "gpt-5");
  assert.equal(workers.myapi.kind, "api");
  assert.equal(workers.myapi.provider, "anthropic");
});

test("loadTaskConfigInput: maps legacy 'command' → 'agent', 'model' → 'api'", () => {
  const dir = makeTempDir();
  writeTaskJson(dir, {
    task: { target: "t", goal: "g" },
    workers: {
      legacyCommand: { kind: "command" },
      legacyModel: { kind: "model" },
    },
  });

  const result = loadTaskConfigInput(join(dir, "task.json"));
  assert.equal(result.config.workers.legacyCommand.kind, "agent");
  assert.equal(result.config.workers.legacyModel.kind, "api");
});

// ─── Workflow phases ────────────────────────────────────────────────

test("loadTaskConfigInput: parses workflow phases", () => {
  const dir = makeTempDir();
  writeTaskJson(dir, {
    task: { target: "t", goal: "g" },
    workflow: {
      phases: [
        { id: "bootstrap", role: "planner" },
        { id: "explore", role: "explorer", worker: "codex" },
      ],
    },
  });

  const result = loadTaskConfigInput(join(dir, "task.json"));
  const phases = result.config.workflow.phases;
  assert.equal(phases.length, 2);
  assert.equal(phases[0].id, "bootstrap");
  assert.equal(phases[0].role, "planner");
  assert.equal(phases[1].id, "explore");
  assert.equal(phases[1].worker, "codex");
});

// ─── Workflow rules ─────────────────────────────────────────────────

test("loadTaskConfigInput: parses workflow rules", () => {
  const dir = makeTempDir();
  writeTaskJson(dir, {
    task: { target: "t", goal: "g" },
    workflow: {
      rules: [
        {
          id: "rule-1",
          when: { eventType: "fact.found" },
          then: [{ createIntent: { description: "investigate" } }],
        },
      ],
    },
  });

  const result = loadTaskConfigInput(join(dir, "task.json"));
  const rules = result.config.workflow.rules;
  assert.ok(rules);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "rule-1");
  assert.equal(rules[0].when.eventType, "fact.found");
});

// ─── Validation ─────────────────────────────────────────────────────

test("loadTaskConfigInput: throws on missing task.target", () => {
  const dir = makeTempDir();
  writeTaskJson(dir, { task: {} });
  assert.throws(
    () => loadTaskConfigInput(join(dir, "task.json")),
    /task.target/,
  );
});

test("loadTaskConfigInput: throws on missing task.goal", () => {
  const dir = makeTempDir();
  writeTaskJson(dir, { task: { target: "t" } });
  assert.throws(
    () => loadTaskConfigInput(join(dir, "task.json")),
    /task.goal/,
  );
});

test("loadTaskConfigInput: throws when task config not found", () => {
  const dir = makeTempDir();
  assert.throws(
    () => loadTaskConfigInput(join(dir, "nonexistent-task.json")),
    /not found/,
  );
});

// ─── Input is a directory (resolves to task.json inside) ────────────

test("loadTaskConfigInput: resolves directory to task.json inside it", () => {
  const dir = makeTempDir();
  writeTaskJson(dir, {
    task: { target: "dir.apk", goal: "dir goal" },
  });

  const result = loadTaskConfigInput(dir); // pass directory, not file
  assert.equal(result.config.task.target, "dir.apk");
});

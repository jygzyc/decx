import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config/task-config.js";
import { defaultConfig } from "../dist/config/default-config.js";

test("loadConfig: reads minimal task.json with target + goal", () => {
  const dir = mkdtempSync(join(tmpdir(), "decx-cfg-"));
  const cfg = {
    task: { target: "app.apk", goal: "find vulns" },
  };
  writeFileSync(join(dir, "task.json"), JSON.stringify(cfg));

  const { config, session } = loadConfig(join(dir, "task.json"));
  assert.equal(config.task.target, "app.apk");
  assert.equal(config.task.goal, "find vulns");
  assert.ok(session);
  assert.equal(config.profiles.planner.runtime.worker, "opencode");
});

test("loadConfig: overrides workers and workflow", () => {
  const dir = mkdtempSync(join(tmpdir(), "decx-cfg-"));
  const cfg = {
    task: { target: "T", goal: "G" },
    workers: {
      opencode: { kind: "agent", backend: "opencode", model: "claude-sonnet-4" },
    },
    workflow: {
      limits: { maxSteps: 500, maxConcurrent: 5 },
    },
  };
  writeFileSync(join(dir, "task.json"), JSON.stringify(cfg));

  const { config } = loadConfig(join(dir, "task.json"));
  assert.equal(config.workflow.limits.maxSteps, 500);
  assert.equal(config.workflow.limits.maxConcurrent, 5);
  assert.equal(config.workers.opencode.model, "claude-sonnet-4");
});

test("loadConfig: explorer can declare a worker pool", () => {
  const dir = mkdtempSync(join(tmpdir(), "decx-cfg-"));
  const cfg = {
    task: { target: "T", goal: "G" },
    profiles: {
      explorer: { runtime: { worker: "codex", workers: ["codex", "claude-code"] }, prompt: { file: "explorer.md" } },
    },
    workers: {
      codex: { kind: "agent", backend: "codex" },
      "claude-code": { kind: "agent", backend: "claude-code" },
    },
  };
  writeFileSync(join(dir, "task.json"), JSON.stringify(cfg));

  const { config } = loadConfig(join(dir, "task.json"));
  assert.deepEqual(config.profiles.explorer.runtime.workers, ["codex", "claude-code"]);
});

test("loadConfig: rejects removed agents config shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "decx-cfg-"));
  writeFileSync(join(dir, "task.json"), JSON.stringify({
    task: { target: "T", goal: "G" },
    agents: { explorer: { worker: "opencode" } },
  }));
  assert.throws(() => loadConfig(join(dir, "task.json")), /removed field agents/);
});


test("loadConfig: throws on missing target", () => {
  const dir = mkdtempSync(join(tmpdir(), "decx-cfg-"));
  writeFileSync(join(dir, "task.json"), JSON.stringify({ task: { goal: "G" } }));
  assert.throws(() => loadConfig(join(dir, "task.json")), /target/);
});

test("loadConfig: throws on missing goal", () => {
  const dir = mkdtempSync(join(tmpdir(), "decx-cfg-"));
  writeFileSync(join(dir, "task.json"), JSON.stringify({ task: { target: "T" } }));
  assert.throws(() => loadConfig(join(dir, "task.json")), /goal/);
});

test("loadConfig: throws on nonexistent file", () => {
  assert.throws(() => loadConfig("/nonexistent/task.json"), /not found/);
});

test("loadConfig: session override works", () => {
  const dir = mkdtempSync(join(tmpdir(), "decx-cfg-"));
  writeFileSync(join(dir, "task.json"), JSON.stringify({ task: { target: "T", goal: "G" } }));
  const { session } = loadConfig(join(dir, "task.json"), "custom-session");
  assert.equal(session, "custom-session");
});

test("defaultConfig: returns valid config with opencode as default worker", () => {
  const config = defaultConfig();
  assert.equal(config.profiles.planner.runtime.worker, "opencode");
  assert.equal(config.profiles.explorer.runtime.worker, "opencode");
  assert.equal(config.profiles.evaluator.runtime.worker, "opencode");
  assert.ok(config.profiles.planner.prompt.file);
  assert.ok(config.profiles.explorer.prompt.file);
  assert.ok(config.profiles.evaluator.prompt.file);
  assert.ok(config.workers.opencode);
  assert.equal(config.workers.opencode.kind, "agent");
});

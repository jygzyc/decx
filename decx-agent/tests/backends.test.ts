/**
 * Tests for agent backends: SubprocessBackend implementations + HTTP backend + registry.
 * Pure argv construction tests — no real subprocess spawning.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ClaudeBackend } from "../dist/workers/agent-backends/claude.js";
import { CodexBackend } from "../dist/workers/agent-backends/codex.js";
import { OpencodeCliBackend } from "../dist/workers/agent-backends/opencode-cli.js";
import { ProcessBackend } from "../dist/workers/agent-backends/process.js";
import { OpencodeHttpBackend } from "../dist/workers/agent-backends/opencode-http.js";
import { getAgentBackend, listAgentBackendIds, registerAgentBackend } from "../dist/workers/agent-backends/registry.js";
import type { WorkerConfig } from "../dist/core/types.js";

const noopConfig: WorkerConfig = { kind: "agent" };

// ─── ClaudeBackend.buildArgv ────────────────────────────────────────

test("ClaudeBackend.buildArgv: basic argv", () => {
  const backend = new ClaudeBackend();
  const result = backend.buildArgv(noopConfig, "hello");
  assert.deepEqual(result.argv, ["claude", "--dangerously-skip-permissions", "-p", "--", "hello"]);
});

test("ClaudeBackend.buildArgv: model sets ANTHROPIC_MODEL env", () => {
  const backend = new ClaudeBackend();
  const result = backend.buildArgv({ kind: "agent", model: "claude-3-opus" }, "test");
  assert.equal(result.env?.ANTHROPIC_MODEL, "claude-3-opus");
});

test("ClaudeBackend.buildArgv: baseUrl sets ANTHROPIC_BASE_URL env", () => {
  const backend = new ClaudeBackend();
  const result = backend.buildArgv({ kind: "agent", baseUrl: "https://gw.example.com" }, "test");
  assert.equal(result.env?.ANTHROPIC_BASE_URL, "https://gw.example.com");
});

test("ClaudeBackend.id is claude-code", () => {
  assert.equal(new ClaudeBackend().id, "claude-code");
});

// ─── CodexBackend.buildArgv ─────────────────────────────────────────

test("CodexBackend.buildArgv: basic argv", () => {
  const backend = new CodexBackend();
  const result = backend.buildArgv(noopConfig, "hello");
  assert.ok(result.argv[0] === "codex");
  assert.ok(result.argv.includes("hello"));
  assert.ok(result.argv.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("CodexBackend.buildArgv: model flag from config", () => {
  const backend = new CodexBackend();
  const result = backend.buildArgv({ kind: "agent", model: "o3-mini" }, "test");
  const modelIdx = result.argv.indexOf("--model");
  assert.ok(modelIdx >= 0);
  assert.equal(result.argv[modelIdx + 1], "o3-mini");
});

test("CodexBackend.buildArgv: provider flags when baseUrl set", () => {
  const backend = new CodexBackend();
  const result = backend.buildArgv({ kind: "agent", baseUrl: "https://gw.example.com" }, "test");
  assert.ok(result.argv.some(a => a.includes("decx")));
});

test("CodexBackend.buildArgv: no provider flags without baseUrl", () => {
  const backend = new CodexBackend();
  const result = backend.buildArgv(noopConfig, "test");
  assert.ok(!result.argv.some(a => typeof a === "string" && a.includes("model_provider")));
});

// ─── OpencodeCliBackend.buildArgv ───────────────────────────────────

test("OpencodeCliBackend.buildArgv: simple argv", () => {
  const backend = new OpencodeCliBackend();
  const result = backend.buildArgv(noopConfig, "do something");
  assert.deepEqual(result.argv, ["opencode", "run", "do something"]);
});

// ─── ProcessBackend.buildArgv ───────────────────────────────────────

test("ProcessBackend.buildArgv: uses command and args, stdin input", () => {
  const backend = new ProcessBackend();
  const result = backend.buildArgv({ kind: "agent", command: "node", args: ["-e", "script"] }, "prompt-text");
  assert.deepEqual(result.argv, ["node", "-e", "script"]);
  assert.equal(result.input, "prompt-text");
});

test("ProcessBackend.buildArgv: defaults to echo when no command", () => {
  const backend = new ProcessBackend();
  const result = backend.buildArgv(noopConfig, "test");
  assert.equal(result.argv[0], "echo");
});

// ─── OpencodeHttpBackend ────────────────────────────────────────────

test("OpencodeHttpBackend.id is opencode-http", () => {
  assert.equal(new OpencodeHttpBackend().id, "opencode-http");
});

// ─── Registry ───────────────────────────────────────────────────────

test("getAgentBackend: returns correct backend instances", () => {
  assert.ok(getAgentBackend("claude-code") instanceof ClaudeBackend);
  assert.ok(getAgentBackend("codex") instanceof CodexBackend);
  assert.ok(getAgentBackend("opencode") instanceof OpencodeCliBackend);
  assert.ok(getAgentBackend("opencode-http") instanceof OpencodeHttpBackend);
  assert.ok(getAgentBackend("process") instanceof ProcessBackend);
});

test("getAgentBackend: returns undefined for unknown id", () => {
  assert.equal(getAgentBackend("nonexistent"), undefined);
});

test("listAgentBackendIds: includes all built-in backends", () => {
  const ids = listAgentBackendIds();
  assert.ok(ids.includes("claude-code"));
  assert.ok(ids.includes("codex"));
  assert.ok(ids.includes("opencode"));
  assert.ok(ids.includes("opencode-http"));
  assert.ok(ids.includes("process"));
});

test("registerAgentBackend: registers and returns unregister function", () => {
  const fake = { id: "fake-backend", invoke: () => ({ text: "", returncode: 0 }) };
  const unregister = registerAgentBackend(fake as never);
  assert.equal(getAgentBackend("fake-backend"), fake);
  unregister();
  assert.equal(getAgentBackend("fake-backend"), undefined);
});

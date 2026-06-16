/**
 * AgentDriver tests — use command-based workers with real `node -e` subprocesses
 * to test the driver without spawning real claude/codex/opencode binaries.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { WorkerRequest } from "../dist/workers/base.js";
import type { AgentBackend } from "../dist/workers/agent-backends/types.js";

const { AgentDriver } = await import("../dist/workers/agent-driver.js");
const { registerAgentBackend } = await import("../dist/workers/agent-backends/registry.js");

function makeRequest(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    worker: "test-worker",
    phase: "explore",
    role: "explorer",
    projectId: "proj_test",
    sessionDir: "/tmp/sess",
    prompt: "test prompt",
    ...overrides,
  };
}

/** Build a node -e worker that outputs a JSON payload passed via argv. */
function nodeJsonOutput(json: unknown): { command: string; args: string[] } {
  return {
    command: "node",
    args: ["-e", "console.log(process.argv[1])", JSON.stringify(json)],
  };
}

function mockBackend(id: string, text: string): AgentBackend {
  return {
    id,
    invoke(input) {
      return {
        text: JSON.stringify({ accepted: true, data: { fact: { description: `${text}:${input.prompt}` } } }),
        returncode: 0,
        stderr: "",
      };
    },
  };
}

// ─── Unknown backend error ──────────────────────────────────────────

test("AgentDriver: returns error when no backend and no command", async () => {
  const driver = new AgentDriver("made-up-name", { kind: "agent" });
  const result = await driver.execute(makeRequest({ worker: "made-up-name" }));

  assert.equal(result.returncode, 2);
  assert.ok(result.stderr.includes("unknown agent backend"),
    `expected "unknown agent backend" in stderr, got: ${result.stderr}`);
  assert.ok(result.stderr.includes("made-up-name"));
});

test("AgentDriver: returns error for unknown worker name", async () => {
  const driver = new AgentDriver("also-unknown", { kind: "agent" });
  const result = await driver.execute(makeRequest({ worker: "also-unknown" }));

  assert.equal(result.returncode, 2);
  assert.ok(result.stderr.includes("unknown agent backend"));
});

// ─── Command-based ProcessAdapter (real node subprocess) ────────────

test("AgentDriver: executes command-based worker via ProcessAdapter with stdin", async () => {
  const driver = new AgentDriver("node-worker", {
    kind: "agent",
    ...nodeJsonOutput({ accepted: true, data: { fact: { description: "hello-world" } } }),
  });

  const result = await driver.execute(makeRequest({
    worker: "node-worker",
    prompt: "unused prompt goes to stdin",
  }));

  assert.equal(result.returncode, 0, `expected exit 0, got ${result.returncode} stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("hello-world"),
    `expected stdout to contain "hello-world", got: ${result.stdout}`);
});

test("AgentDriver: command worker with exit code 1 returns stderr", async () => {
  const driver = new AgentDriver("fail-worker", {
    kind: "agent",
    command: "node",
    args: ["-e", "console.error('custom error'); process.exit(1)"],
  });

  const result = await driver.execute(makeRequest({ worker: "fail-worker", prompt: "test" }));

  assert.equal(result.returncode, 1);
  assert.ok(result.stderr.includes("custom error"),
    `expected stderr to contain "custom error", got: ${result.stderr}`);
});

// ─── Non-existent binary spawn error (exit code 127) ────────────────

test("AgentDriver: returns exit code 127 when binary is missing", async () => {
  const driver = new AgentDriver("missing", {
    kind: "agent",
    command: "definitely-not-a-real-binary-xyzzy",
  });

  const result = await driver.execute(makeRequest({ worker: "missing", prompt: "test" }));

  assert.equal(result.returncode, 127);
  assert.ok(result.stderr.length > 0, "stderr should contain ENOENT message");
});

// ─── Backend-based adapter resolution ───────────────────────────────

test("AgentDriver: resolves adapter via config.backend", async () => {
  const unregister = registerAgentBackend(mockBackend("mock-backend", "mock-resolved"));
  try {
    const driver = new AgentDriver("other-name", { kind: "agent", backend: "mock-backend" });
    const result = await driver.execute(makeRequest({ worker: "other-name", prompt: "test" }));

    assert.equal(result.returncode, 0);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.includes("mock-resolved:test"),
      `expected mock backend stdout, got: ${result.stdout}`);
  } finally {
    unregister();
  }
});

// ─── Backend overrides command: backend is checked FIRST ────────────

test("AgentDriver: backend takes priority over command field", async () => {
  const unregister = registerAgentBackend(mockBackend("opencode", "mock-opencode"));
  try {
    const driver = new AgentDriver("some-worker", {
      kind: "agent",
      backend: "opencode",
      command: "node",
      args: ["-e", "console.log('should-not-be-used')"],
    });

    const result = await driver.execute(makeRequest({ worker: "some-worker", prompt: "test" }));

    assert.equal(result.returncode, 0);
    assert.ok(result.stdout.includes("mock-opencode:test"),
      `expected registered backend to win over command fallback, got: ${result.stdout}`);
    assert.ok(!result.stdout.includes("should-not-be-used"),
      "command fallback should not run when backend is registered");
  } finally {
    unregister();
  }
});

// ─── extractText passes through stdout ──────────────────────────────

test("AgentDriver: backend stdout pass-through", async () => {
  const driver = new AgentDriver("echo-worker", {
    kind: "agent",
    ...nodeJsonOutput({ accepted: true, data: { fact: { description: "raw-output" } } }),
  });

  const result = await driver.execute(makeRequest({ worker: "echo-worker", prompt: "" }));

  assert.ok(result.stdout.includes("raw-output"),
    `expected raw stdout, got: ${result.stdout}`);
});

/**
 * ApiDriver tests — use registerProvider to inject a mock ModelProvider.
 * No network calls, no module mocking needed.
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { ApiDriver, resolveProviderId } from "../dist/workers/api-driver.js";
import { registerProvider, getProvider } from "../dist/workers/providers/registry.js";
import type { WorkerRequest } from "../dist/workers/base.js";
import type { ModelCallInput, ModelCallResult } from "../dist/workers/providers/registry.js";

function makeRequest(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    worker: "api",
    phase: "explore",
    role: "explorer",
    projectId: "proj_test",
    sessionDir: "/tmp/sess",
    prompt: "test prompt",
    config: { kind: "api", provider: "mock-test" },
    ...overrides,
  };
}

// Register a mock provider before tests, unregister after.
let unregisterMock: (() => void) | undefined;

before(() => {
  unregisterMock = registerProvider({
    id: "mock-test",
    async complete(_input: ModelCallInput, _config: unknown): Promise<ModelCallResult> {
      return { text: "Hello from mock provider!" };
    },
  });
});

after(() => {
  unregisterMock?.();
});

// ─── Successful call ────────────────────────────────────────────────

test("ApiDriver: returns provider's text when provider exists", async () => {
  const driver = new ApiDriver("api", { kind: "api", provider: "mock-test" });
  const result = await driver.execute(makeRequest());

  assert.equal(result.returncode, 0);
  assert.equal(result.stdout, "Hello from mock provider!");
  assert.equal(result.stderr, "");
});

// ─── Unknown provider ───────────────────────────────────────────────

test("ApiDriver: returns error when provider id is unknown", async () => {
  assert.equal(getProvider("nonexistent-provider-xyz"), undefined,
    "sanity: nonexistent provider should not exist");

  const driver = new ApiDriver("api", { kind: "api", provider: "nonexistent-provider-xyz" });
  const result = await driver.execute(makeRequest({
    config: { kind: "api", provider: "nonexistent-provider-xyz" },
  }));

  assert.equal(result.returncode, 1);
  assert.ok(result.stderr.includes("unknown model provider"),
    `expected "unknown model provider" in stderr, got: ${result.stderr}`);
  assert.ok(result.stderr.includes("nonexistent-provider-xyz"));
});

// ─── Provider throws ────────────────────────────────────────────────

test("ApiDriver: returns error when provider.complete throws", async () => {
  // Register a throwing provider inline
  const unreg = registerProvider({
    id: "thrower-test",
    async complete(): Promise<ModelCallResult> {
      throw new Error("rate limit exceeded");
    },
  });

  try {
    const driver = new ApiDriver("thrower", { kind: "api", provider: "thrower-test" });
    const result = await driver.execute(makeRequest({
      worker: "thrower",
      config: { kind: "api", provider: "thrower-test" },
    }));

    assert.equal(result.returncode, 1);
    assert.ok(result.stderr.includes("rate limit exceeded"));
    assert.equal(result.stdout, "");
  } finally {
    unreg();
  }
});

// ─── resolveProviderId (pure function tests) ────────────────────────

test("resolveProviderId: config.provider wins over everything", () => {
  assert.equal(resolveProviderId({ kind: "api", provider: "anthropic" }), "anthropic");
  assert.equal(resolveProviderId({ kind: "api", provider: "openai-compatible" }), "openai-compatible");
});

test("resolveProviderId: falls back to DECX_AGENT_API_PROVIDER env", () => {
  const oldVal = process.env.DECX_AGENT_API_PROVIDER;
  process.env.DECX_AGENT_API_PROVIDER = "anthropic";
  try {
    assert.equal(resolveProviderId({ kind: "api" }), "anthropic");
  } finally {
    if (oldVal !== undefined) process.env.DECX_AGENT_API_PROVIDER = oldVal;
    else delete process.env.DECX_AGENT_API_PROVIDER;
  }
});

test("resolveProviderId: ANTHROPIC_API_KEY and OPENAI_API_KEY detection", () => {
  const saved = {
    DECX_AGENT_API_PROVIDER: process.env.DECX_AGENT_API_PROVIDER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.DECX_AGENT_API_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    assert.equal(resolveProviderId({ kind: "api" }), "openai");

    process.env.OPENAI_API_KEY = "sk-test";
    assert.equal(resolveProviderId({ kind: "api" }), "openai");
    delete process.env.OPENAI_API_KEY;

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    assert.equal(resolveProviderId({ kind: "api" }), "anthropic");

    process.env.DECX_AGENT_API_PROVIDER = "openai-compatible";
    assert.equal(resolveProviderId({ kind: "api" }), "openai-compatible");
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  }
});

test("resolveProviderId: trims whitespace from config.provider", () => {
  assert.equal(resolveProviderId({ kind: "api", provider: "  openai  " }), "openai");
});

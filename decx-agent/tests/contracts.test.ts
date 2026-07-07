import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  validateMainDecision,
  validateCandidateFact,
  validateVerdict,
  validateChain,
  validateHints,
  validateStop,
} from "../dist/agent/contracts.js";
import { parseEnvelope } from "../dist/agent/parse-envelope.js";

function env(kind: string, data: unknown): ReturnType<typeof parseEnvelope> {
  return parseEnvelope(JSON.stringify({ kind, data }), "test");
}

test("contracts: validateMainDecision parses createIntents with from+priority", () => {
  const d = validateMainDecision(env("decisions", {
    createIntents: [{ description: "do X", from: ["f001"], priority: 2 }],
    failIntents: [{ intentId: "i002", reason: "wrong" }],
    concludeRun: null,
  }));
  assert.equal(d.createIntents.length, 1);
  assert.equal(d.createIntents[0].description, "do X");
  assert.deepEqual(d.createIntents[0].parentFactIds, ["f001"]);
  assert.equal(d.createIntents[0].priority, 2);
  assert.equal(d.failIntents[0].intentId, "i002");
  assert.equal(d.concludeRun, undefined);
});

test("contracts: validateMainDecision parses concludeRun", () => {
  const d = validateMainDecision(env("decisions", {
    createIntents: [], failIntents: [],
    concludeRun: { description: "goal met" },
  }));
  assert.equal(d.concludeRun!.description, "goal met");
});

test("contracts: validateCandidateFact defaults confidence to 0.7", () => {
  const c = validateCandidateFact(env("fact", { description: "x", evidence: [] }), "explorer");
  assert.equal(c.confidence, 0.7);
});

test("contracts: validateCandidateFact parses evidence array", () => {
  const c = validateCandidateFact(env("fact", { description: "x", evidence: ["a", "b"], confidence: 0.9 }), "explorer");
  assert.deepEqual(c.evidence, ["a", "b"]);
  assert.equal(c.confidence, 0.9);
});

test("contracts: validateVerdict accepts accept/reject/demote/block", () => {
  for (const decision of ["accept", "reject", "demote", "block"] as const) {
    const v = validateVerdict(env("verdict", { decision, reason: "r" }), "evaluator");
    assert.equal(v.decision, decision);
  }
});

test("contracts: validateVerdict parses blocked prerequisites", () => {
  const v = validateVerdict(env("verdict", {
    decision: "block", reason: "needs precondition", requiredConditions: ["login", "token"],
  }), "evaluator");
  assert.equal(v.decision, "block");
  assert.deepEqual(v.requiredConditions, ["login", "token"]);
});

test("contracts: validateVerdict throws on invalid decision", () => {
  assert.throws(() => validateVerdict(env("verdict", { decision: "maybe", reason: "r" }), "evaluator"));
});

test("contracts: validateChain parses subIntents and waitMode", () => {
  const c = validateChain(env("chain", {
    reason: "need more", subIntents: [{ description: "sub" }], waitMode: "any",
  }), "explorer");
  assert.equal(c.reason, "need more");
  assert.equal(c.subIntents.length, 1);
  assert.equal(c.waitMode, "any");
});

test("contracts: validateChain defaults waitMode to all", () => {
  const c = validateChain(env("chain", {
    reason: "x", subIntents: [{ description: "y" }], waitMode: "bogus",
  }), "explorer");
  assert.equal(c.waitMode, "all");
});

test("contracts: validateHints maps creator", () => {
  const { hints } = validateHints(env("hints", { hints: [{ content: "go left" }] }), "metacog", "metacog");
  assert.equal(hints.length, 1);
  assert.equal(hints[0].content, "go left");
  assert.equal(hints[0].creator, "metacog");
});

test("contracts: validateStop extracts reason", () => {
  const { reason } = validateStop(env("stop", { reason: "goal met" }), "metacog");
  assert.equal(reason, "goal met");
});

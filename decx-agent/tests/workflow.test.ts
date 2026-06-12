import { test } from "node:test";
import { strict as assert } from "node:assert";
import { matchesWorkflowRule } from "../src/dispatcher/workflow.ts";
import { makeFact, makeIntent, makeEvent } from "./helper.ts";
import type { WorkflowRule, WorkflowEvent, Fact, Intent } from "../src/core/types.ts";

function makeRule(when: WorkflowRule["when"], id = "rule-1"): WorkflowRule {
  return {
    id,
    when,
    then: [],
  };
}

test("empty when matches any event (sanity baseline)", () => {
  const rule = makeRule({});
  const event = makeEvent({ type: "anything", severity: "info" });
  assert.equal(matchesWorkflowRule(rule, event), true);
});

test("eventType matches when event.type equals condition.eventType; otherwise rejects", () => {
  const rule = makeRule({ eventType: "foo" });
  const matched = makeEvent({ type: "foo" });
  const rejected = makeEvent({ type: "bar" });
  assert.equal(matchesWorkflowRule(rule, matched), true);
  assert.equal(matchesWorkflowRule(rule, rejected), false);
});

test("minSeverity threshold: matches at or above, rejects below", () => {
  const rule = makeRule({ minSeverity: "high" });
  const high = makeEvent({ type: "x", severity: "high" });
  const critical = makeEvent({ type: "x", severity: "critical" });
  const low = makeEvent({ type: "x", severity: "low" });
  const info = makeEvent({ type: "x", severity: "info" });
  assert.equal(matchesWorkflowRule(rule, high), true);
  assert.equal(matchesWorkflowRule(rule, critical), true);
  assert.equal(matchesWorkflowRule(rule, low), false);
  assert.equal(matchesWorkflowRule(rule, info), false);
});

test("minSeverity defaults to info when event has no severity", () => {
  const rule = makeRule({ minSeverity: "info" });
  // helper's makeEvent omits severity; default to "info" inside matchesWorkflowRule
  const event = makeEvent({ type: "x" });
  assert.equal(matchesWorkflowRule(rule, event), true);

  const rule2 = makeRule({ minSeverity: "low" });
  assert.equal(matchesWorkflowRule(rule2, event), false);
});

test("hasFact matches by exact fact id in context", () => {
  const rule = makeRule({ hasFact: "f001" });
  const event = makeEvent({ type: "x" });
  const fact: Fact = makeFact({ id: "f001", description: "irrelevant" });
  const context = { facts: [fact], intents: [] };
  assert.equal(matchesWorkflowRule(rule, event, context), true);

  const emptyContext = { facts: [], intents: [] };
  assert.equal(matchesWorkflowRule(rule, event, emptyContext), false);
});

test("hasFact matches by substring in fact description", () => {
  const rule = makeRule({ hasFact: "describe" });
  const event = makeEvent({ type: "x" });
  const fact: Fact = makeFact({ id: "f999", description: "please describe the surface area" });
  const context = { facts: [fact], intents: [] };
  assert.equal(matchesWorkflowRule(rule, event, context), true);

  const noMatch: Fact = makeFact({ id: "f998", description: "totally unrelated" });
  assert.equal(matchesWorkflowRule(rule, event, { facts: [noMatch], intents: [] }), false);
});

test("intentStatus matches only when the event's intent has the configured status", () => {
  const rule = makeRule({ intentStatus: "done" });
  const intentDone: Intent = makeIntent({ status: "done" });
  const intentOpen: Intent = makeIntent({ status: "open" });

  const eventForDone: WorkflowEvent = makeEvent({ type: "x", intentId: intentDone.id });
  const eventForOpen: WorkflowEvent = makeEvent({ type: "x", intentId: intentOpen.id });
  const eventNoIntent: WorkflowEvent = makeEvent({ type: "x" });

  const context = { facts: [], intents: [intentDone, intentOpen] };
  assert.equal(matchesWorkflowRule(rule, eventForDone, context), true);
  assert.equal(matchesWorkflowRule(rule, eventForOpen, context), false);
  // No intentId on event means no intent found => rejected
  assert.equal(matchesWorkflowRule(rule, eventNoIntent, context), false);
});

test("equals matches only when the named event field equals the configured value", () => {
  const rule = makeRule({ equals: { source: "x" } });
  const matched: WorkflowEvent = makeEvent({ type: "y", source: "x" });
  const rejected: WorkflowEvent = makeEvent({ type: "y", source: "z" });
  assert.equal(matchesWorkflowRule(rule, matched), true);
  assert.equal(matchesWorkflowRule(rule, rejected), false);
});

test("includes matches when the named event field contains the configured substring", () => {
  const rule = makeRule({ includes: { type: "oo" } });
  const matched: WorkflowEvent = makeEvent({ type: "foobar" });
  const rejected: WorkflowEvent = makeEvent({ type: "xyz" });
  assert.equal(matchesWorkflowRule(rule, matched), true);
  assert.equal(matchesWorkflowRule(rule, rejected), false);
});

test("matches matches when the named event field matches the configured regex", () => {
  const rule = makeRule({ matches: { type: "^foo[0-9]+$" } });
  const matched1: WorkflowEvent = makeEvent({ type: "foo123" });
  const matched2: WorkflowEvent = makeEvent({ type: "foo9" });
  const rejected1: WorkflowEvent = makeEvent({ type: "foo" });
  const rejected2: WorkflowEvent = makeEvent({ type: "bar123" });
  assert.equal(matchesWorkflowRule(rule, matched1), true);
  assert.equal(matchesWorkflowRule(rule, matched2), true);
  assert.equal(matchesWorkflowRule(rule, rejected1), false);
  assert.equal(matchesWorkflowRule(rule, rejected2), false);
});

test("multiple conditions are ANDed: all must hold", () => {
  const rule = makeRule({
    eventType: "foo",
    minSeverity: "high",
    equals: { source: "tester" },
  });

  // All three satisfied
  const ok: WorkflowEvent = makeEvent({ type: "foo", severity: "critical", source: "tester" });
  assert.equal(matchesWorkflowRule(rule, ok), true);

  // Type satisfied but severity too low
  const lowSev: WorkflowEvent = makeEvent({ type: "foo", severity: "info", source: "tester" });
  assert.equal(matchesWorkflowRule(rule, lowSev), false);

  // Type satisfied but source differs
  const badSrc: WorkflowEvent = makeEvent({ type: "foo", severity: "critical", source: "other" });
  assert.equal(matchesWorkflowRule(rule, badSrc), false);
});

test("equals on data.* falls back to event.data lookup (string values only)", () => {
  // eventValue returns the event.data[key] when event[key] is not a string.
  // For "kind" — not a top-level field on WorkflowEvent — it falls through to data.
  const rule = makeRule({ equals: { kind: "alpha" } });
  const matched: WorkflowEvent = makeEvent({ type: "x", data: { kind: "alpha" } });
  const rejected: WorkflowEvent = makeEvent({ type: "x", data: { kind: "beta" } });
  assert.equal(matchesWorkflowRule(rule, matched), true);
  assert.equal(matchesWorkflowRule(rule, rejected), false);
});

test("includes on data.* substring-matches a string in event.data", () => {
  const rule = makeRule({ includes: { kind: "lp" } });
  const matched: WorkflowEvent = makeEvent({ type: "x", data: { kind: "alpha" } });
  const rejected: WorkflowEvent = makeEvent({ type: "x", data: { kind: "beta" } });
  assert.equal(matchesWorkflowRule(rule, matched), true);
  assert.equal(matchesWorkflowRule(rule, rejected), false);
});

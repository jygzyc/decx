/**
 * Characterization tests for parseWorkerPayload in src/core/protocol.ts.
 *
 * These tests describe the EXISTING behavior of the parser. They are not
 * aspirational — if a case in the spec is wrong about what throws, the test
 * is adjusted to match the code so the suite remains green and useful as a
 * regression guard.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
// Import from compiled dist/ output because src/ uses NodeNext .js imports
// which Node's --experimental-strip-types cannot resolve at runtime.
// Build (tsc) must have been run before this test executes.
import { parseWorkerPayload } from "../dist/core/protocol.js";

/* ------------------------------------------------------------------ *
 * Happy path — one test per WorkerPayload.kind the parser can emit.   *
 * ------------------------------------------------------------------ */

test("parseWorkerPayload returns fact for explore phase with fact data", () => {
  const result = parseWorkerPayload(
    "explore",
    '{"accepted":true,"data":{"fact":{"description":"hello","evidence":["e1"]}}}',
  );
  assert.equal(result.kind, "fact");
  assert.equal(result.description, "hello");
  assert.deepEqual(result.evidence, ["e1"]);
  assert.deepEqual(result.events, []);
});

test("parseWorkerPayload returns intents for reason phase with intent array", () => {
  const result = parseWorkerPayload(
    "reason",
    '{"accepted":true,"data":{"intents":[{"from":["f001"],"description":"next","role":"explorer"}]}}',
  );
  assert.equal(result.kind, "intents");
  assert.deepEqual(result.intents, [
    { from: ["f001"], description: "next", role: "explorer" },
  ]);
});

test("parseWorkerPayload returns complete for reason phase with complete data", () => {
  const result = parseWorkerPayload(
    "reason",
    '{"accepted":true,"data":{"complete":{"from":["f001"],"description":"done"}}}',
  );
  assert.equal(result.kind, "complete");
  assert.deepEqual(result.from, ["f001"]);
  assert.equal(result.description, "done");
});

test("parseWorkerPayload returns review for review phase with review data", () => {
  const result = parseWorkerPayload(
    "review",
    '{"accepted":true,"data":{"review":{"summary":"s","severity":"low"}}}',
  );
  assert.equal(result.kind, "review");
  assert.equal(result.summary, "s");
  assert.equal(result.severity, "low");
  assert.deepEqual(result.events, []);
});

test("parseWorkerPayload returns rejected when accepted is false", () => {
  const result = parseWorkerPayload("explore", '{"accepted":false,"reason":"too dangerous"}');
  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, "too dangerous");
});

test("parseWorkerPayload returns events when only events are present", () => {
  const result = parseWorkerPayload(
    "explore",
    '{"accepted":true,"data":{"events":[{"type":"e1"}]}}',
  );
  assert.equal(result.kind, "events");
  // eventArray normalizes all WorkflowEvent fields, so unset fields appear as undefined
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "e1");
});

test("parseWorkerPayload returns noop for reason phase with empty data", () => {
  // Spec note: the actual kind emitted by the code is "noop", not "empty".
  // This is a characterization test of the existing behavior.
  const result = parseWorkerPayload("reason", '{"accepted":true,"data":{}}');
  assert.equal(result.kind, "noop");
  assert.deepEqual(result.events, []);
});

test("parseWorkerPayload throws for explore phase with empty data", () => {
  assert.throws(
    () => parseWorkerPayload("explore", '{"accepted":true,"data":{}}'),
    /fact data/,
  );
});

/* ------------------------------------------------------------------ *
 * Error cases — JSON parse failures, missing fields, wrong shapes.   *
 * ------------------------------------------------------------------ */

test("parseWorkerPayload throws on non-JSON input", () => {
  assert.throws(
    () => parseWorkerPayload("explore", "not json at all"),
    /JSON/,
  );
});

test("parseWorkerPayload throws on empty JSON object with no usable data", () => {
  assert.throws(() => parseWorkerPayload("explore", "{}"), /fact data/);
});

test("parseWorkerPayload throws when intent is missing required description field", () => {
  // The spec example ("description":"missing from") does NOT throw because
  // description is present and non-empty. The closest equivalent that does
  // throw is an intent that omits description entirely.
  assert.throws(
    () =>
      parseWorkerPayload(
        "explore",
        '{"data":{"intents":[{"from":["f001"]}]}}',
      ),
    /intent 0\.description must be a non-empty string/,
  );
});

test("parseWorkerPayload throws when intent is not an object", () => {
  assert.throws(
    () => parseWorkerPayload("explore", '{"data":{"intents":["not an object"]}}'),
    /intent 0 must be an object/,
  );
});

test("parseWorkerPayload throws when top-level value is an array", () => {
  assert.throws(() => parseWorkerPayload("explore", "[]"), /JSON/);
});

test("parseWorkerPayload throws when fact is missing description", () => {
  assert.throws(
    () => parseWorkerPayload("explore", '{"data":{"fact":{}}}'),
    /fact\.description must be a non-empty string/,
  );
});

test("parseWorkerPayload throws when complete is missing description", () => {
  assert.throws(
    () => parseWorkerPayload("reason", '{"data":{"complete":{"from":["f1"]}}}'),
    /complete\.description must be a non-empty string/,
  );
});

test("parseWorkerPayload throws when review is missing summary", () => {
  assert.throws(
    () => parseWorkerPayload("review", '{"data":{"review":{}}}'),
    /review\.summary must be a non-empty string/,
  );
});

test("parseWorkerPayload falls back to default reason when rejection omits it", () => {
  const result = parseWorkerPayload("explore", '{"accepted":false}');
  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, "worker rejected task");
});

/* ------------------------------------------------------------------ *
 * Text-wrapped JSON — extractJson finds JSON embedded in prose.      *
 * ------------------------------------------------------------------ */

test("parseWorkerPayload extracts JSON embedded in surrounding prose", () => {
  const result = parseWorkerPayload(
    "explore",
    'Some preamble\n{"accepted":true,"data":{"fact":{"description":"x","evidence":[]}}}\nFooter text',
  );
  assert.equal(result.kind, "fact");
  assert.equal(result.description, "x");
});

test("parseWorkerPayload extracts JSON from inside a ```json code fence", () => {
  const result = parseWorkerPayload(
    "explore",
    '```json\n{"accepted":true,"data":{"fact":{"description":"x","evidence":[]}}}\n```',
  );
  assert.equal(result.kind, "fact");
  assert.equal(result.description, "x");
});

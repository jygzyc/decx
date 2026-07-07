import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseEnvelope } from "../dist/agent/parse-envelope.js";

test("parseEnvelope: clean JSON", () => {
  const result = parseEnvelope('{"kind":"fact","data":{"description":"x"}}', "test");
  assert.equal(result.kind, "fact");
});

test("parseEnvelope: JSON wrapped in markdown fence", () => {
  const text = 'Here is my response:\n\n```json\n{"kind":"fact","data":{"description":"x"}}\n```\n\nDone.';
  const result = parseEnvelope(text, "test");
  assert.equal(result.kind, "fact");
});

test("parseEnvelope: JSON after prose with no fence", () => {
  const text = 'I will create intents now.\n\n{"kind":"decisions","data":{"createIntents":[]}}';
  const result = parseEnvelope(text, "test");
  assert.equal(result.kind, "decisions");
});

test("parseEnvelope: JSON with nested braces in values", () => {
  const text = '```json\n{"kind":"verdict","data":{"reason":"because {x} is wrong"}}\n```';
  const result = parseEnvelope(text, "test");
  assert.equal(result.kind, "verdict");
  assert.equal(result.data.reason, "because {x} is wrong");
});

test("parseEnvelope: throws on non-JSON prose", () => {
  assert.throws(() => parseEnvelope("just some text, no json here", "test"), /no JSON/);
});

test("parseEnvelope: throws on empty", () => {
  assert.throws(() => parseEnvelope("", "test"), /empty/);
});

test("parseEnvelope: picks JSON with kind field from multiple braces", () => {
  const text = 'Some code: { if (x) { return; } }\n\n{"kind":"fact","data":{"description":"found"}}';
  const result = parseEnvelope(text, "test");
  assert.equal(result.kind, "fact");
});

test("parseEnvelope: handles JSON with newlines and whitespace", () => {
  const text = '```json\n{\n  "kind": "hints",\n  "data": {\n    "hints": []\n  }\n}\n```';
  const result = parseEnvelope(text, "test");
  assert.equal(result.kind, "hints");
});

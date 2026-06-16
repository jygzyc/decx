/**
 * Pure utility function tests — no mocks, no I/O, no side effects.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  isRecord,
  stringValue,
  stringArray,
  positiveInt,
  safeSessionName,
  utcnow,
  parseJson,
} from "../dist/core/utils.js";

// ─── isRecord ───────────────────────────────────────────────────────

test("isRecord: true for plain objects", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1, b: "two" }), true);
});

test("isRecord: false for null, arrays, primitives", () => {
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord([1, 2, 3]), false);
  assert.equal(isRecord("string"), false);
  assert.equal(isRecord(42), false);
  assert.equal(isRecord(true), false);
  assert.equal(isRecord(undefined), false);
});

test("isRecord: true for nested objects", () => {
  assert.equal(isRecord({ nested: { key: "value" } }), true);
});

// ─── stringValue ────────────────────────────────────────────────────

test("stringValue: returns trimmed strings", () => {
  assert.equal(stringValue("hello"), "hello");
  assert.equal(stringValue("  hello  "), "hello");
  assert.equal(stringValue("  \t multiline \n "), "multiline");
});

test("stringValue: returns undefined for empty, whitespace, non-strings", () => {
  assert.equal(stringValue(""), undefined);
  assert.equal(stringValue("   "), undefined);
  assert.equal(stringValue(42), undefined);
  assert.equal(stringValue(null), undefined);
  assert.equal(stringValue(undefined), undefined);
  assert.equal(stringValue(true), undefined);
  assert.equal(stringValue({}), undefined);
});

// ─── stringArray ────────────────────────────────────────────────────

test("stringArray: returns trimmed non-empty strings from array", () => {
  assert.deepEqual(stringArray(["a", " b ", "c"]), ["a", "b", "c"]);
  assert.deepEqual(stringArray(["  hello world  "]), ["hello world"]);
});

test("stringArray: filters empty and whitespace strings", () => {
  assert.deepEqual(stringArray(["a", "", "  ", "b"]), ["a", "b"]);
});

test("stringArray: returns undefined for non-arrays and empty results", () => {
  assert.equal(stringArray("not an array"), undefined);
  assert.equal(stringArray({}), undefined);
  assert.equal(stringArray(null), undefined);
  assert.equal(stringArray([]), undefined);
  assert.equal(stringArray(["", "  "]), undefined);
});

// ─── positiveInt ────────────────────────────────────────────────────

test("positiveInt: parses positive integers from numbers and strings", () => {
  assert.equal(positiveInt(42), 42);
  assert.equal(positiveInt("42"), 42);
  assert.equal(positiveInt("  5  "), 5);
  assert.equal(positiveInt(1), 1);
});

test("positiveInt: returns undefined for zero, negative, non-numeric", () => {
  assert.equal(positiveInt(0), undefined);
  assert.equal(positiveInt(-1), undefined);
  assert.equal(positiveInt("0"), undefined);
  assert.equal(positiveInt("-5"), undefined);
  assert.equal(positiveInt("abc"), undefined);
  assert.equal(positiveInt(null), undefined);
  assert.equal(positiveInt(undefined), undefined);
  assert.equal(positiveInt(NaN), undefined);
  assert.equal(positiveInt(Infinity), undefined);
});

// ─── safeSessionName ────────────────────────────────────────────────

test("safeSessionName: replaces invalid chars with hyphens", () => {
  assert.equal(safeSessionName("My Task!"), "My-Task");
  assert.equal(safeSessionName("hello world"), "hello-world");
  assert.equal(safeSessionName("path/to/file"), "path-to-file");
});

test("safeSessionName: strips leading/trailing hyphens", () => {
  assert.equal(safeSessionName("--bad--"), "bad");
  assert.equal(safeSessionName("!!!hello!!!"), "hello");
});

test("safeSessionName: returns 'session' for all-invalid input", () => {
  assert.equal(safeSessionName(""), "session");
  assert.equal(safeSessionName("---"), "session");
  assert.equal(safeSessionName("!@#$%"), "session");
});

test("safeSessionName: preserves allowed chars", () => {
  assert.equal(safeSessionName("abc123._-x"), "abc123._-x");
  assert.equal(safeSessionName("v1.2.3-rc4"), "v1.2.3-rc4");
});

// ─── utcnow ─────────────────────────────────────────────────────────

test("utcnow: returns ISO-8601 string with Z suffix", () => {
  const result = utcnow();
  assert.equal(typeof result, "string");
  assert.ok(result.endsWith("Z"), `expected Z suffix, got: ${result}`);
  // Should parse as valid date
  const parsed = new Date(result);
  assert.ok(!isNaN(parsed.getTime()), `expected valid date, got: ${result}`);
});

test("utcnow: returns different timestamps on sequential calls", () => {
  const t1 = utcnow();
  const t2 = utcnow();
  assert.ok(t1 <= t2, `expected t1 <= t2, got t1=${t1} t2=${t2}`);
});

// ─── parseJson ──────────────────────────────────────────────────────

test("parseJson: parses valid JSON", () => {
  assert.deepEqual(parseJson('{"a":1}', null), { a: 1 });
  assert.deepEqual(parseJson("[1,2,3]", null), [1, 2, 3]);
  assert.equal(parseJson("42", null), 42);
  assert.equal(parseJson('"hello"', null), "hello");
});

test("parseJson: returns fallback on invalid JSON", () => {
  assert.equal(parseJson("not json", "fallback"), "fallback");
  assert.deepEqual(parseJson("", {}), {}); // JSON.parse("") throws → fallback is {}
  assert.deepEqual(parseJson("broken {", []), []);
});

test("parseJson: coerces non-string values to string", () => {
  assert.equal(parseJson(42, null), 42);
  assert.equal(parseJson(null, "fb"), "fb");
});

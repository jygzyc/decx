import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  isRecord, stringValue, stringArray, positiveInt, safeSessionName, utcnow, parseJson,
} from "../dist/config/utils.js";

test("isRecord: plain object returns true", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
});

test("isRecord: null, array, primitives return false", () => {
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(42), false);
  assert.equal(isRecord("str"), false);
  assert.equal(isRecord(undefined), false);
});

test("stringValue: non-empty trimmed string returns trimmed", () => {
  assert.equal(stringValue("  hello  "), "hello");
  assert.equal(stringValue("world"), "world");
});

test("stringValue: empty/whitespace/non-string returns undefined", () => {
  assert.equal(stringValue(""), undefined);
  assert.equal(stringValue("   "), undefined);
  assert.equal(stringValue(42), undefined);
  assert.equal(stringValue(null), undefined);
});

test("stringArray: array of strings returns trimmed non-empty", () => {
  assert.deepEqual(stringArray(["  a ", "b", ""]), ["a", "b"]);
});

test("stringArray: empty result returns undefined", () => {
  assert.equal(stringArray([]), undefined);
  assert.equal(stringArray(["", "  "]), undefined);
});

test("stringArray: non-array returns undefined", () => {
  assert.equal(stringArray("not array"), undefined);
  assert.equal(stringArray(null), undefined);
});

test("positiveInt: positive number returns it", () => {
  assert.equal(positiveInt(5), 5);
  assert.equal(positiveInt(1), 1);
});

test("positiveInt: numeric string parses", () => {
  assert.equal(positiveInt("10"), 10);
  assert.equal(positiveInt("1"), 1);
});

test("positiveInt: zero, negative, invalid return undefined", () => {
  assert.equal(positiveInt(0), undefined);
  assert.equal(positiveInt(-5), undefined);
  assert.equal(positiveInt("abc"), undefined);
  assert.equal(positiveInt(null), undefined);
});

test("safeSessionName: sanitizes special chars", () => {
  assert.equal(safeSessionName("hello world!@#"), "hello-world");
  assert.equal(safeSessionName("clean_name-123"), "clean_name-123");
});

test("safeSessionName: empty/all-special returns 'session'", () => {
  assert.equal(safeSessionName("@#$%"), "session");
  assert.equal(safeSessionName(""), "session");
});

test("utcnow: returns ISO-8601 string", () => {
  const ts = utcnow();
  assert.equal(typeof ts, "string");
  assert.ok(!Number.isNaN(Date.parse(ts)));
});

test("parseJson: valid JSON returns parsed value", () => {
  assert.deepEqual(parseJson('{"a":1}', null), { a: 1 });
  assert.deepEqual(parseJson("[1,2,3]", null), [1, 2, 3]);
});

test("parseJson: invalid JSON returns fallback", () => {
  assert.equal(parseJson("not json", "fallback"), "fallback");
  assert.equal(parseJson(null, 42), 42);
  assert.equal(parseJson(undefined, "def"), "def");
});

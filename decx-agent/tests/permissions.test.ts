import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PermissionChecker, PermissionDeniedError } from "../dist/agent/permissions.js";
import type { SubagentProfile } from "../dist/agent/types.js";

function profile(permissions: string[]): SubagentProfile {
  return { role: "test", runtime: { worker: "mock" }, permissions: permissions as never };
}

test("PermissionChecker: has returns true for granted permissions", () => {
  const checker = new PermissionChecker(profile(["create_intent", "write_hint"]));
  assert.equal(checker.has("create_intent"), true);
  assert.equal(checker.has("write_hint"), true);
});

test("PermissionChecker: has returns false for missing permissions", () => {
  const checker = new PermissionChecker(profile(["create_intent"]));
  assert.equal(checker.has("resolve_fact"), false);
});

test("PermissionChecker: require throws PermissionDeniedError when missing", () => {
  const checker = new PermissionChecker(profile(["create_intent"]));
  assert.throws(
    () => checker.require("resolve_fact"),
    (err: unknown) => err instanceof PermissionDeniedError && err.permission === "resolve_fact",
  );
});

test("PermissionChecker: require passes silently when granted", () => {
  const checker = new PermissionChecker(profile(["create_intent"]));
  assert.doesNotThrow(() => checker.require("create_intent"));
});

test("PermissionChecker: requireAny passes if any permission is granted", () => {
  const checker = new PermissionChecker(profile(["write_candidate_fact"]));
  assert.doesNotThrow(() => checker.requireAny("resolve_fact", "write_candidate_fact"));
  assert.throws(() => checker.requireAny("resolve_fact", "conclude_run"));
});

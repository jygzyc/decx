import { test } from "node:test";
import { strict as assert } from "node:assert";
import { WorkerSessionManager } from "../dist/worker/session-manager.js";

test("WorkerSessionManager: acquire creates new session on first call", () => {
  const mgr = new WorkerSessionManager();
  const session = mgr.acquire("p1", "planner", () => "sess-001");
  assert.equal(session.sessionId, "sess-001");
  assert.equal(session.callCount, 1);
});

test("WorkerSessionManager: acquire reuses existing session", () => {
  const mgr = new WorkerSessionManager();
  let factoryCalls = 0;
  const s1 = mgr.acquire("p1", "planner", () => { factoryCalls++; return `sess-${factoryCalls}`; });
  const s2 = mgr.acquire("p1", "planner", () => { factoryCalls++; return `sess-${factoryCalls}`; });
  assert.equal(s1.sessionId, s2.sessionId);
  assert.equal(factoryCalls, 1);
  assert.equal(s2.callCount, 2);
});

test("WorkerSessionManager: separate profiles get separate sessions", () => {
  const mgr = new WorkerSessionManager();
  let n = 0;
  const factory = () => `sess-${++n}`;
  const s1 = mgr.acquire("p1", "planner", factory);
  const s2 = mgr.acquire("p1", "explorer", factory);
  assert.notEqual(s1.sessionId, s2.sessionId);
});

test("WorkerSessionManager: rotate replaces session", () => {
  const mgr = new WorkerSessionManager();
  const s1 = mgr.acquire("p1", "planner", () => "old-session");
  const s2 = mgr.rotate("p1", "planner", () => "new-session");
  assert.notEqual(s1.sessionId, s2.sessionId);
  assert.equal(s2.sessionId, "new-session");
  assert.equal(s2.callCount, 0);
});

test("WorkerSessionManager: release removes session", () => {
  const mgr = new WorkerSessionManager();
  mgr.acquire("p1", "planner", () => "sess-001");
  mgr.release("p1", "planner");
  assert.equal(mgr.get("p1", "planner"), undefined);
});

test("WorkerSessionManager: releaseProject removes all sessions for project", () => {
  const mgr = new WorkerSessionManager();
  mgr.acquire("p1", "planner", () => "s1");
  mgr.acquire("p1", "explorer", () => "s2");
  mgr.acquire("p2", "planner", () => "s3");
  mgr.releaseProject("p1");
  assert.equal(mgr.get("p1", "planner"), undefined);
  assert.equal(mgr.get("p1", "explorer"), undefined);
  assert.ok(mgr.get("p2", "planner"));
});

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ProjectLockManager } from "../dist/session/project-lock.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("project-lock: serializes concurrent acquires on same project", async () => {
  const lock = new ProjectLockManager();
  const log: string[] = [];

  await Promise.all([
    lock.acquire("proj-1", async () => {
      log.push("A-start");
      await sleep(20);
      log.push("A-end");
    }),
    lock.acquire("proj-1", async () => {
      log.push("B-start");
      await sleep(5);
      log.push("B-end");
    }),
  ]);

  const aStart = log.indexOf("A-start");
  const aEnd = log.indexOf("A-end");
  const bStart = log.indexOf("B-start");
  assert.ok(aEnd < bStart, "B must start after A ends");
});

test("project-lock: different projects run concurrently", async () => {
  const lock = new ProjectLockManager();
  const log: string[] = [];
  let releaseA: () => void = () => {};
  const held = new Promise<void>((r) => { releaseA = r; });

  const pA = lock.acquire("proj-A", async () => {
    log.push("A-start");
    await held;
    log.push("A-end");
  });
  const pB = lock.acquire("proj-B", async () => {
    log.push("B-start");
    log.push("B-end");
  });

  await sleep(10);
  releaseA();
  await Promise.all([pA, pB]);

  const bStart = log.indexOf("B-start");
  const aEnd = log.indexOf("A-end");
  assert.ok(bStart >= 0, "B should have started");
  assert.ok(aEnd > bStart, "A should end after B started (concurrent)");
});

test("project-lock: returns the fn result", async () => {
  const lock = new ProjectLockManager();
  const result = await lock.acquire("p1", async () => 42);
  assert.equal(result, 42);
});

test("project-lock: releases lock after fn throws", async () => {
  const lock = new ProjectLockManager();

  await lock.acquire("p1", async () => { throw new Error("boom"); }).catch(() => {});

  let ran = false;
  await lock.acquire("p1", async () => { ran = true; });
  assert.ok(ran);
});

test("project-lock: cleans up chain map after all acquirers done", async () => {
  const lock = new ProjectLockManager();
  await lock.acquire("p1", async () => {});
  assert.equal(lock.pendingCount("p1"), 0);
});

test("project-lock: high concurrency — 5 tasks serialize on same project", async () => {
  const lock = new ProjectLockManager();
  let activeCount = 0;
  let maxConcurrent = 0;

  const tasks = Array.from({ length: 5 }, (_, i) =>
    lock.acquire("p1", async () => {
      activeCount += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCount);
      await sleep(5);
      activeCount -= 1;
      return i;
    }),
  );

  const results = await Promise.all(tasks);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
});

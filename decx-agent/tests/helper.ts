import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openAgentDb } from "../src/server/db.ts";
import type { Fact, Intent, Link, WorkflowEvent } from "../src/core/types.ts";

export interface TestDb {
  db: DatabaseSync;
  cleanup: () => void;
}

export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "decx-agent-test-"));
  const db = openAgentDb(join(dir, "agent.sqlite"));
  return {
    db,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: nextId("fact"),
    description: "test fact",
    evidence: [],
    source: "test",
    confidence: 1.0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: nextId("intent"),
    fromFacts: [],
    description: "test intent",
    creator: "tester",
    status: "open",
    priority: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeLink(overrides: Partial<Link> = {}): Link {
  return {
    id: nextId("link"),
    projectId: "proj_test",
    fromFactId: "f001",
    toFactId: "f002",
    kind: "related",
    evidence: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build an in-memory WorkflowEvent for workflow rule matcher tests.
 * These are NOT persisted — they exist only as in-memory protocol objects.
 */
export function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    id: nextId("event"),
    type: "test.event",
    worker: "noop",
    phase: "explore",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

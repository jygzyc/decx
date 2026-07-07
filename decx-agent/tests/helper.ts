import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskConfig, WorkerConfig, SubagentProfile } from "../dist/agent/types.js";
import { BUILTIN_PERMISSIONS } from "../dist/agent/types.js";
import { InMemoryGraph } from "../dist/graph/in-memory-graph.js";
import { MockWorker } from "../dist/worker/mock-worker.js";
import type { Graph } from "../dist/graph/graph.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(TEST_DIR, "..", "src", "agent", "prompts");
const TEMP_DIRS: string[] = [];
let sessionCounter = 0;

function builtinProfile(role: string, promptFile: string, contract: string, graphView: string): SubagentProfile {
  return {
    role,
    runtime: { worker: "mock" },
    prompt: { file: join(PROMPTS_DIR, promptFile) },
    context: { graphView: graphView as never },
    permissions: BUILTIN_PERMISSIONS[role] ?? [],
    output: { contract: contract as never },
  };
}

export function minimalConfig(workerName = "mock"): TaskConfig {
  const workers: Record<string, WorkerConfig> = { [workerName]: { kind: "mock" } };
  return {
    task: { target: "test-target", goal: "test-goal" },
    profiles: {
      planner: builtinProfile("planner", "planner.md", "main_decision", "full"),
      explorer: builtinProfile("explorer", "explorer.md", "candidate_fact", "focused"),
      evaluator: builtinProfile("evaluator", "evaluator.md", "verdict", "evidence-only"),
      metacog: builtinProfile("metacog", "metacog.md", "hints", "summary"),
    },
    workers,
    workflow: { limits: { maxSteps: 30, maxConcurrent: 2, refillPerTick: 1, maxStagnation: 10 } },
    control: { mainProfile: "planner", metacogProfile: "metacog" },
  };
}

export function freshSetup(workerName = "mock") {
  return { graph: new InMemoryGraph(), worker: new MockWorker(), config: minimalConfig(workerName) };
}

export function createProject(graph: Graph, overrides: Partial<{ target: string; goal: string; session: string }> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "decx-"));
  TEMP_DIRS.push(dir);
  return graph.createProject({
    session: overrides.session ?? `s-${sessionCounter++}`,
    name: "test",
    target: overrides.target ?? "test-target",
    goal: overrides.goal ?? "test-goal",
    worker: "mock",
    sessionDir: dir,
    configPath: "/tmp/task.json",
    taskConfig: minimalConfig(),
  });
}

export function env(kind: string, data: unknown): string {
  return JSON.stringify({ kind, data });
}

export function cleanupTempDirs(): void {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

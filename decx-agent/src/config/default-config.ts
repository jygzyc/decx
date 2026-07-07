/**
 * Default task configuration for decx-agent.
 *
 * Provides a minimal runnable setup when task.json omits profile, worker, or
 * workflow fields. Defaults avoid encoding domain-specific vulnerability-
 * hunting policy; role prompts are kept minimal so that task.json can override
 * them via `profiles.<id>.prompt.file`.
 */

import type { TaskConfig, SubagentProfile, GraphView, OutputContract } from "../agent/types.js";
import { BUILTIN_ROLES, BUILTIN_PERMISSIONS } from "../agent/types.js";

function builtinProfile(
  role: string,
  promptFile: string,
  graphView: GraphView,
  contract: OutputContract,
): SubagentProfile {
  return {
    role,
    runtime: { worker: "opencode" },
    prompt: { file: promptFile },
    context: { graphView },
    permissions: BUILTIN_PERMISSIONS[role] ?? [],
    output: { contract },
  };
}

export function defaultConfig(): TaskConfig {
  return {
    task: { target: "", goal: "" },
    profiles: {
      planner: builtinProfile(BUILTIN_ROLES.planner, "agent/prompts/planner.md", "full", "main_decision"),
      explorer: builtinProfile(BUILTIN_ROLES.explorer, "agent/prompts/explorer.md", "focused", "candidate_fact"),
      evaluator: builtinProfile(BUILTIN_ROLES.evaluator, "agent/prompts/evaluator.md", "evidence-only", "verdict"),
      metacog: builtinProfile(BUILTIN_ROLES.metacog, "agent/prompts/metacog.md", "summary", "hints"),
    },
    workers: {
      opencode: { kind: "agent", backend: "opencode" },
    },
    workflow: {
      limits: { maxSteps: 1000, maxConcurrent: 3, refillPerTick: 1, maxStagnation: 8 },
      metacog: { triggers: { everySteps: 5, everySeconds: 30, stagnationLevel: 3 } },
    },
    control: {
      mainProfile: "planner",
      metacogProfile: "metacog",
      metacogIntervalSeconds: 30,
    },
  };
}

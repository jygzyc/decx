/**
 * Decision applier — translates a MainDecision into graph mutations.
 *
 * All mutations are wrapped in a single graph transaction for atomicity. If
 * any permission check fails mid-way, the transaction rolls back and no
 * partial mutations are persisted.
 *
 * The applier does NOT call workers; it only mutates the graph.
 */

import type { ProjectId, TaskConfig, Verdict } from "./types.js";
import type { Graph } from "../graph/graph.js";
import type { MainDecision } from "./contracts.js";
import { PermissionChecker } from "./permissions.js";

export interface DecisionApplierResult {
  intentsCreated: number;
  intentsFailed: number;
  hintsConsumed: number;
  concluded: boolean;
}

export interface ApplyDecisionContext {
  projectId: ProjectId;
  graph: Graph;
  config: TaskConfig;
  decision: MainDecision;
  hintIdsToConsume?: string[];
  permissions: PermissionChecker;
}

export function applyMainDecision(ctx: ApplyDecisionContext): DecisionApplierResult {
  const { projectId, graph, decision, permissions } = ctx;
  const result: DecisionApplierResult = {
    intentsCreated: 0,
    intentsFailed: 0,
    hintsConsumed: 0,
    concluded: false,
  };

  return graph.transaction(() => {
    for (const spec of decision.createIntents) {
      permissions.require("create_intent");
      if (graph.isDeadEnd(projectId, spec.description)) {
        graph.logEvent(projectId, "planner.dead_end_skipped", { description: spec.description });
        continue;
      }
      graph.addIntent(projectId, {
        description: spec.description,
        creator: "planner",
        parentFactIds: spec.parentFactIds,
        priority: spec.priority,
      });
      result.intentsCreated += 1;
    }

    for (const fail of decision.failIntents) {
      permissions.require("fail_intent");
      try {
        graph.failIntent(projectId, fail.intentId, fail.reason, false, "planner");
        graph.logEvent(projectId, "planner.kill_explorer", { intentId: fail.intentId, reason: fail.reason });
        result.intentsFailed += 1;
      } catch { /* intent may already be concluded */ }
    }

    for (const hintId of decision.consumeHintIds.length > 0 ? decision.consumeHintIds : (ctx.hintIdsToConsume ?? [])) {
      try {
        graph.consumeHint(projectId, hintId);
        result.hintsConsumed += 1;
      } catch { /* already consumed */ }
    }

    if (decision.concludeRun) {
      permissions.require("conclude_run");
      graph.updateProjectStatus(projectId, "completed");
      graph.logEvent(projectId, "planner.conclude", { description: decision.concludeRun.description });
      result.concluded = true;
    }

    return result;
  });
}

export interface VerdictTrigger {
  factId: string;
  verdict: Verdict;
  intentId?: string;
}

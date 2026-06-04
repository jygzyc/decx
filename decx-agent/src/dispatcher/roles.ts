import type { AgentPhase, RoleAutonomy, TaskConfig } from "../core/types.js";

export interface RoleDefinition {
  id: string;
  extends?: string;
  phase?: AgentPhase;
  prompt: string;
  capabilities?: string[];
  autonomy: Required<RoleAutonomy>;
}

export interface RoleProvider {
  getRole(roleId: string, config: TaskConfig | undefined): RoleDefinition | undefined;
}

const ROLE_PROVIDERS: RoleProvider[] = [];

// Five built-in roles. task.json config overrides them at runtime.
const BUILTIN_ROLES: Record<string, RoleDefinition> = {
  planner: {
    id: "planner", phase: "bootstrap",
    prompt: "Understand the goal, define analysis boundaries, propose the initial route.",
    capabilities: ["create_initial_facts", "propose_intents"],
    autonomy: { canCreateIntents: true, canCompleteRun: false, canFailRun: false, canReview: false, maxIntentsPerStep: 3 },
  },
  dispatcher: {
    id: "dispatcher", phase: "reason",
    prompt: "Review the graph state. Decide if the goal is complete or create the next batch of intents.",
    capabilities: ["assess_goal_completion", "create_intents", "declare_complete"],
    autonomy: { canCreateIntents: true, canCompleteRun: true, canFailRun: true, canReview: false, maxIntentsPerStep: 3 },
  },
  executor: {
    id: "executor",
    prompt: "Execute one concrete worker dispatch. Keep input/output constrained to the JSON protocol.",
    capabilities: ["execute_task", "record_result"],
    autonomy: { canCreateIntents: false, canCompleteRun: false, canFailRun: false, canReview: false, maxIntentsPerStep: 0 },
  },
  explorer: {
    id: "explorer", phase: "explore",
    prompt: "Deep-dive around one intent. Produce objective facts, workflow events, and artifacts.",
    capabilities: ["trace_chains", "collect_evidence", "produce_artifacts"],
    autonomy: { canCreateIntents: true, canCompleteRun: false, canFailRun: false, canReview: false, maxIntentsPerStep: 2 },
  },
  reviewer: {
    id: "reviewer", phase: "review",
    prompt: "Review for drift, weak evidence, repeated work, or premature completion. Do not explore.",
    capabilities: ["detect_drift", "assess_evidence_quality"],
    autonomy: { canCreateIntents: false, canCompleteRun: false, canFailRun: false, canReview: true, maxIntentsPerStep: 0 },
  },
};

// Priority: task.json config → programmatic provider → builtin fallback
export function getRole(config: TaskConfig | undefined, roleId: string): RoleDefinition {
  const configured = config?.roles?.[roleId];
  if (configured) {
    const parentId = configured.extends ?? (BUILTIN_ROLES[roleId] ? roleId : "explorer");
    const parent = getRole(config, parentId);
    return {
      id: roleId,
      extends: configured.extends ?? parent.id,
      phase: configured.phase ?? parent.phase,
      prompt: [configured.promptText ?? parent.prompt, configured.instructions].filter(Boolean).join("\n\n"),
      capabilities: configured.capabilities
        ? [...new Set([...(parent.capabilities ?? []), ...configured.capabilities])]
        : parent.capabilities,
      autonomy: { ...parent.autonomy, ...configured.autonomy },
    };
  }
  for (const provider of ROLE_PROVIDERS) {
    const role = provider.getRole(roleId, config);
    if (role) return role;
  }
  return BUILTIN_ROLES[roleId] ?? {
    id: roleId,
    prompt: "",
    autonomy: { canCreateIntents: false, canCompleteRun: false, canFailRun: false, canReview: false, maxIntentsPerStep: 0 },
  };
}

// Maps phase → default role. Used when intent has no role override.
export function defaultRoleForPhase(phase: AgentPhase): string {
  if (phase === "bootstrap") return "planner";
  if (phase === "reason") return "dispatcher";
  if (phase === "review") return "reviewer";
  return "explorer";
}

export function registerRoleProvider(provider: RoleProvider): () => void {
  ROLE_PROVIDERS.push(provider);
  return () => {
    const idx = ROLE_PROVIDERS.indexOf(provider);
    if (idx >= 0) ROLE_PROVIDERS.splice(idx, 1);
  };
}

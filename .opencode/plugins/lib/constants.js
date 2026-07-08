import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
export const OPENCODE_ROOT = resolve(PLUGIN_DIR, "../..");
export const REPO_ROOT = resolve(OPENCODE_ROOT, "..");

export const DATA_DIR = join(REPO_ROOT, ".decx", "opencode-plugin");
export const LOGS_DIR = join(DATA_DIR, "logs");
export const TASKS_DIR = join(DATA_DIR, "tasks");
export const DEFAULT_LOG = join(LOGS_DIR, "plugin_debug.log");
export const HEARTBEAT_FILE = join(DATA_DIR, ".plugin-heartbeat");
export const TIMELINE_DIR = join(DATA_DIR, "timelines");

export const GRAPH_ENGINE = join(PLUGIN_DIR, "decx-graph.js");
export const DEFAULT_GRAPH_ROOT = join(REPO_ROOT, ".decx-analysis");
export const AGENT_RULES_DIR = join(OPENCODE_ROOT, "agents-rules");

export const MAX_LOG_SIZE = 5 * 1024 * 1024;
export const KEEP_LOG_SIZE = 2 * 1024 * 1024;
export const MAX_TIMELINE_BUFFER = 50;

// RoleId shape: planner | explorer | evaluator | metacog | system.
// `system` has no public write function; it is represented by plugin hooks.
export const ROLE_FUNCTIONS = Object.freeze({
  planner: [
    "decx_planner_init",
    "decx_planner_add_root_fact",
    "decx_planner_create_intent",
    "decx_planner_add_human_hint",
    "decx_planner_respond_hint",
    "decx_planner_fail_intent",
    "decx_planner_spawn_explorer",
    "decx_planner_spawn_evaluator",
    "decx_planner_stop_agent",
    "decx_planner_start_metacog",
    "decx_planner_restart_metacog",
  ],
  explorer: [
    "decx_explorer_claim_intent",
    "decx_explorer_renew_intent",
    "decx_explorer_add_candidate",
    "decx_explorer_conclude_intent",
  ],
  evaluator: [
    "decx_evaluator_verdict",
  ],
  metacog: [
    "decx_metacog_add_hint",
    "decx_metacog_heartbeat",
  ],
  read: [
    "decx_graph_facts",
    "decx_graph_intents",
    "decx_graph_hints",
    "decx_graph_agents",
    "decx_graph_links",
    "decx_graph_path",
    "decx_graph_ancestors",
    "decx_graph_descendants",
    "decx_graph_chains",
    "decx_graph_proof_chains",
    "decx_graph_export",
    "decx_graph_check",
    "decx_cross_graphs",
    "decx_cross_export",
    "decx_cross_search",
    "decx_cross_compare_facts",
    "decx_session_state",
  ],
});

export const ROLE_PROTOCOL = Object.freeze({
  planner: [
    "MainAgent and sole orchestrator: creates intents and controlled explorer/evaluator/metacog subagents.",
    "Must respond to open hints before ordinary planning or spawning work.",
    "May stop subagents and fail intents only with accepted evaluator-reviewed fact evidence.",
  ],
  explorer: [
    "Runs only as a planner-created subagent bound to one intent.",
    "Claims or renews that intent, executes it, and writes candidate facts with concrete evidence.",
    "May conclude execution, but cannot fail intents or judge its own facts.",
  ],
  evaluator: [
    "Runs only as a planner-created subagent bound to one candidate fact.",
    "May only resolve candidates with verdict decisions: accept, reject, or demote.",
    "Never creates hints, intents, subagents, or intent lifecycle decisions.",
  ],
  metacog: [
    "Runs as the single live monitoring subagent and reviews the complete graph every 30 seconds.",
    "Produces open hints for planner correction; never executes intents or creates facts.",
    "When context is full it is stopped and replaced by a new metacog generation.",
  ],
  system: [
    "Implemented by plugin hooks: context injection, shell env injection, timeline logging, and bypass blocking.",
    "No public graph write function is exposed for system role.",
  ],
});

export const DOMAIN_PROFILES = Object.freeze({
  app: "Android app vulnerability hunting",
  framework: "Android framework / Binder vulnerability hunting",
  cli: "General DECX CLI-assisted analysis",
  poc: "PoC construction from accepted graph facts",
  report: "Report generation from accepted graph facts",
  app_cloud_control: "App cloud-control / remote configuration analysis",
  web: "Web surface and backend analysis",
});

import { DEFAULT_GRAPH_ROOT, DOMAIN_PROFILES, GRAPH_ENGINE, OPENCODE_ROOT, REPO_ROOT, ROLE_FUNCTIONS, ROLE_PROTOCOL } from "./constants.js";

export function formatRole(role, domain) {
  const lines = ROLE_PROTOCOL[role] ?? Object.entries(ROLE_PROTOCOL).flatMap(([name, rules]) => [
    `${name}:`,
    ...rules.map((rule) => `- ${rule}`),
  ]);
  const profile = DOMAIN_PROFILES[domain] ?? DOMAIN_PROFILES.cli;
  return [
    `Domain profile: ${profile}`,
    `Graph root: ${DEFAULT_GRAPH_ROOT}`,
    "Core primitives: Fact / Intent / Hint / Agent.",
    "Proof chain is Fact -> Intent -> Fact; correction chain is Hint -> Intent -> Fact or Hint -> Planner decision.",
    "Workflow control is owned by this OpenCode plugin, not by external prompt bundles.",
    "Write access is exposed as fixed plugin functions, not as a command interpreter with field validation.",
    "The Fact / Intent / Hint graph engine is built into the OpenCode plugin.",
    "Cross-session analysis is available through read-only federation tools; cross-DB writes are not exposed.",
    "Direct shell execution of graph scripts is blocked by tool.execute.before.",
    ...(Array.isArray(lines) ? lines : [String(lines)]),
    "",
    "Function permissions:",
    ...Object.entries(ROLE_FUNCTIONS).flatMap(([name, functions]) => [`${name}:`, ...functions.map((fn) => `- ${fn}`)]),
  ].join("\n");
}

export function systemSection(session) {
  const switched = session?.agentSwitchedFrom ? ` Agent switched from ${session.agentSwitchedFrom} to ${session.agentName}.` : "";
  if (session) session.agentSwitchedFrom = null;
  return `## DECX OpenCode Plugin Active

${switched}
- OPENCODE_ROOT: ${OPENCODE_ROOT}
- DECX_REPO_ROOT: ${REPO_ROOT}
- DECX_GRAPH_ENGINE: ${GRAPH_ENGINE}
- DECX_GRAPH_ROOT: ${DEFAULT_GRAPH_ROOT}
- DECX_SESSION_GRAPH_DIR: ${session?.graphDir || "<resolved as .decx-analysis/<session-id> on first graph tool call>"}
- Graph write permissions are function-level: planner/mainAgent, explorer, evaluator, and metacog each get fixed public functions, not a generic command tool.
- Planner/mainAgent is the sole orchestrator. Explorer, evaluator, and metacog are controlled subagents.
- Open hints block ordinary planner work until planner explicitly responds to them.
- Exactly one active metacog is allowed; it reviews the full graph every 30 seconds and writes hints.
- The active DECX role is checked in code before any role-scoped graph function runs.
- Direct shell execution of graph scripts or direct decx-analysis.db writes is blocked by the plugin.
- Cross-session analysis uses read-only federation tools; write conclusions back through the current session Planner only.
- Use this plugin as the DECX workflow entrypoint; do not load external DECX prompt bundles.`;
}

export function compactionContext() {
  return `## DECX compaction recovery

Preserve these facts when compacting:
- Current target and session graph directory
- Accepted Fact IDs and evidence paths
- Open/claimed/done/failed Intent IDs and claimed explorer names
- Active Explorer/Evaluator/Metacog agent IDs and their target intent/fact/session
- Open hints and whether planner has responded
- Failed routes and reasons
- User constraints

Continue through the fixed DECX graph functions after compaction; do not call raw graph scripts or mutate the database directly.`;
}

export function commandTouchesBlackboard(command) {
  if (typeof command !== "string") return false;
  return command.includes("decx-graph.mjs") || command.includes("decx-graph.js") || command.includes("decx-analysis.db");
}

export function blockShellCommand(output, reason) {
  const escaped = reason.replaceAll("'", "'\\''");
  output.args ??= {};
  output.args.command = `echo '${escaped}' >&2; exit 1`;
}

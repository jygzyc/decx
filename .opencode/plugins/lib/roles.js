import { ROLE_FUNCTIONS } from "./constants.js";

export const ROLE_DEFINITIONS = Object.freeze({
  planner: Object.freeze({
    agentName: "decx-planner",
    aliases: Object.freeze(["planner", "decx-planner", "mainagent", "main-agent", "main_agent", "main"]),
    publicName: "Planner/MainAgent",
  }),
  explorer: Object.freeze({
    agentName: "decx-explorer",
    aliases: Object.freeze(["explorer", "decx-explorer", "explorer-agent"]),
    publicName: "Explorer",
  }),
  evaluator: Object.freeze({
    agentName: "decx-evaluator",
    aliases: Object.freeze(["evaluator", "decx-evaluator", "evaluator-agent"]),
    publicName: "Evaluator",
  }),
  metacog: Object.freeze({
    agentName: "decx-metacog",
    aliases: Object.freeze(["metacog", "decx-metacog", "metacog-agent"]),
    publicName: "Metacog",
  }),
});

export const GRAPH_ROLES = Object.freeze(Object.keys(ROLE_DEFINITIONS));

export function normalizeAgentRole(raw) {
  if (!raw) return { role: null, raw: "unknown" };
  const name = String(raw).toLowerCase();
  for (const [role, definition] of Object.entries(ROLE_DEFINITIONS)) {
    if (definition.aliases.some((alias) => name === alias || name.includes(alias))) return { role, raw };
  }
  return { role: null, raw };
}

export function agentNameFor(role) {
  const definition = ROLE_DEFINITIONS[role];
  if (!definition) throw new Error(`unknown DECX role: ${role}`);
  return definition.agentName;
}

export function allowedToolsForRole(role, extraReadFunctions = []) {
  const allRead = Object.fromEntries([...ROLE_FUNCTIONS.read, ...extraReadFunctions].map((name) => [name, true]));
  const roleTools = Object.fromEntries((ROLE_FUNCTIONS[role] || []).map((name) => [name, true]));
  return { ...allRead, ...roleTools, decx_role: true };
}

export function roleBoundaryText(role, extraReadFunctions = []) {
  const allowed = Object.keys(allowedToolsForRole(role, extraReadFunctions)).sort();
  return [
    `Active DECX role: ${ROLE_DEFINITIONS[role]?.publicName || role}`,
    "Only the listed tools should be used by this role:",
    ...allowed.map((name) => `- ${name}`),
  ].join("\n");
}

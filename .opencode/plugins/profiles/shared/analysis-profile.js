import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAIN_PROFILES, ROLE_FUNCTIONS } from "../../lib/constants.js";
import { loadAgentRulePack, loadProfileTopic } from "../../lib/snippets.js";
import { allowedToolsForRole, ROLE_DEFINITIONS } from "../../lib/roles.js";

const DEFAULT_ROLE_RULES = Object.freeze({
  planner: [
    "Initialize or recover the graph before planning.",
    "Handle open hints before ordinary planning, spawning, stopping, or failing intents.",
    "Create the smallest executable intent that can change graph state.",
    "Spawn Explorer for execution and Evaluator for candidate review; do not perform their write duties yourself.",
    "Fail an intent only with accepted fact evidence.",
  ],
  explorer: [
    "Claim the assigned intent before analysis and use your agent ID as `by` for every write.",
    "Stay inside the assigned intent; do not broaden into sibling surfaces.",
    "Use probe-first queries and cite concrete evidence in every candidate fact.",
    "If the route is blocked or dead, write a candidate dead-end fact and conclude; never fail the intent.",
  ],
  evaluator: [
    "Use your Evaluator agent ID as `by` for the verdict.",
    "Judge only the assigned candidate fact; do not explore new routes.",
    "Accept only when evidence proves reachability, controllability, deep trace, and visible impact for finding claims.",
    "Reject speculation, missing evidence, contradicted chains, and crash-only impact.",
  ],
  metacog: [
    "Inspect the full graph state every cycle before writing a hint.",
    "Use your Metacog agent ID as `by` for every hint.",
    "Hint when analysis drifts, duplicates routes, ignores hints, stalls, lacks review, or misses useful cross-session leads.",
    "Do not create facts, intents, verdicts, or subagents.",
  ],
});

const DEFAULT_ROLE_MISSIONS = Object.freeze({
  planner: "Own the graph, route the domain, answer hints, and create bounded work for subagents.",
  explorer: "Execute one Planner-assigned intent and produce candidate facts with concrete evidence.",
  evaluator: "Review one candidate fact and turn it into accepted, rejected, or demoted evidence.",
  metacog: "Continuously audit the complete graph and write correction hints for Planner.",
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function scriptNames(scripts = []) {
  return scripts.map((script) => typeof script === "string" ? script : script.name).filter(Boolean);
}

export function createAnalysisProfile(metaUrl, config) {
  const profileDir = dirname(fileURLToPath(metaUrl));
  const knowledgeDir = join(profileDir, "knowledge-base");
  const scriptsDir = join(profileDir, "scripts");
  const topicFiles = Object.freeze(config.topicFiles || { index: "index.md" });
  const scripts = Object.freeze(config.scripts || []);
  const readTools = Object.freeze(config.readTools || ["decx_knowledge", "decx_profile_assets"]);
  const domains = Object.freeze(config.domains || [config.defaultDomain || config.id]);
  const kinds = Object.freeze(config.kinds || []);
  const agentAliases = Object.freeze(config.agentAliases || []);

  function ownsDomain(domain) {
    return domains.includes(domain);
  }

  function ownsKind(kind) {
    return kinds.includes(kind);
  }

  function ownsAgent(agentName) {
    const name = String(agentName || "").toLowerCase();
    return agentAliases.some((alias) => name === alias || name.includes(alias));
  }

  function topicForRole(role) {
    if (role === "evaluator") return "evidence" in topicFiles ? "evidence" : "index";
    return "index";
  }

  function knowledgeTopicsForRole(role) {
    const preferred = [topicForRole(role), ...(config.roleTopics?.[role] || [])];
    return unique(["index", ...preferred]).filter((topic) => topic in topicFiles);
  }

  function loadKnowledgeTopic(topic = "index") {
    return loadProfileTopic(knowledgeDir, topicFiles, topic);
  }

  function rolePrompt(role, { domain, graphDir, agentId, target } = {}) {
    const definition = ROLE_DEFINITIONS[role];
    if (!definition) return "";
    const writes = ROLE_FUNCTIONS[role] || [];
    const allowed = Object.keys(allowedToolsForRole(role, readTools)).sort();
    const topics = knowledgeTopicsForRole(role);
    const rules = config.roleRules?.[role] || DEFAULT_ROLE_RULES[role] || [];
    const mission = config.roleMissions?.[role] || DEFAULT_ROLE_MISSIONS[role] || "Execute the assigned DECX role.";
    return [
      `## ${config.title} Role: ${definition.publicName}`,
      "",
      `Mission: ${mission}`,
      `Profile: ${config.id}`,
      `Domain: ${DOMAIN_PROFILES[domain] || config.title}`,
      graphDir ? `Graph directory: ${graphDir}` : null,
      agentId ? `Assigned agent ID: ${agentId}` : null,
      target ? `Assigned target: ${target}` : null,
      "",
      "### Base Boundary",
      "This profile supplies role behavior, knowledge routing, and helper scripts. The base graph plugin enforces function permissions, agent identity, target binding, session DB isolation, and graph invariants.",
      "",
      "### Profile Assets",
      `Knowledge directory: ${knowledgeDir}`,
      `Scripts directory: ${scriptsDir}`,
      `Available scripts: ${scriptNames(scripts).join(", ") || "none"}`,
      "",
      "### Writable Functions",
      ...writes.map((name) => `- ${name}`),
      "",
      "### Read Functions",
      ...allowed.filter((name) => !writes.includes(name)).map((name) => `- ${name}`),
      "",
      "### Knowledge Loading",
      "Load knowledge with `decx_knowledge(topic=...)` only when the current intent or verdict needs it. Knowledge is a lead, not accepted evidence.",
      `Recommended topics for this role/profile: ${topics.join(", ")}`,
      `Available topics: ${Object.keys(topicFiles).join(", ")}`,
      "",
      "### Profile Rules",
      ...(config.profileRules || []).map((rule) => `- ${rule}`),
      "",
      "### Role Rules",
      ...rules.map((rule) => `- ${rule}`),
    ].filter((line) => line !== null).join("\n");
  }

  function childPrompt(params) {
    const base = rolePrompt(params.role, params);
    const suffix = [];
    if (params.role === "explorer") suffix.push("Start by claiming the assigned intent. Finish by concluding it with the same `by` agent ID.");
    if (params.role === "evaluator") suffix.push("Write exactly one verdict for the assigned candidate fact unless the graph state proves it is no longer candidate.");
    if (params.role === "metacog") suffix.push("On each tick, inspect the graph snapshot and emit only actionable correction hints when needed.");
    return [base, ...suffix].filter(Boolean).join("\n\n");
  }

  function systemSections({ role, domain, graphDir }) {
    const index = loadKnowledgeTopic("index");
    return [
      index ? `## ${config.title} Knowledge Index\n\n${index}` : "",
      role ? rolePrompt(role, { domain, graphDir }) : "",
      loadAgentRulePack(role),
    ];
  }

  function compactionContext() {
    return `## ${config.title} profile recovery\n\nPreserve the active profile, loaded knowledge topic, target surface, profile helper scripts, and profile-specific evidence gate decisions.`;
  }

  function shellEnv(output) {
    output.env.DECX_PROFILE_ID = config.id;
    output.env.DECX_PROFILE_DIR = profileDir;
    output.env.DECX_PROFILE_KNOWLEDGE_DIR = knowledgeDir;
    output.env.DECX_PROFILE_SCRIPTS_DIR = scriptsDir;
  }

  return Object.freeze({
    id: config.id,
    title: config.title,
    defaultDomain: config.defaultDomain || domains[0] || "analysis",
    domains,
    kinds,
    agentAliases,
    profileDir,
    knowledgeDir,
    scriptsDir,
    scripts,
    topicFiles,
    readTools,
    ownsDomain,
    ownsKind,
    ownsAgent,
    loadKnowledgeTopic,
    rolePrompt,
    childPrompt,
    systemSections,
    compactionContext,
    shellEnv,
  });
}

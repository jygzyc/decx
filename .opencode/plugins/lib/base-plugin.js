import path from "node:path";
import { tool } from "@opencode-ai/plugin";
import { ctx } from "./context.js";
import { DEFAULT_GRAPH_ROOT, DOMAIN_PROFILES, GRAPH_ENGINE, ROLE_FUNCTIONS } from "./constants.js";
import { writeHeartbeat, debugLog } from "./logging.js";
import { SessionDataManager } from "./session-manager.js";
import { flushTimeline, recordTimeline } from "./timeline.js";
import { explorerGraph, evaluatorGraph, metacogGraph, plannerGraph, readGraph } from "./graph-api.js";
import { compareAcceptedFacts, exportGraphs, listGraphs, searchGraphs } from "./federation.js";
import { ensureTaskDir, sessionState, writeSessionSummary } from "./task-session.js";
import { agentNameFor, allowedToolsForRole, normalizeAgentRole } from "./roles.js";
import {
  blockShellCommand,
  commandTouchesBlackboard,
  compactionContext,
  formatRole,
  systemSection,
} from "./blackboard-policy.js";

const metacogTimers = new Map();
const sessionGraphDirs = new Map();
const sessionDomains = new Map();

function safeSessionSlug(sessionID) {
  return String(sessionID || "default-session").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function sessionDefaultGraphDir(sessionID) {
  return path.join(DEFAULT_GRAPH_ROOT, safeSessionSlug(sessionID));
}

function rememberGraphDir(sessionID, graphDir) {
  if (!sessionID || !graphDir) return;
  sessionGraphDirs.set(sessionID, graphDir);
  const session = ctx.sessionManager?.get(sessionID);
  if (session) session.graphDir = graphDir;
}

function domainFromKind(profile, kind) {
  return profile.domainFromKind?.(kind) || kind || profile.defaultDomain || "analysis";
}

function rememberDomain(sessionID, domain) {
  if (!sessionID || !domain) return;
  sessionDomains.set(sessionID, domain);
  const session = ctx.sessionManager?.get(sessionID);
  if (session) session.domain = domain;
}

function sessionDomain(profile, sessionID) {
  return sessionDomains.get(sessionID) || ctx.sessionManager?.get(sessionID)?.domain || profile.defaultDomain || "analysis";
}

function resolveGraphDir(input, context = {}) {
  if (!input || input === "default") {
    const known = context.sessionID ? sessionGraphDirs.get(context.sessionID) : null;
    return known || sessionDefaultGraphDir(context.sessionID);
  }
  if (path.isAbsolute(input)) return input;
  return path.resolve(DEFAULT_GRAPH_ROOT, "..", input);
}

const graphDirArg = tool.schema.string().default("default").describe("Graph directory. default resolves to .decx-analysis/<session-id>; spawned subagents inherit their parent graph directory");
const evidenceArg = tool.schema.array(tool.schema.string()).default([]).describe("Evidence references, file paths, method signatures, or short notes");
const nodeListArg = tool.schema.array(tool.schema.string()).default([]).describe("Source node refs such as fact:f001, intent:i001, or hint:h001");
const hintIdsArg = tool.schema.array(tool.schema.string()).default([]).describe("Open hint IDs that this planner action explicitly responds to");

function agentRole(profile, sessionID) {
  const raw = ctx.sessionManager?.get(sessionID)?.agentName;
  return profile.roleForAgent?.(raw) || normalizeAgentRole(raw);
}


function assertRole(profile, role, context, toolName) {
  const active = agentRole(profile, context.sessionID);
  if (active.role !== role) {
    throw new Error(`${toolName} is a ${role} function; active DECX role is ${active.role ?? "unknown"} from agent ${active.raw}`);
  }
}

function toolResult(name, output, graphDir, role, extra = {}) {
  return { title: name, output, metadata: { graphDir, role, ...extra } };
}

function makeGraphTool(activeProfile, { name, role, description, args, run }) {
  return tool({
    description,
    args: { graphDir: graphDirArg, ...args },
    async execute(input, context) {
      if (role) assertRole(activeProfile, role, context, name);
      const graphDir = resolveGraphDir(input.graphDir, context);
      rememberGraphDir(context.sessionID, graphDir);
      context.metadata?.({ title: name, metadata: { graphDir, role } });
      const output = await run(graphDir, input, context);
      debugLog(`function ${name} graphDir=${graphDir}`, context.sessionID);
      recordTimeline(context.sessionID, { type: "graph.function", tool: name, detail: graphDir });
      return toolResult(name, output, graphDir, role);
    },
  });
}

async function createChildSession(profile, { role, parentSessionID, title, prompt, directory }) {
  if (!ctx.client?.session?.create || !ctx.client?.session?.promptAsync) return null;
  const created = await ctx.client.session.create({
    query: { directory: directory || ctx.directory || undefined },
    body: { parentID: parentSessionID, title },
  });
  if (created.error || !created.data?.id) throw new Error(`failed to create ${role} session: ${JSON.stringify(created.error)}`);
  const sessionID = created.data.id;
  await ctx.client.session.promptAsync({
    path: { id: sessionID },
    query: { directory: directory || ctx.directory || undefined },
    body: {
      agent: agentNameFor(role),
      tools: allowedToolsForRole(role, profile.readTools || []),
      parts: [{ type: "text", text: prompt }],
    },
  });
  return sessionID;
}

function childPromptFor(profile, role, params) {
  const target = role === "explorer" ? `intent:${params.intentId}` : role === "evaluator" ? `fact:${params.factId}` : params.target;
  return profile.childPrompt?.({ ...params, role, target }) || [
    `DECX ${role} subagent`,
    `Graph directory: ${params.graphDir}`,
    params.agentId ? `Assigned agent ID: ${params.agentId}` : null,
    target ? `Assigned target: ${target}` : null,
  ].filter(Boolean).join("\n");
}

function stopMetacogTimer(graphDir) {
  const timer = metacogTimers.get(graphDir);
  if (timer) clearInterval(timer);
  metacogTimers.delete(graphDir);
}

function startMetacogTimer(profile, graphDir, agentId, sessionID, cycleMs, directory) {
  stopMetacogTimer(graphDir);
  if (!ctx.client?.session?.promptAsync || !sessionID) return;
  const safeCycle = Math.max(30_000, Number(cycleMs || 30_000));
  const timer = setInterval(async () => {
    try {
      const snapshot = readGraph.export(graphDir);
      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        query: { directory: directory || ctx.directory || undefined },
        body: {
          agent: "decx-metacog",
          tools: allowedToolsForRole("metacog", profile.readTools || []),
          parts: [{ type: "text", text: `${childPromptFor(profile, "metacog", { graphDir, agentId, domain: sessionDomain(profile, sessionID) })}\n\nGraph snapshot:\n${snapshot}` }],
        },
      });
      metacogGraph.heartbeat(graphDir, { agentId });
    } catch (error) {
      debugLog(`metacog tick failed agent=${agentId} error=${error?.message || error}`);
    }
  }, safeCycle);
  metacogTimers.set(graphDir, timer);
}

async function spawnAndRecord(profile, role, graphDir, input, context) {
  const domain = sessionDomain(profile, context.sessionID);
  const graphOutput = role === "explorer"
    ? plannerGraph.spawnExplorer(graphDir, input)
    : role === "evaluator"
      ? plannerGraph.spawnEvaluator(graphDir, input)
      : plannerGraph.startMetacog(graphDir, input);
  const agent = JSON.parse(graphOutput);
  const prompt = childPromptFor(profile, role, { ...input, graphDir, agentId: agent.id, cycleMs: agent.cycle_ms, domain });
  const sessionID = await createChildSession(profile, {
    role,
    parentSessionID: context.sessionID,
    title: `DECX ${role} ${agent.id}`,
    prompt,
    directory: context.directory,
  });
  if (sessionID) {
    plannerGraph.setAgentSession(graphDir, { agentId: agent.id, sessionId: sessionID });
    agent.session_id = sessionID;
    rememberGraphDir(sessionID, graphDir);
    rememberDomain(sessionID, domain);
  }
  if (role === "metacog") startMetacogTimer(profile, graphDir, agent.id, sessionID, agent.cycle_ms, context.directory);
  return JSON.stringify(agent, null, 2);
}

function graphTools(profile) {
  const bindGraphTool = (definition) => makeGraphTool(profile, definition);
  return {
    decx_planner_init: bindGraphTool({
      name: "decx_planner_init",
      role: "planner",
      description: "Planner/MainAgent-only function: initialize a DECX Fact / Intent / Hint graph.",
      args: {
        session: tool.schema.string().describe("Analysis session name"),
        kind: tool.schema.enum(profile.kinds || ["analysis"]).default(profile.defaultKind || "analysis"),
      },
      run: (graphDir, input, context) => {
        rememberDomain(context.sessionID, domainFromKind(profile, input.kind));
        return plannerGraph.init(graphDir, input);
      },
    }),

    decx_planner_add_root_fact: bindGraphTool({
      name: "decx_planner_add_root_fact",
      role: "planner",
      description: "Planner/MainAgent-only function: add an accepted root fact. Blocked while open hints exist.",
      args: { description: tool.schema.string(), evidence: evidenceArg, confidence: tool.schema.number().default(1) },
      run: (graphDir, input) => plannerGraph.addRootFact(graphDir, input),
    }),

    decx_planner_create_intent: bindGraphTool({
      name: "decx_planner_create_intent",
      role: "planner",
      description: "Planner/MainAgent-only function: create an executable intent. Open hints must be addressed through parentHintIds.",
      args: {
        description: tool.schema.string().describe("Concrete bounded work item"),
        parentFactIds: tool.schema.array(tool.schema.string()).default([]),
        parentHintIds: tool.schema.array(tool.schema.string()).default([]).describe("Open hints this intent responds to"),
        responseReason: tool.schema.string().default("").describe("Why this intent responds to the hints"),
        parentIntentId: tool.schema.string().default(""),
        priority: tool.schema.number().default(0),
        root: tool.schema.boolean().default(false),
      },
      run: (graphDir, input) => plannerGraph.createIntent(graphDir, input),
    }),

    decx_planner_add_human_hint: bindGraphTool({
      name: "decx_planner_add_human_hint",
      role: "planner",
      description: "Planner/MainAgent-only function: add human guidance as an open hint that must be responded to.",
      args: { content: tool.schema.string(), from: nodeListArg },
      run: (graphDir, input) => plannerGraph.addHumanHint(graphDir, input),
    }),

    decx_planner_respond_hint: bindGraphTool({
      name: "decx_planner_respond_hint",
      role: "planner",
      description: "Planner/MainAgent-only function: explicitly respond to open hints without creating an intent.",
      args: {
        hintIds: hintIdsArg,
        action: tool.schema.enum(["acknowledge", "ignore", "request_more_evidence", "reprioritize", "stop_agent", "fail_intent"]),
        reason: tool.schema.string(),
        target: tool.schema.string().default(""),
      },
      run: (graphDir, input) => plannerGraph.respondHint(graphDir, input),
    }),

    decx_planner_fail_intent: bindGraphTool({
      name: "decx_planner_fail_intent",
      role: "planner",
      description: "Planner/MainAgent-only function: fail an intent using an accepted evaluator-reviewed fact as evidence.",
      args: { intentId: tool.schema.string(), factId: tool.schema.string(), reason: tool.schema.string(), hintIds: hintIdsArg },
      run: (graphDir, input) => plannerGraph.failIntent(graphDir, input),
    }),

    decx_planner_spawn_explorer: bindGraphTool({
      name: "decx_planner_spawn_explorer",
      role: "planner",
      description: "Planner/MainAgent-only function: create an Explorer subagent bound to one intent. Blocked while open hints exist.",
      args: { intentId: tool.schema.string() },
      run: (graphDir, input, context) => spawnAndRecord(profile, "explorer", graphDir, input, context),
    }),

    decx_planner_spawn_evaluator: bindGraphTool({
      name: "decx_planner_spawn_evaluator",
      role: "planner",
      description: "Planner/MainAgent-only function: create an Evaluator subagent bound to one candidate fact. Blocked while open hints exist.",
      args: { factId: tool.schema.string() },
      run: (graphDir, input, context) => spawnAndRecord(profile, "evaluator", graphDir, input, context),
    }),

    decx_planner_stop_agent: bindGraphTool({
      name: "decx_planner_stop_agent",
      role: "planner",
      description: "Planner/MainAgent-only function: stop an active Explorer/Evaluator/Metacog subagent, usually in response to a hint.",
      args: { agentId: tool.schema.string(), reason: tool.schema.string(), hintIds: hintIdsArg },
      async run(graphDir, input) {
        const out = plannerGraph.stopAgent(graphDir, input);
        const stopped = JSON.parse(out);
        if (stopped.session_id && ctx.client?.session?.abort) await ctx.client.session.abort({ path: { id: stopped.session_id } });
        if (String(input.agentId).startsWith("m")) stopMetacogTimer(graphDir);
        return out;
      },
    }),

    decx_planner_start_metacog: bindGraphTool({
      name: "decx_planner_start_metacog",
      role: "planner",
      description: "Planner/MainAgent-only function: start the single live Metacog subagent with a 30s review loop.",
      args: { cycleMs: tool.schema.number().default(30000) },
      run: (graphDir, input, context) => spawnAndRecord(profile, "metacog", graphDir, { ...input, cycleMs: Math.max(30000, input.cycleMs) }, context),
    }),

    decx_planner_restart_metacog: bindGraphTool({
      name: "decx_planner_restart_metacog",
      role: "planner",
      description: "Planner/MainAgent-only function: stop a context-full Metacog and create the next 30s-loop generation.",
      args: { agentId: tool.schema.string(), reason: tool.schema.string().default("metacog context full"), cycleMs: tool.schema.number().default(30000) },
      async run(graphDir, input, context) {
        const stopped = JSON.parse(plannerGraph.stopAgent(graphDir, { agentId: input.agentId, reason: input.reason, contextFull: true }));
        if (stopped.session_id && ctx.client?.session?.abort) await ctx.client.session.abort({ path: { id: stopped.session_id } });
        stopMetacogTimer(graphDir);
        return spawnAndRecord(profile, "metacog", graphDir, { cycleMs: Math.max(30000, input.cycleMs) }, context);
      },
    }),

    decx_explorer_claim_intent: bindGraphTool({
      name: "decx_explorer_claim_intent",
      role: "explorer",
      description: "Explorer-only function: claim one planner-assigned intent lease before executing it.",
      args: { intentId: tool.schema.string(), by: tool.schema.string().describe("Explorer agent ID"), leaseMs: tool.schema.number().default(1800000) },
      run: (graphDir, input) => explorerGraph.claimIntent(graphDir, input),
    }),

    decx_explorer_renew_intent: bindGraphTool({
      name: "decx_explorer_renew_intent",
      role: "explorer",
      description: "Explorer-only function: renew a lease held by the same explorer.",
      args: { intentId: tool.schema.string(), by: tool.schema.string().describe("Explorer agent ID"), leaseMs: tool.schema.number().default(1800000) },
      run: (graphDir, input) => explorerGraph.renewIntent(graphDir, input),
    }),

    decx_explorer_add_candidate: bindGraphTool({
      name: "decx_explorer_add_candidate",
      role: "explorer",
      description: "Explorer-only function: write a candidate fact from a claimed intent. Explorer cannot fail intents.",
      args: { intentId: tool.schema.string(), by: tool.schema.string().describe("Explorer agent ID"), description: tool.schema.string(), evidence: evidenceArg, confidence: tool.schema.number().default(0.7) },
      run: (graphDir, input) => explorerGraph.addCandidate(graphDir, input),
    }),

    decx_explorer_conclude_intent: bindGraphTool({
      name: "decx_explorer_conclude_intent",
      role: "explorer",
      description: "Explorer-only function: mark execution done, optionally pointing to a candidate fact.",
      args: { intentId: tool.schema.string(), factId: tool.schema.string().default(""), by: tool.schema.string().describe("Explorer agent ID") },
      run: (graphDir, input) => explorerGraph.concludeIntent(graphDir, input),
    }),

    decx_evaluator_verdict: bindGraphTool({
      name: "decx_evaluator_verdict",
      role: "evaluator",
      description: "Evaluator-only function: accept, reject, or demote a candidate fact.",
      args: { factId: tool.schema.string(), decision: tool.schema.enum(["accept", "reject", "demote"]), reason: tool.schema.string(), confidence: tool.schema.number().default(-1), by: tool.schema.string().describe("Evaluator agent ID") },
      run: (graphDir, input) => evaluatorGraph.verdict(graphDir, { ...input, confidence: input.confidence < 0 ? undefined : input.confidence }),
    }),

    decx_metacog_add_hint: bindGraphTool({
      name: "decx_metacog_add_hint",
      role: "metacog",
      description: "Metacog-only function: add an open correction hint for Planner/MainAgent.",
      args: { content: tool.schema.string(), by: tool.schema.string().describe("Metacog agent ID"), from: nodeListArg },
      run: (graphDir, input) => metacogGraph.addHint(graphDir, input),
    }),

    decx_metacog_heartbeat: bindGraphTool({
      name: "decx_metacog_heartbeat",
      role: "metacog",
      description: "Metacog-only function: mark the active 30s-loop metacog as alive.",
      args: { agentId: tool.schema.string() },
      run: (graphDir, input) => metacogGraph.heartbeat(graphDir, input),
    }),

    decx_graph_facts: bindGraphTool({ name: "decx_graph_facts", description: "Read-only function: list facts.", args: { status: tool.schema.enum(["all", "candidate", "accepted", "rejected"]).default("all"), source: tool.schema.enum(["all", "planner", "explorer"]).default("all") }, run: (graphDir, input) => readGraph.facts(graphDir, { status: input.status === "all" ? undefined : input.status, source: input.source === "all" ? undefined : input.source }) }),
    decx_graph_intents: bindGraphTool({ name: "decx_graph_intents", description: "Read-only function: list intents.", args: { status: tool.schema.enum(["all", "open", "claimed", "done", "failed"]).default("all") }, run: (graphDir, input) => readGraph.intents(graphDir, { status: input.status === "all" ? undefined : input.status }) }),
    decx_graph_hints: bindGraphTool({ name: "decx_graph_hints", description: "Read-only function: list hints.", args: { status: tool.schema.enum(["all", "open", "responded", "ignored"]).default("all") }, run: (graphDir, input) => readGraph.hints(graphDir, { status: input.status === "all" ? undefined : input.status }) }),
    decx_graph_agents: bindGraphTool({ name: "decx_graph_agents", description: "Read-only function: list subagents.", args: { role: tool.schema.enum(["all", "explorer", "evaluator", "metacog"]).default("all"), status: tool.schema.enum(["all", "active", "stopped", "completed", "context_full"]).default("all") }, run: (graphDir, input) => readGraph.agents(graphDir, { role: input.role === "all" ? undefined : input.role, status: input.status === "all" ? undefined : input.status }) }),
    decx_graph_links: bindGraphTool({ name: "decx_graph_links", description: "Read-only function: list internal graph links.", args: {}, run: (graphDir) => readGraph.links(graphDir) }),
    decx_graph_chains: bindGraphTool({ name: "decx_graph_chains", description: "Read-only function: list graph chains.", args: {}, run: (graphDir) => readGraph.chains(graphDir) }),
    decx_graph_proof_chains: bindGraphTool({ name: "decx_graph_proof_chains", description: "Read-only function: list accepted-only proof chains. Candidate and rejected facts are excluded.", args: {}, run: (graphDir) => readGraph.proofChains(graphDir) }),
    decx_graph_export: bindGraphTool({ name: "decx_graph_export", description: "Read-only function: export the complete graph.", args: {}, run: (graphDir) => readGraph.export(graphDir) }),
    decx_graph_check: bindGraphTool({ name: "decx_graph_check", description: "Read-only function: validate graph reachability and agent invariants.", args: {}, run: (graphDir) => readGraph.check(graphDir) }),
    decx_graph_path: bindGraphTool({ name: "decx_graph_path", description: "Read-only function: shortest path between two graph nodes.", args: { from: tool.schema.string(), to: tool.schema.string() }, run: (graphDir, input) => readGraph.path(graphDir, input) }),
    decx_graph_ancestors: bindGraphTool({ name: "decx_graph_ancestors", description: "Read-only function: list ancestors of one graph node.", args: { node: tool.schema.string() }, run: (graphDir, input) => readGraph.ancestors(graphDir, input) }),
    decx_graph_descendants: bindGraphTool({ name: "decx_graph_descendants", description: "Read-only function: list descendants of one graph node.", args: { node: tool.schema.string() }, run: (graphDir, input) => readGraph.descendants(graphDir, input) }),

    decx_cross_graphs: bindGraphTool({
      name: "decx_cross_graphs",
      description: "Cross-DB read-only function: list isolated session graphs available under .decx-analysis.",
      args: {},
      run: () => JSON.stringify(listGraphs(DEFAULT_GRAPH_ROOT), null, 2),
    }),

    decx_cross_export: bindGraphTool({
      name: "decx_cross_export",
      description: "Cross-DB read-only function: export selected session graphs, or all graphs when no selection is provided.",
      args: {
        graphIds: tool.schema.array(tool.schema.string()).default([]).describe("Session graph directory names under .decx-analysis"),
        graphDirs: tool.schema.array(tool.schema.string()).default([]).describe("Explicit graph directories"),
      },
      run: (_graphDir, input) => JSON.stringify(exportGraphs(DEFAULT_GRAPH_ROOT, input), null, 2),
    }),

    decx_cross_search: bindGraphTool({
      name: "decx_cross_search",
      description: "Cross-DB read-only function: search facts/intents/hints across selected or all session graphs.",
      args: {
        query: tool.schema.string(),
        graphIds: tool.schema.array(tool.schema.string()).default([]),
        graphDirs: tool.schema.array(tool.schema.string()).default([]),
        nodeTypes: tool.schema.array(tool.schema.enum(["facts", "intents", "hints"])).default(["facts", "intents", "hints"]),
        status: tool.schema.enum(["all", "candidate", "accepted", "rejected", "open", "claimed", "done", "failed", "responded", "ignored"]).default("all"),
        limit: tool.schema.number().default(100),
      },
      run: (_graphDir, input) => JSON.stringify(searchGraphs(DEFAULT_GRAPH_ROOT, input), null, 2),
    }),

    decx_cross_compare_facts: bindGraphTool({
      name: "decx_cross_compare_facts",
      description: "Cross-DB read-only function: compare accepted facts across selected or all session graphs and group repeated conclusions.",
      args: {
        graphIds: tool.schema.array(tool.schema.string()).default([]),
        graphDirs: tool.schema.array(tool.schema.string()).default([]),
      },
      run: (_graphDir, input) => JSON.stringify(compareAcceptedFacts(DEFAULT_GRAPH_ROOT, input), null, 2),
    }),

    decx_session_state: bindGraphTool({
      name: "decx_session_state",
      description: "Read-only function: return current OpenCode session graphDir/taskDir/agent state.",
      args: {},
      run: (graphDir, _input, context) => JSON.stringify(sessionState(context.sessionID, ctx.sessionManager?.get(context.sessionID), graphDir), null, 2),
    }),

  };
}

export const createDecxGraphPlugin = async (profile = {}, input = {}) => {
  const sessionManager = new SessionDataManager();
  ctx.init(input, sessionManager);
  writeHeartbeat();
  debugLog(`=== ${profile.id || "decx-base"} plugin loaded ===`);
  debugLog(`graphEngine=${GRAPH_ENGINE}`);
  const bindGraphTool = (definition) => makeGraphTool(profile, definition);

  return {
    dispose: async () => {
      for (const timer of metacogTimers.values()) clearInterval(timer);
      metacogTimers.clear();
    },

    config: async (_config) => {
      // DECX OpenCode workflow is fully plugin-owned. No external prompt path registration.
    },

    tool: {
      ...graphTools(profile),
      ...(profile.tools?.({ tool, makeGraphTool: bindGraphTool, resolveGraphDir, rememberGraphDir, readGraph, sessionDomain: (sessionID) => sessionDomain(profile, sessionID) }) || {}),
      decx_role: tool({
        description: "Return DECX code-enforced graph function boundaries for the selected domain profile.",
        args: { role: tool.schema.enum(["planner", "explorer", "evaluator", "metacog", "system", "all"]).default("all"), domain: tool.schema.enum(Object.keys(DOMAIN_PROFILES)).default("app") },
        async execute(input) {
          const protocol = formatRole(input.role, input.domain);
          const prompt = input.role === "all" || input.role === "system" ? "" : profile.rolePrompt?.(input.role, { domain: input.domain });
          return { title: `DECX ${input.role} protocol`, output: [protocol, prompt].filter(Boolean).join("\n\n"), metadata: { graphEngine: GRAPH_ENGINE, roleFunctions: ROLE_FUNCTIONS, domainProfiles: DOMAIN_PROFILES, profile: profile.id || "base" } };
        },
      }),
    },

    "chat.message": async (hookInput) => {
      const sessionID = hookInput.sessionID;
      if (!sessionID) return;
      const session = ctx.sessionManager.upsert(sessionID, hookInput.agent || "unknown");
      const agentDomain = profile.domainFromAgent?.(session.agentName);
      if (agentDomain) rememberDomain(sessionID, agentDomain);
      ensureTaskDir(sessionID);
      debugLog(`chat.message agent=${session.agentName}`, sessionID);
      recordTimeline(sessionID, { type: "chat.message", detail: session.agentName });
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      const sessionID = hookInput.sessionID;
      const session = sessionID ? ctx.sessionManager.get(sessionID) : undefined;
      if (session) session.systemTransformCount += 1;
      output.system ??= [];
      output.system.unshift(systemSection(session));
      const activeRole = agentRole(profile, sessionID).role;
      const sections = profile.systemSections?.({ role: activeRole, domain: sessionDomain(profile, sessionID), graphDir: session?.graphDir, sessionID, session }) || [];
      for (const section of sections.filter(Boolean).reverse()) output.system.unshift(section);
      debugLog(`system.transform injected count=${session?.systemTransformCount ?? 0}`, sessionID);
    },

    "experimental.session.compacting": async (_hookInput, output) => {
      output.context ??= [];
      output.context.push(compactionContext());
      const profileContext = profile.compactionContext?.();
      if (profileContext) output.context.push(profileContext);
    },

    "shell.env": async (hookInput, output) => {
      output.env ??= {};
      output.env.DECX_GRAPH_ENGINE = GRAPH_ENGINE;
      output.env.DECX_GRAPH_ROOT = DEFAULT_GRAPH_ROOT;
      output.env.DECX_DEFAULT_GRAPH_DIR = sessionGraphDirs.get(hookInput.sessionID) || sessionDefaultGraphDir(hookInput.sessionID);
      output.env.DECX_TASK_DIR = ensureTaskDir(hookInput.sessionID);
      profile.shellEnv?.(output, { sessionID: hookInput.sessionID, cwd: hookInput.cwd, domain: sessionDomain(profile, hookInput.sessionID) });
      debugLog(`shell.env injected cwd=${hookInput.cwd || ""} graphDir=${output.env.DECX_DEFAULT_GRAPH_DIR} taskDir=${output.env.DECX_TASK_DIR}`, hookInput.sessionID);
    },

    "tool.execute.before": async (hookInput, output) => {
      const sessionID = hookInput.sessionID;
      const toolName = String(hookInput.tool || "").toLowerCase();
      const command = output.args?.command;
      recordTimeline(sessionID, { type: "tool.before", tool: hookInput.tool, detail: typeof command === "string" ? command.slice(0, 120) : undefined });
      if ((toolName === "bash" || toolName === "shell") && commandTouchesBlackboard(command)) {
        const reason = "[DECX Plugin blocked] Direct graph mutation is forbidden. Use DECX function-level graph tools so role permissions are enforced in code.";
        blockShellCommand(output, reason);
        debugLog(`blocked raw graph command: ${String(command).slice(0, 160)}`, sessionID);
      }
    },

    "tool.execute.after": async (hookInput) => {
      recordTimeline(hookInput.sessionID, { type: "tool.after", tool: hookInput.tool });
    },

    event: async ({ event }) => {
      const props = event?.properties || {};
      const sessionID = props.info?.id ?? props.sessionID;
      if (!sessionID) return;
      if (event?.type === "session.deleted") {
        const session = ctx.sessionManager.get(sessionID);
        try { writeSessionSummary(sessionID, { graphDir: sessionGraphDirs.get(sessionID) || session?.graphDir || null, status: "deleted" }); } catch {}
        flushTimeline(sessionID);
        ctx.sessionManager.delete(sessionID);
        sessionGraphDirs.delete(sessionID);
        sessionDomains.delete(sessionID);
        debugLog("session.deleted cleaned", sessionID);
      }
      if (event?.type === "session.idle") {
        const session = ctx.sessionManager.get(sessionID);
        try { writeSessionSummary(sessionID, { graphDir: sessionGraphDirs.get(sessionID) || session?.graphDir || null, status: "idle" }); } catch {}
        flushTimeline(sessionID);
      }
      if (event?.type === "session.compacted") debugLog("session.compacted", sessionID);
    },
  };
};


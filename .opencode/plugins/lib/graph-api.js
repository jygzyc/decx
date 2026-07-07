import { runDecxGraph } from "./decx-graph.js";

function jsonList(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function addIf(args, flag, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, String(value));
}

function addBool(args, flag, enabled) {
  if (enabled) args.push(flag);
}

function run(command, graphDir, args = []) {
  return runDecxGraph(command, graphDir, args);
}

export const plannerGraph = Object.freeze({
  init(graphDir, { session, kind }) {
    return run("init", graphDir, ["--session", session, "--kind", kind]);
  },

  addRootFact(graphDir, { description, evidence = [], confidence = 1 }) {
    return run("fact", graphDir, [
      "--root",
      "--body", description,
      "--evidence", jsonList(evidence),
      "--confidence", String(confidence),
    ]);
  },

  createIntent(graphDir, { description, parentFactIds = [], parentHintIds = [], parentIntentId, priority = 0, root = false, responseReason }) {
    const args = ["--description", description, "--priority", String(priority)];
    addBool(args, "--root", root || (parentFactIds.length === 0 && parentHintIds.length === 0));
    if (parentFactIds.length > 0) args.push("--from", jsonList(parentFactIds));
    if (parentHintIds.length > 0) args.push("--fromHints", jsonList(parentHintIds));
    addIf(args, "--parentIntentId", parentIntentId);
    addIf(args, "--responseReason", responseReason);
    return run("intent", graphDir, args);
  },

  addHumanHint(graphDir, { content, from = [] }) {
    const args = ["--body", content, "--author", "human"];
    if (from.length > 0) args.push("--from", jsonList(from));
    return run("hint", graphDir, args);
  },

  respondHint(graphDir, { hintIds = [], action, reason, target }) {
    return run("respond-hint", graphDir, ["--hints", jsonList(hintIds), "--action", action, "--reason", reason, "--target", target || ""]);
  },

  failIntent(graphDir, { intentId, factId, reason, hintIds = [] }) {
    const args = [intentId, "--fact", factId, "--reason", reason];
    if (hintIds.length) args.push("--hints", jsonList(hintIds));
    return run("fail-intent", graphDir, args);
  },

  spawnExplorer(graphDir, { intentId, agentId, sessionId, parentSessionId }) {
    const args = ["--role", "explorer", "--intent", intentId];
    addIf(args, "--id", agentId);
    addIf(args, "--sessionId", sessionId);
    addIf(args, "--parentSessionId", parentSessionId);
    return run("spawn-agent", graphDir, args);
  },

  spawnEvaluator(graphDir, { factId, agentId, sessionId, parentSessionId }) {
    const args = ["--role", "evaluator", "--fact", factId];
    addIf(args, "--id", agentId);
    addIf(args, "--sessionId", sessionId);
    addIf(args, "--parentSessionId", parentSessionId);
    return run("spawn-agent", graphDir, args);
  },

  startMetacog(graphDir, { sessionId, parentSessionId, cycleMs = 30000 }) {
    const args = ["--role", "metacog", "--cycleMs", String(cycleMs)];
    addIf(args, "--sessionId", sessionId);
    addIf(args, "--parentSessionId", parentSessionId);
    return run("spawn-agent", graphDir, args);
  },

  stopAgent(graphDir, { agentId, reason, hintIds = [], contextFull = false }) {
    const args = [agentId, "--reason", reason];
    if (hintIds.length) args.push("--hints", jsonList(hintIds));
    addBool(args, "--contextFull", contextFull);
    return run("stop-agent", graphDir, args);
  },

  setAgentSession(graphDir, { agentId, sessionId }) {
    return run("set-agent-session", graphDir, [agentId, "--sessionId", sessionId]);
  },
});

export const explorerGraph = Object.freeze({
  claimIntent(graphDir, { intentId, by, leaseMs }) {
    const args = [intentId, "--by", by];
    addIf(args, "--lease-ms", leaseMs);
    return run("claim", graphDir, args);
  },

  renewIntent(graphDir, { intentId, by, leaseMs }) {
    const args = [intentId, "--by", by];
    addIf(args, "--lease-ms", leaseMs);
    return run("renew", graphDir, args);
  },

  addCandidate(graphDir, { intentId, by, description, evidence = [], confidence = 0.7 }) {
    return run("candidate", graphDir, [
      "--from", intentId,
      "--by", by,
      "--body", description,
      "--evidence", jsonList(evidence),
      "--confidence", String(confidence),
    ]);
  },

  concludeIntent(graphDir, { intentId, factId, by }) {
    const args = [intentId];
    addIf(args, "--fact", factId);
    addIf(args, "--by", by);
    return run("conclude", graphDir, args);
  },
});

export const evaluatorGraph = Object.freeze({
  verdict(graphDir, { factId, decision, reason, confidence, by }) {
    const args = ["--fact", factId, "--decision", decision, "--reason", reason];
    addIf(args, "--confidence", confidence);
    addIf(args, "--by", by);
    return run("verdict", graphDir, args);
  },
});

export const metacogGraph = Object.freeze({
  addHint(graphDir, { content, by, from = [] }) {
    const args = ["--body", content, "--author", "metacog", "--by", by];
    if (from.length > 0) args.push("--from", jsonList(from));
    return run("hint", graphDir, args);
  },

  heartbeat(graphDir, { agentId }) {
    return run("heartbeat-agent", graphDir, [agentId]);
  },
});

export const readGraph = Object.freeze({
  facts(graphDir, { status, source } = {}) {
    const args = [];
    addIf(args, "--status", status);
    addIf(args, "--source", source);
    return run("facts", graphDir, args);
  },

  intents(graphDir, { status } = {}) {
    const args = [];
    addIf(args, "--status", status);
    return run("intents", graphDir, args);
  },

  hints(graphDir, { status } = {}) {
    const args = [];
    addIf(args, "--status", status);
    return run("hints", graphDir, args);
  },

  agents(graphDir, { role, status } = {}) {
    const args = [];
    addIf(args, "--role", role);
    addIf(args, "--status", status);
    return run("agents", graphDir, args);
  },

  links(graphDir) {
    return run("links", graphDir, []);
  },

  path(graphDir, { from, to }) {
    return run("path", graphDir, ["--from", from, "--to", to]);
  },

  ancestors(graphDir, { node }) {
    return run("ancestors", graphDir, ["--node", node]);
  },

  descendants(graphDir, { node }) {
    return run("descendants", graphDir, ["--node", node]);
  },

  chains(graphDir) {
    return run("chains", graphDir, []);
  },

  proofChains(graphDir) {
    return run("proof-chains", graphDir, []);
  },

  export(graphDir) {
    return run("export", graphDir, []);
  },

  check(graphDir) {
    return run("check", graphDir, []);
  },
});

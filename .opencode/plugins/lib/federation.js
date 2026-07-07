import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { readGraph } from "./graph-api.js";

const DB_NAME = "decx-analysis.db";

function graphDbPath(graphDir) {
  return join(graphDir, DB_NAME);
}

function parseJson(output, fallback) {
  try {
    return JSON.parse(output);
  } catch {
    return fallback;
  }
}

function graphSummary(graphDir) {
  const data = parseJson(readGraph.export(graphDir), {});
  return {
    id: basename(graphDir),
    graphDir,
    db: graphDbPath(graphDir),
    project: data.project || null,
    counts: {
      facts: Array.isArray(data.facts) ? data.facts.length : 0,
      acceptedFacts: Array.isArray(data.facts) ? data.facts.filter((f) => f.status === "accepted").length : 0,
      candidateFacts: Array.isArray(data.facts) ? data.facts.filter((f) => f.status === "candidate").length : 0,
      intents: Array.isArray(data.intents) ? data.intents.length : 0,
      openHints: Array.isArray(data.hints) ? data.hints.filter((h) => h.status === "open").length : 0,
      agents: Array.isArray(data.agents) ? data.agents.length : 0,
    },
  };
}

export function listGraphs(rootDir) {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir)
    .map((name) => join(rootDir, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory() && existsSync(graphDbPath(dir));
      } catch {
        return false;
      }
    })
    .sort()
    .map(graphSummary);
}

function resolveGraphRefs(rootDir, refs = [], dirs = []) {
  const resolved = [];
  for (const dir of dirs || []) resolved.push(isAbsolute(dir) ? dir : resolve(rootDir, "..", dir));
  for (const ref of refs || []) resolved.push(join(rootDir, ref));
  const unique = [...new Set(resolved)];
  return unique.filter((dir) => existsSync(graphDbPath(dir)));
}

function selectedGraphs(rootDir, { graphIds = [], graphDirs = [] } = {}) {
  const selected = resolveGraphRefs(rootDir, graphIds, graphDirs);
  return selected.length ? selected.map(graphSummary) : listGraphs(rootDir);
}

export function exportGraphs(rootDir, selection = {}) {
  return selectedGraphs(rootDir, selection).map((graph) => ({
    ...graph,
    data: parseJson(readGraph.export(graph.graphDir), {}),
  }));
}

function haystack(row) {
  return JSON.stringify(row).toLowerCase();
}

export function searchGraphs(rootDir, { query, graphIds = [], graphDirs = [], nodeTypes = ["facts", "intents", "hints"], status = "all", limit = 100 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) throw new Error("query required");
  const results = [];
  for (const graph of exportGraphs(rootDir, { graphIds, graphDirs })) {
    for (const type of nodeTypes) {
      const rows = Array.isArray(graph.data[type]) ? graph.data[type] : [];
      for (const row of rows) {
        if (status !== "all" && row.status !== status) continue;
        if (!haystack(row).includes(q)) continue;
        results.push({ graph: { id: graph.id, graphDir: graph.graphDir, project: graph.project }, type, row });
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}

function normalizeFact(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function compareAcceptedFacts(rootDir, selection = {}) {
  const graphs = exportGraphs(rootDir, selection);
  const buckets = new Map();
  for (const graph of graphs) {
    for (const fact of graph.data.facts || []) {
      if (fact.status !== "accepted") continue;
      const key = normalizeFact(fact.description);
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ graph: graph.id, graphDir: graph.graphDir, factId: fact.id, confidence: fact.confidence, evidence: fact.evidence });
    }
  }
  const repeated = [];
  const unique = [];
  for (const [description, occurrences] of buckets.entries()) {
    const item = { description, occurrences };
    if (new Set(occurrences.map((o) => o.graph)).size > 1) repeated.push(item);
    else unique.push(item);
  }
  return { graphs: graphs.map((g) => ({ id: g.id, graphDir: g.graphDir, project: g.project })), repeated, unique };
}

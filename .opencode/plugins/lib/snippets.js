import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_RULES_DIR } from "./constants.js";
import { debugLog } from "./logging.js";

const textCache = new Map();

function loadCached(filePath) {
  try {
    const stat = statSync(filePath);
    const cached = textCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) return cached.content;
    const content = readFileSync(filePath, "utf8").trim();
    textCache.set(filePath, { mtime: stat.mtimeMs, content });
    return content;
  } catch (error) {
    debugLog(`snippet load failed: ${filePath} ${error?.message || error}`);
    return "";
  }
}

export function loadAgentRulePack(role) {
  const files = [
    "running-environment.md",
    "graph-discipline.md",
    "planning-rules.md",
    "probe-first-strategy.md",
    "execution-discipline.md",
    "knowledge-loading.md",
    "recovery-rules.md",
    "cross-session-analysis.md",
    "output-format.md",
  ];
  const content = files
    .map((name) => loadCached(join(AGENT_RULES_DIR, name)))
    .filter(Boolean)
    .join("\n\n");
  if (!content) return "";
  return `## DECX Agent Rules (${role || "unknown"})\n\n${content}`;
}

export function loadProfileTopic(baseDir, topics, topic) {
  const file = topics[topic];
  if (!file) throw new Error(`unknown DECX knowledge topic: ${topic}`);
  return loadCached(join(baseDir, file));
}

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS_DIR } from "./constants.js";

function safeSlug(value) {
  return String(value || "unknown-session").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function ensureTaskDir(sessionID) {
  const dir = join(TASKS_DIR, safeSlug(sessionID));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeSessionSummary(sessionID, data) {
  const dir = ensureTaskDir(sessionID);
  const path = join(dir, "summary.json");
  writeFileSync(path, JSON.stringify({ sessionID, updatedAt: new Date().toISOString(), ...data }, null, 2));
  return path;
}

export function sessionState(sessionID, session, graphDir) {
  const taskDir = ensureTaskDir(sessionID);
  return {
    sessionID,
    agent: session?.agentName || "unknown",
    graphDir: graphDir || session?.graphDir || null,
    taskDir,
    createdAt: session?.createdAt || null,
    lastUserMessageAt: session?.lastUserMessageAt || null,
  };
}

export function taskDirExists(sessionID) {
  return existsSync(join(TASKS_DIR, safeSlug(sessionID)));
}

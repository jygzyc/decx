import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { DEFAULT_LOG, HEARTBEAT_FILE, KEEP_LOG_SIZE, LOGS_DIR, MAX_LOG_SIZE, REPO_ROOT, GRAPH_ENGINE } from "./constants.js";

function trimLogFile(logFile) {
  try {
    if (!existsSync(logFile) || statSync(logFile).size <= MAX_LOG_SIZE) return;
    const content = readFileSync(logFile, "utf8");
    const keep = content.slice(-KEEP_LOG_SIZE);
    const firstNewline = keep.indexOf("\n");
    writeFileSync(logFile, firstNewline >= 0 ? keep.slice(firstNewline + 1) : keep);
  } catch {
    // Ignore logging failures.
  }
}

export function debugLog(message, sessionID) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    trimLogFile(DEFAULT_LOG);
    const ts = new Date().toISOString();
    const sid = sessionID ? ` [${sessionID}]` : "";
    writeFileSync(DEFAULT_LOG, `${ts}${sid} ${message}\n`, { flag: "a" });
  } catch {
    // Logging must never affect analysis.
  }
}

export function writeHeartbeat() {
  try {
    mkdirSync(dirname(HEARTBEAT_FILE), { recursive: true });
    writeFileSync(HEARTBEAT_FILE, JSON.stringify({
      pid: process.pid,
      loadedAt: new Date().toISOString(),
      version: "1.0.0",
      repoRoot: REPO_ROOT,
      graphEngine: GRAPH_ENGINE,
    }, null, 2));
  } catch (error) {
    debugLog(`heartbeat write failed: ${error}`);
  }
}

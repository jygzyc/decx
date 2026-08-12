/**
 * Lightweight append-only logger for DECX CLI.
 *
 * Logs API calls and CLI events to session log files
 * at ~/.decx/logs/<session>.log in JSONL format.
 * Always-on, never throws — logging failures must not break the CLI.
 */

import { appendFileSync, mkdirSync, existsSync } from "fs";
import * as path from "path";
import { decxPath } from "../core/paths.js";

const LOG_DIR = decxPath("logs");
const GENERAL_LOG = path.join(LOG_DIR, "cli.log");

let dirInitialized = false;

function ensureLogDir(): void {
  if (!dirInitialized) {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    dirInitialized = true;
  }
}

/**
 * Resolve log file path for a session, falling back to general CLI log.
 */
function resolveLogFile(sessionName?: string): string {
  if (sessionName) {
    return path.join(LOG_DIR, `${sessionName}.log`);
  }
  return GENERAL_LOG;
}

// ============================================================================
// Entry types
// ============================================================================

export interface ApiLogEntry {
  ts: string;
  type: "api";
  method: string;
  path: string;
  duration_ms: number;
  status: "ok" | "error";
  error?: string;
}

export interface CliEventEntry {
  ts: string;
  type: "cli";
  command: string;
  action: string;
  [key: string]: unknown;
}

export interface ErrorLogEntry {
  ts: string;
  type: "error";
  code?: string;
  message: string;
  command?: string;
  [key: string]: unknown;
}

/** Append one JSON line to a log file. Never throws — logging must not break the CLI. */
function appendJsonLine(logFile: string, entry: object): void {
  try {
    ensureLogDir();
    appendFileSync(logFile, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n", "utf-8");
  } catch {
    // Silent failure — logging must never break the CLI
  }
}

/** Append an API call log entry to a session log file. Never throws. */
export function logApiCall(sessionName: string, entry: Omit<ApiLogEntry, "ts" | "type">): void {
  appendJsonLine(resolveLogFile(sessionName), { ...entry, type: "api" });
}

/** Append a CLI event log entry. Never throws. */
export function logCliEvent(entry: Omit<CliEventEntry, "ts" | "type">): void {
  appendJsonLine(GENERAL_LOG, { ...entry, type: "cli" });
}

/** Append an error log entry. Never throws. */
export function logError(entry: Omit<ErrorLogEntry, "ts" | "type">): void {
  appendJsonLine(GENERAL_LOG, { ...entry, type: "error" });
}

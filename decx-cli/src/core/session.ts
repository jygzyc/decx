/**
 * Session management for DECX CLI.
 *
 * Sessions are stored in ~/.decx/sessions/<name>.json
 * where name is the APK filename without extension.
 */

import {
  existsSync, mkdirSync, writeFileSync, readFileSync,
  readdirSync, unlinkSync, renameSync,
} from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";
import type { Session } from "./types.js";
import { decxPath } from "./paths.js";

const SESSIONS_DIR = decxPath("sessions");
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sessionFilePath(name: string): string {
  return path.join(SESSIONS_DIR, `${name}.json`);
}

/**
 * Verify that a PID still belongs to a DECX server process (not a reused PID).
 * Checks the process command on macOS/Linux.
 */
function isDecxProcess(pid: number): boolean {
  try {
    // Signal 0 just checks liveness
    process.kill(pid, 0);
  } catch {
    return false; // Process doesn't exist
  }

  // Verify command name to guard against PID reuse
  try {
    if (process.platform === "win32") return true; // Skip on Windows
    const result = spawnSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf-8",
      timeout: 3000,
    });
    if (result.status !== 0 || !result.stdout.trim()) return false;
    const comm = result.stdout.trim().toLowerCase();
    // Match java (decx-server runs as JVM process)
    return comm.includes("java");
  } catch {
    // If ps fails, assume it's still valid (conservative)
    return true;
  }
}

/**
 * Atomic write: write to temp file then rename (POSIX atomic).
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpFile, filePath);
}

export function createSession(name: string, hash: string, apkPath: string, pid: number, port: number): Session {
  const session: Session = { name, hash, pid, port, path: apkPath, startedAt: Date.now(), kind: "process" };
  atomicWriteJson(sessionFilePath(name), session);
  return session;
}

export function readSession(name: string): Session | null {
  const file = sessionFilePath(name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Session;
  } catch {
    return null;
  }
}

export function deleteSession(name: string): void {
  const file = sessionFilePath(name);
  if (existsSync(file)) unlinkSync(file);
}

export function listAllSessions(): Session[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const sessions: Session[] = [];
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      sessions.push(JSON.parse(readFileSync(path.join(SESSIONS_DIR, f), "utf-8")) as Session);
    } catch { /* skip invalid */ }
  }
  return sessions;
}

/**
 * Auto-select session: returns the single alive session if exactly one exists, else null.
 */
export function autoSelectSession(): Session | null {
  const all = listAllSessions();
  const alive = all.filter((session) => isSessionAlive(session));
  return alive.length === 1 ? alive[0] : null;
}

/**
 * Check if a session's process is still alive AND is actually a DECX process.
 */
export function isSessionAlive(session: Session): boolean {
  return isDecxProcess(session.pid);
}

export function cleanupDead(): number {
  let n = 0;
  const now = Date.now();
  for (const s of listAllSessions()) {
    const expired = now - s.startedAt > SESSION_MAX_AGE_MS;
    if (expired || !isDecxProcess(s.pid)) {
      deleteSession(s.name);
      n++;
    }
  }
  return n;
}

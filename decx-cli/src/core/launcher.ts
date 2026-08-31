/**
 * Server process lifecycle: open targets, wait for startup, kill process groups.
 */

import { spawn, execSync } from "child_process";
import * as path from "path";
import { totalmem } from "os";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "fs";
import { hashFile } from "../utils/hash.js";
import { FileError, ProcessError, ServerError } from "../utils/errors.js";
import type { Session } from "./types.js";
import { findDecxServerJar } from "./installer.js";
import { logCliEvent } from "../utils/logger.js";
import { decxPath } from "./paths.js";
import { Manager } from "./config.js";
import { resolveFileInput } from "./file-input.js";
import { parseServerPort, selectAvailableServerPort } from "./ports.js";

export interface OpenAnalysisTargetOptions {
  port?: string;
  force?: boolean;
  name?: string;
  mcp?: boolean;
  scripts?: string[];
  passthroughArgs?: string[];
  /** Seconds to wait for the server to become healthy (default 300). */
  timeout?: number;
}

export function defaultJavaHeap(): string {
  return `${Math.floor(totalmem() / 1024 / 1024 / 1024 * 2 / 3)}g`;
}

export function buildDecxServerJavaArgs(
  jarPath: string,
  filePath: string,
  port: number,
  jadxArgs: string[],
  mcp?: boolean,
  scripts: string[] = [],
): string[] {
  const args = [
    `-Xmx${defaultJavaHeap()}`,
    "-jar",
    jarPath,
    filePath,
    "--port",
    String(port),
  ];
  if (mcp) args.push("--mcp");
  args.push(...jadxArgs);
  // Jadx Kotlin scripts are positional input files handled by the bundled
  // jadx-script-kotlin plugin (evaluated during decompilation).
  args.push(...scripts);
  return args;
}

export interface OpenReuseInput {
  fileHash: string;
  fileName: string;
  force: boolean;
  aliveSessions: Session[];
  existingByName: Session | null;
  scripts?: string[];
}

/**
 * Alive sessions a `--force` spawn must replace: any session under the target
 * name, plus any session holding the same file hash (same file = same server
 * contract). Killing them prevents orphaned JVMs piling up when `--force` is
 * used to restart a slow-decompiling target.
 */
export function pickForceReplaceSessions(
  aliveSessions: Session[],
  fileName: string,
  fileHash: string,
): Session[] {
  return aliveSessions.filter(s => s.name === fileName || s.hash === fileHash);
}

export type OpenReuseDecision =
  | { action: "reuse"; session: Session }
  | { action: "error"; message: string }
  | { action: "spawn"; removeStaleName?: string };

function sameScripts(a: string[] | undefined, b: string[]): boolean {
  const aa = a ?? [];
  return aa.length === b.length && aa.every((s, i) => s === b[i]);
}

/**
 * Decide what `process open` should do with a file whose sha256 is `fileHash`:
 * reuse an already-loaded session, refuse on a name collision with a different
 * file or script set, or spawn a fresh server (optionally clearing a stale
 * same-name record). Pure — no I/O — so it can be unit-tested.
 */
export function decideOpenReuse(input: OpenReuseInput): OpenReuseDecision {
  const { fileHash, fileName, force, aliveSessions, existingByName, scripts = [] } = input;

  if (!force) {
    // Reuse any alive session that already holds this exact file (by sha256) and
    // was started with the same script set (scripts run at decompile time, so a
    // different set requires a fresh server).
    const reuse = aliveSessions.find((s) => s.hash === fileHash && sameScripts(s.scripts, scripts));
    if (reuse) return { action: "reuse", session: reuse };

    // A live session holds this file but with a different script set: refuse to
    // silently reuse the wrong server; the user must opt into a restart.
    const liveWithDifferentScripts = aliveSessions.find((s) => s.hash === fileHash && !sameScripts(s.scripts, scripts));
    if (liveWithDifferentScripts) {
      return {
        action: "error",
        message:
          `Session '${fileName}' is already running for this APK with a different script set. ` +
          `Use --force to restart with the new scripts.`,
      };
    }

    // A record under the requested name already exists for a *different* file:
    // refuse to shadow it so the name keeps pointing at one APK.
    if (existingByName && existingByName.hash !== fileHash) {
      return {
        action: "error",
        message:
          `Session '${fileName}' already exists for a different APK (hash: ${existingByName.hash}). ` +
          `Use --force to overwrite, or --name to choose a different session name.`,
      };
    }

    // Stale record under the same name (same hash, dead process) → clear before re-spawn.
    return { action: "spawn", removeStaleName: existingByName?.name };
  }

  // --force bypasses reuse; createSession overwrites any same-name record.
  return { action: "spawn" };
}

/**
 * jadx rename flags DECX understands well enough to rewrite: `case` fixes class
 * name casing, `valid` fixes identifiers that are not valid in Java, and
 * `printable` replaces identifiers containing non-ASCII characters (common in
 * obfuscated builds, e.g. `Ď锬볝觧`) with `m0`-style aliases. `all` = all three.
 */
const RENAME_FLAGS_ARGS = ["--rename-flags", "-rf"];
const KNOWN_RENAME_FLAGS = new Set(["CASE", "VALID", "PRINTABLE", "ALL"]);

/**
 * Drop the `printable` token from a `--rename-flags` value so obfuscated
 * Unicode identifiers survive decompilation. Returns null when the value
 * cannot be parsed safely (unknown tokens, mixed `NONE`) — the caller then
 * leaves the user's original spelling untouched.
 */
function sanitizeRenameFlagsValue(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0) return null;
  const upper = raw.toUpperCase();
  if (upper === "NONE") return "NONE";
  if (upper === "ALL") return "CASE,VALID";
  const tokens = raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0 || !tokens.every((t) => KNOWN_RENAME_FLAGS.has(t.toUpperCase()))) return null;
  const kept = tokens.filter((t) => t.toUpperCase() !== "PRINTABLE");
  return kept.length > 0 ? kept.join(",") : "NONE";
}

function hasRenameFlagsArg(args: string[]): boolean {
  return args.some((arg) =>
    RENAME_FLAGS_ARGS.includes(arg) ||
    RENAME_FLAGS_ARGS.some((name) => arg.startsWith(`${name}=`)));
}

/**
 * Rewrite every `--rename-flags` / `-rf` occurrence (space and `=` forms),
 * dropping the `printable` token. Unparseable values pass through unchanged.
 */
function stripPrintableRenameFlag(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eqMatch = /^(--rename-flags|-rf)=(.*)$/.exec(arg);
    if (RENAME_FLAGS_ARGS.includes(arg)) {
      const value = args[i + 1] ?? "";
      result.push(arg, sanitizeRenameFlagsValue(value) ?? value);
      i++;
    } else if (eqMatch) {
      result.push(`${eqMatch[1]}=${sanitizeRenameFlagsValue(eqMatch[2]) ?? eqMatch[2]}`);
    } else {
      result.push(arg);
    }
  }
  return result;
}

export function normalizeJadxPassthroughArgs(args: string[] = []): string[] {
  const result = stripPrintableRenameFlag(args.filter((arg) => arg !== "--deobf"));
  if (!result.includes("--show-bad-code")) {
    result.push("--show-bad-code");
  }
  if (!result.includes("--no-imports")) {
    result.push("--no-imports");
  }
  if (!result.includes("-Pdex-input.verify-checksum=no")) {
    result.push("-Pdex-input.verify-checksum=no");
  }
  // jadx renames non-ASCII identifiers by default (`printable` flag), which
  // hides heavily obfuscated Unicode names behind `m0`-style aliases in the
  // decompiled source while DECX keeps querying by the original names.
  if (!hasRenameFlagsArg(result)) {
    result.push("--rename-flags", "case,valid");
  }
  return result;
}

export async function openAnalysisTarget(
  filePath: string,
  opts: OpenAnalysisTargetOptions = {},
): Promise<Record<string, unknown>> {
  const mgr = Manager.get();
  const requestedPort = opts.port !== undefined ? parseServerPort(opts.port) : undefined;

  const jarPath = findDecxServerJar();
  if (!jarPath) {
    throw new FileError("decx-server.jar not found. Run 'decx self install' to install.");
  }

  const resolvedFile = await resolveFileInput(filePath);
  if (!existsSync(resolvedFile)) {
    throw new FileError(`File not found: ${resolvedFile}`, resolvedFile);
  }

  // Validate Jadx Kotlin scripts before spawning; they run during decompilation.
  const scripts: string[] = [];
  for (const script of opts.scripts ?? []) {
    const resolvedScript = await resolveFileInput(script);
    if (!existsSync(resolvedScript)) {
      throw new FileError(`Script file not found: ${resolvedScript}`, resolvedScript);
    }
    scripts.push(resolvedScript);
  }

  const fileName = opts.name || path.basename(resolvedFile, path.extname(resolvedFile));
  const fileHash = await hashFile(resolvedFile);

  const decision = decideOpenReuse({
    fileHash,
    fileName,
    force: opts.force ?? false,
    aliveSessions: mgr.listAliveSessions(),
    existingByName: mgr.getSession(fileName),
    scripts,
  });

  if (decision.action === "reuse") {
    const reuse = decision.session;
    logCliEvent({ command: "process", action: "open", session: reuse.name, reused: true, pid: reuse.pid, port: reuse.port });
    return { name: reuse.name, hash: reuse.hash, pid: reuse.pid, port: reuse.port, file: resolvedFile, reused: true };
  }
  if (decision.action === "error") {
    throw new ProcessError(decision.message);
  }
  if (decision.removeStaleName) {
    mgr.removeSession(decision.removeStaleName);
  }

  // `--force` means restart: kill alive servers this spawn replaces (same
  // name or same file) so old JVMs cannot linger as memory-eating orphans.
  // A failed kill aborts the spawn: overwriting the session record while the
  // old JVM lives would orphan it permanently (this was the pre-4.2 behavior).
  for (const stale of pickForceReplaceSessions(mgr.listAliveSessions(), fileName, fileHash)) {
    const killResult = await killProcessGroup(stale.pid);
    logCliEvent({ command: "process", action: "open", session: stale.name, replacedByForce: true, pid: stale.pid, port: stale.port, killResult });
    if (killResult === "failed") {
      throw new ProcessError(
        `--force could not stop previous session '${stale.name}' (pid ${stale.pid}, port ${stale.port}); ` +
        `refusing to spawn a duplicate server. Kill pid ${stale.pid} manually, then retry.`,
      );
    }
    mgr.removeSession(stale.name);
  }

  const port = await selectAvailableServerPort(requestedPort, opts.mcp ?? false);
  const javaArgs = buildDecxServerJavaArgs(
    jarPath,
    resolvedFile,
    port,
    normalizeJadxPassthroughArgs(opts.passthroughArgs ?? []),
    opts.mcp,
    scripts,
  );
  const logDir = decxPath("logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${fileName}.log`);
  const logFd = openSync(logPath, "a");
  let proc;

  try {
    proc = spawn("java", javaArgs, { detached: true, stdio: ["ignore", logFd, logFd] });
  } finally {
    closeSync(logFd);
  }

  if (!proc.pid) {
    throw new ProcessError("Failed to get PID from spawned process");
  }

  proc.unref();

  let processExited = false;
  let processExitCode: number | null = null;
  proc.on("exit", (code) => {
    processExited = true;
    processExitCode = code;
  });

  const session = mgr.createSession(fileName, fileHash, resolvedFile, proc.pid, port, scripts);
  const timeout = Math.max(1, Math.floor(opts.timeout ?? 300)); // seconds
  // Heartbeat on stderr so interactive users and agents waiting on this
  // command see liveness while a large APK decompiles (stdout stays JSON-only).
  const heartbeat = (elapsedSec: number, lastLogLine?: string): void => {
    const tail = lastLogLine ? ` | ${lastLogLine.slice(0, 120)}` : "";
    process.stderr.write(`  Waiting for decx-server '${fileName}' (pid ${proc.pid})... ${elapsedSec}s elapsed${tail}\n`);
  };
  const ready = await waitForServer(port, timeout, logPath, () => processExited, { heartbeat });
  if (ready) {
    logCliEvent({ command: "process", action: "open", session: session.name, pid: proc.pid, port, file: resolvedFile, mcp: opts.mcp ?? false });
    return { name: session.name, hash: session.hash, pid: proc.pid, port, file: resolvedFile, log: logPath, mcp: opts.mcp ?? false, mcpPort: opts.mcp ? port + 1 : undefined, scripts, reused: false };
  }

  if (processExited) {
    mgr.removeSession(fileName);
    throw new ServerError(`decx-server exited unexpectedly (code: ${processExitCode}). Check log: ${logPath}`, port);
  }
  // Timed out but the JVM is still decompiling: keep the session record so the
  // server stays reachable (`decx process check --port ${port}`) instead of
  // becoming an untracked orphan that a later `--force` would duplicate.
  throw new ServerError(
    `Server did not become healthy within ${timeout}s on port ${port}, but the process (pid ${proc.pid}) is ` +
    `still running — it is likely still decompiling a large target. The session '${fileName}' was kept; ` +
    `poll it with 'decx process check --port ${port}', or stop it with 'decx process close ${fileName}'. ` +
    `Log: ${logPath}`,
    port,
  );
}

/**
 * Check if DECX server is reachable on the given port.
 */
export async function checkServer(port: number, retries: number = 3): Promise<[boolean, string]> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return [true, `Server running on port ${port}`];
    } catch { /* retry */ }
    if (i < retries - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return [false, `No server on port ${port}`];
}

export interface WaitForServerOptions {
  /** Called roughly every heartbeatIntervalMs while waiting. */
  heartbeat?: (elapsedSec: number, lastLogLine?: string) => void;
  /** Heartbeat cadence in ms (default 15000; tests use shorter values). */
  heartbeatIntervalMs?: number;
}

const HEARTBEAT_INTERVAL_MS = 15_000;

export async function waitForServer(
  port: number,
  timeout: number = 120,
  logPath?: string,
  shouldAbort?: () => boolean,
  opts: WaitForServerOptions = {},
): Promise<boolean> {
  const start = Date.now();
  const deadline = timeout * 1000;
  const interval = 1000;
  const readyMarker = "DECX Server running at";
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  let lastLogLine: string | undefined;
  let lastHeartbeatAt = start;

  while (Date.now() - start < deadline) {
    if (shouldAbort?.()) return false;

    // Primary: check log file for ready marker
    if (logPath) {
      try {
        const content = readFileSync(logPath, "utf-8");
        const lines = content.split("\n");
        lastLogLine = [...lines].reverse().find(l => l.trim().length > 0) ?? lastLogLine;
        if (content.includes(readyMarker)) {
          // Confirm with health check
          try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.ok) return true;
          } catch { /* log ready but server not yet accepting connections */ }
        }
      } catch { /* log file not yet created or not readable */ }
    }

    // Fallback: health check (every 2s)
    if (Math.floor((Date.now() - start) / interval) % 2 === 0) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) return true;
      } catch { /* starting */ }
    }

    if (opts.heartbeat && Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) {
      lastHeartbeatAt = Date.now();
      opts.heartbeat(Math.round((Date.now() - start) / 1000), lastLogLine);
    }

    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

/**
 * Outcome of [killProcessGroup]: the caller must only drop the session record
 * for "killed"/"already-dead" — dropping it after "failed" orphans the JVM.
 */
export type KillResult = "killed" | "already-dead" | "failed";

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !isPidAlive(pid);
}

/**
 * Kill an entire process group (handles detached processes with children).
 * On Unix, uses negative PID to signal the process group.
 * On Windows, uses taskkill /T to kill the process tree.
 */
export async function killProcessGroup(pid: number): Promise<KillResult> {
  if (!isPidAlive(pid)) return "already-dead";
  if (process.platform === "win32") {
    return killProcessTreeWin(pid);
  }

  // Negative PID = kill entire process group (for detached: true)
  try { process.kill(-pid, "SIGTERM"); } catch { /* group signal best-effort */ }
  if (await waitForDeath(pid, 2000)) return "killed";

  try { process.kill(-pid, "SIGKILL"); } catch { /* fall back to direct kill */ }
  if (await waitForDeath(pid, 2000)) return "killed";

  // Last resort: direct kill in case the process was not a group leader.
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  return (await waitForDeath(pid, 1000)) ? "killed" : "failed";
}

async function killProcessTreeWin(pid: number): Promise<KillResult> {
  const tryTaskkill = (force: boolean): boolean => {
    try {
      execSync(`taskkill /T${force ? " /F" : ""} /PID ${pid}`, { stdio: "ignore" });
      return true;
    } catch { return false; }
  };

  // Graceful kill first (often a no-op for windowless JVMs, hence the verify
  // loop), then a verified force kill. Only death counts — taskkill's exit
  // code alone is not proof the process tree is gone.
  tryTaskkill(false);
  if (await waitForDeath(pid, 2000)) return "killed";
  tryTaskkill(true);
  return (await waitForDeath(pid, 2000)) ? "killed" : "failed";
}

export function extractPassthroughArgs(argv: readonly string[] = process.argv): string[] {
  const cmdArgs = argv.slice(2);
  const openIdx = cmdArgs.indexOf("open");
  if (openIdx === -1) return [];

  const raw = cmdArgs.slice(openIdx + 1);
  const decxFlagsWithValue = ["--port", "-n", "--name", "--script", "--timeout"];
  const decxFlags = ["--force", "--mcp", "--no-mcp"];

  const result: string[] = [];
  let fileSkipped = false;
  let i = 0;

  while (i < raw.length) {
    const arg = raw[i];

    if (!fileSkipped && !arg.startsWith("-")) {
      fileSkipped = true;
      i++;
      continue;
    }

    const isDecxWithValue = decxFlagsWithValue.some(
      (flag) => arg === flag || arg.startsWith(`${flag}=`)
    );
    if (isDecxWithValue) {
      i += arg.includes("=") ? 1 : 2;
      continue;
    }

    if (decxFlags.includes(arg)) {
      i++;
      continue;
    }

    result.push(arg);
    i++;
  }

  return result;
}

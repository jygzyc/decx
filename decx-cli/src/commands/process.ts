/**
 * Process management commands.
 */

import { Command } from "commander";
import { spawn, execSync } from "child_process";
import * as path from "path";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "fs";
import { downloadWithProgress, formatBytes } from "../utils/progress.js";
import { createHash } from "crypto";
import { DecxClient } from "../core/client.js";
import { Formatter } from "../utils/formatter.js";
import { Manager } from "../core/config.js";
import { hashFile } from "../utils/hash.js";
import { FileError, ProcessError, DecxError, ServerError, handleCliError } from "../utils/errors.js";
import { findDecxServerJar } from "../server/installer.js";
import { isSessionAlive } from "../core/session.js";
import { logCliEvent } from "../utils/logger.js";
import { decxPath } from "../core/paths.js";

export interface OpenAnalysisTargetOptions {
  port?: string;
  force?: boolean;
  name?: string;
  passthroughArgs?: string[];
}

export function normalizeJadxPassthroughArgs(args: string[] = []): string[] {
  if (args.includes("--show-bad-code")) {
    return args;
  }
  return [...args, "--show-bad-code"];
}

export async function openAnalysisTarget(
  filePath: string,
  opts: OpenAnalysisTargetOptions = {},
): Promise<Record<string, unknown>> {
  const mgr = Manager.get();
  const port = opts.port ? parseInt(opts.port) : mgr.server.defaultPort;

  const [portInUse] = await checkServer(port, 1);
  if (portInUse) {
    const aliveSessions = mgr.listAliveSessions();
    const portSession = aliveSessions.find((s) => s.port === port);
    if (portSession) {
      throw new ProcessError(
        `Port ${port} is already in use by session '${portSession.name}' (${portSession.path}). ` +
        `Use --port to specify a different port, or close that session first.`,
        port,
      );
    }
    throw new ProcessError(
      `Port ${port} is already in use by an unknown process. Use --port to specify a different port.`,
      port,
    );
  }

  const jarPath = findDecxServerJar();
  if (!jarPath) {
    throw new FileError("decx-server.jar not found. Run 'decx self install' to install.");
  }

  const resolvedFile = await resolveFileInput(filePath);
  if (!existsSync(resolvedFile)) {
    throw new FileError(`File not found: ${resolvedFile}`, resolvedFile);
  }

  const fileName = opts.name || path.basename(resolvedFile, path.extname(resolvedFile));
  const fileHash = await hashFile(resolvedFile);
  const existingSession = mgr.getSession(fileName);

  if (existingSession && !opts.force) {
    if (existingSession.hash === fileHash && isSessionAlive(existingSession)) {
      logCliEvent({ command: "process", action: "open", session: existingSession.name, reused: true, pid: existingSession.pid, port: existingSession.port });
      return { name: existingSession.name, hash: existingSession.hash, pid: existingSession.pid, port: existingSession.port, file: resolvedFile, reused: true };
    }
    if (existingSession.hash !== fileHash) {
      throw new ProcessError(
        `Session '${fileName}' already exists for a different APK (hash: ${existingSession.hash}). ` +
        `Use --force to overwrite, or --name to choose a different session name.`,
      );
    }
    mgr.removeSession(fileName);
  }

  if (!opts.force) {
    for (const session of mgr.listAliveSessions()) {
      if (session.hash === fileHash && session.name !== fileName) {
        throw new ProcessError(`Already open as session '${session.name}'. Use --force to open again.`);
      }
    }
  }

  const javaArgs = [
    "-jar",
    jarPath,
    resolvedFile,
    "--port",
    String(port),
    ...normalizeJadxPassthroughArgs(opts.passthroughArgs ?? []),
  ];
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

  const session = await mgr.createSession(fileName, fileHash, resolvedFile, proc.pid, port);
  const timeout = 300; // seconds
  const ready = await waitForServer(port, timeout, logPath, () => processExited);
  if (ready) {
    logCliEvent({ command: "process", action: "open", session: session.name, pid: proc.pid, port, file: resolvedFile });
    return { name: session.name, hash: session.hash, pid: proc.pid, port, file: resolvedFile, log: logPath, reused: false };
  }

  mgr.removeSession(fileName);
  if (processExited) {
    throw new ServerError(`decx-server exited unexpectedly (code: ${processExitCode}). Check log: ${logPath}`, port);
  }
  throw new ServerError(`Server did not start within ${timeout}s on port ${port}`, port);
}

export function makeProcessCommand(): Command {
  const cmd = new Command("process");
  cmd.description("Manage DECX server processes and installation");

  // check
  cmd
    .command("check")
    .description("Check DECX server status")
    .option("-P, --port <port>", "Server port", String)
    .action(async (opts) => {
      const fmt = new Formatter();
      const mgr = Manager.get();
      const port = opts.port ? parseInt(opts.port) : mgr.server.defaultPort;

      // Check decx-server.jar
      const jarPath = findDecxServerJar();
      const jarOk = jarPath !== null;
      const jarInfo = jarOk ? jarPath! : "Not found. Use 'decx self install' to install.";

      // Check running server
      const [serverOk, serverInfo] = await checkServer(port);

      // Check port availability
      const [portInUse] = await checkServer(port, 1);

      const results = {
        server: { ok: serverOk, info: serverInfo },
        jar: { ok: jarOk, info: jarInfo },
        port: { ok: !portInUse, info: portInUse ? `Port ${port} is already in use` : `Port ${port} is available` },
      };

      logCliEvent({ command: "process", action: "check", serverPort: port, ...results });
      fmt.output(results);
    });

  // open
  cmd
    .command("open <file>")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .description("Open and analyze a file (APK, DEX, JAR, etc.). Standard jadx-cli options are passed through.")
    .option("-P, --port <port>", "Server port")
    .option("--force", "Force start even if a session already exists")
    .option("-n, --name <name>", "Session name (default: APK filename without extension)")
    .action(async (filePath: string, opts) => {
      const fmt = new Formatter();
      try {
      fmt.output(await openAnalysisTarget(filePath, {
        port: opts.port,
        force: opts.force ?? false,
        name: opts.name,
        passthroughArgs: extractPassthroughArgs(),
      }));
      } catch (err) { handleCliError(err, fmt); }
    });

  // close
  cmd
    .command("close [name]")
    .description("Stop DECX server by session name or port")
    .option("-a, --all", "Kill all processes")
    .option("-P, --port <port>", "Server port")
    .action(async (name: string | undefined, opts) => {
      const fmt = new Formatter();
      try {
      const mgr = Manager.get();

      // Cleanup stale sessions on every close invocation
      const cleaned = mgr.cleanupDead();

      if (opts.all) {
        if (name || opts.port) {
          throw new ProcessError("Cannot combine --all with session name or --port");
        }
        const sessions = mgr.listAliveSessions();
        const killed: string[] = [], dead: string[] = [];
        for (const s of sessions) {
          const alive = await killProcessGroup(s.pid);
          mgr.removeSession(s.name);
          (alive ? killed : dead).push(s.name);
        }
        logCliEvent({ command: "process", action: "close", mode: "all", killed, dead });
        fmt.output({ cleaned, killed, dead });
        return;
      }

      if (name && opts.port) {
        throw new ProcessError("Cannot specify both session name and --port");
      }

      if (!name) {
        if (opts.port) {
          const port = parseInt(opts.port);
          if (Number.isNaN(port)) {
            throw new ProcessError(`Invalid port: ${opts.port}`);
          }
          const session = mgr.listAliveSessions().find((s) => s.port === port);
          if (!session) {
            throw new ProcessError(`Session not found on port: ${port}`);
          }
          name = session.name;
        } else {
          const alive = mgr.listAliveSessions();
          if (alive.length === 1) {
            name = alive[0].name;
          } else {
            throw new ProcessError(
              alive.length === 0
                ? "No running sessions"
                : "Specify session name, --port, or use --all"
            );
          }
        }
      }

      const session = mgr.getSession(name);
      if (!session) {
        throw new ProcessError(`Session not found: ${name}`);
      }

      const alive = await killProcessGroup(session.pid);
      mgr.removeSession(name);
      logCliEvent({ command: "process", action: "close", session: name, alive });
      fmt.output({ cleaned, killed: alive ? [name] : [], dead: alive ? [] : [name] });
      } catch (err) { handleCliError(err, fmt); }
    });

  // list
  cmd
    .command("list")
    .description("List running processes")
    .action(() => {
      const fmt = new Formatter();
      const mgr = Manager.get();

      // Cleanup stale sessions
      const cleaned = mgr.cleanupDead();
      const sessions = mgr.listAliveSessions();

      logCliEvent({ command: "process", action: "list", sessionCount: sessions.length, cleaned });
      fmt.output({ cleaned, sessions });
    });

  // status
  cmd
    .command("status [name]")
    .description("Check server status")
    .option("-P, --port <port>", "Server port", String)
    .action(async (name: string | undefined, opts) => {
      const fmt = new Formatter();
      try {
      const mgr = Manager.get();
      let port: number;

      if (name) {
        const session = mgr.getSession(name);
        if (!session) throw new ProcessError(`Session not found: ${name}`);
        port = session.port;
      } else if (opts.port) {
        port = parseInt(opts.port);
      } else {
        port = mgr.server.defaultPort;
      }

      const client = new DecxClient("127.0.0.1", port);
      try {
        const health = await client.healthCheck();
        logCliEvent({ command: "process", action: "status", session: name, port, ok: true });
        fmt.output({ ok: true, port, health });
      } catch (err) {
        throw new DecxError(String(err), "SERVER_ERROR", { port });
      }
      } catch (err) { handleCliError(err, fmt); }
    });

  return cmd;
}

/**
 * Check if DECX server is reachable on the given port.
 */
async function checkServer(port: number, retries: number = 3): Promise<[boolean, string]> {
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

async function waitForServer(port: number, timeout: number = 120, logPath?: string, shouldAbort?: () => boolean): Promise<boolean> {
  const start = Date.now();
  const deadline = timeout * 1000;
  const interval = 1000;
  const readyMarker = "DECX Server running at";

  while (Date.now() - start < deadline) {
    if (shouldAbort?.()) return false;

    // Primary: check log file for ready marker
    if (logPath) {
      try {
        const content = readFileSync(logPath, "utf-8");
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

    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

/**
 * Kill an entire process group (handles detached processes with children).
 * On Unix, uses negative PID to signal the process group.
 * On Windows, uses taskkill /T to kill the process tree.
 */
async function killProcessGroup(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return killProcessTreeWin(pid);
  }

  const tryKill = (sig: string) => {
    try {
      // Negative PID = kill entire process group (for detached: true)
      process.kill(-pid, sig as NodeJS.Signals);
      return true;
    }
    catch { return false; }
  };

  if (!tryKill("SIGTERM")) return false;

  const t1 = Date.now();
  while (Date.now() - t1 < 500) {
    try { process.kill(pid, 0); }
    catch { return true; }
    await new Promise(r => setTimeout(r, 50));
  }

  if (!tryKill("SIGKILL")) return false;

  const t2 = Date.now();
  while (Date.now() - t2 < 1000) {
    try { process.kill(pid, 0); }
    catch { return true; }
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

/**
 * Kill a process tree on Windows using taskkill.
 * First tries graceful kill (/T), then force kill (/T /F) as fallback.
 */
function killProcessTreeWin(pid: number): Promise<boolean> {
  const tryTaskkill = (force: boolean): boolean => {
    try {
      execSync(`taskkill /T${force ? " /F" : ""} /PID ${pid}`, { stdio: "ignore" });
      return true;
    } catch { return false; }
  };

  // Try graceful kill first
  tryTaskkill(false);

  return new Promise<boolean>(resolve => {
    const check = (deadline: number) => {
      try { process.kill(pid, 0); } catch { return resolve(true); }
      if (Date.now() > deadline) {
        // Force kill as last resort
        if (tryTaskkill(true)) {
          setTimeout(() => {
            try { process.kill(pid, 0); resolve(false); } catch { resolve(true); }
          }, 1000);
        } else {
          resolve(false);
        }
        return;
      }
      setTimeout(() => check(deadline), 50);
    };
    setTimeout(() => check(Date.now() + 2000), 500);
  });
}

const URL_RE = /^https?:\/\//i;

/**
 * Resolve file input: if it's a URL, download to the DECX tmp dir and return local path.
 * If it's a local path, return it as-is.
 */
async function resolveFileInput(input: string): Promise<string> {
  // Local file
  if (!URL_RE.test(input)) {
    return path.resolve(input);
  }

  // URL — download to DECX tmp dir
  const tmpDir = decxPath("tmp");
  mkdirSync(tmpDir, { recursive: true });

  // Derive filename from URL (prefix with URL hash to avoid collisions)
  const url = new URL(input);
  const urlHash = createHash("md5").update(input).digest("hex").slice(0, 8);
  let filename = path.basename(url.pathname);
  // Keep original extension if recognized
  if (!/\.(apk|dex|jar|class|aar)$/i.test(filename)) {
    filename = `${filename}_${urlHash}.bin`;
  } else {
    // Prefix with urlHash to prevent collision between different URLs with same filename
    filename = `${urlHash}_${filename}`;
  }
  const localPath = path.join(tmpDir, filename);

  // Skip if already downloaded
  if (existsSync(localPath)) {
    return localPath;
  }

  console.error(`  Downloading ${input} ...`);

  const response = await fetch(input, { redirect: "follow" });
  if (!response.ok) {
    throw new FileError(`Download failed: HTTP ${response.status}`, input);
  }

  const totalSize = Number(response.headers.get("content-length") || 0);
  const downloaded = await downloadWithProgress(
    response.body!, localPath, totalSize,
    { label: path.basename(input) }
  );
  console.error(`  Saved to ${localPath} (${formatBytes(downloaded)})`);

  return localPath;
}

/**
 * Extract non-DECX args from process.argv for passthrough to jadx-server.
 * Filters out DECX-specific flags and the file argument, keeping everything else
 * (standard jadx-cli options) for direct passthrough.
 */
function extractPassthroughArgs(): string[] {
  const cmdArgs = process.argv.slice(2); // skip node and script
  const openIdx = cmdArgs.indexOf("open");
  if (openIdx === -1) return [];

  const raw = cmdArgs.slice(openIdx + 1);
  const decxFlagsWithValue = ["-P", "--port", "-n", "--name"];
  const decxFlags = ["--force"];

  const result: string[] = [];
  let fileSkipped = false;
  let i = 0;

  while (i < raw.length) {
    const arg = raw[i];

    // Skip the first non-flag arg (file path)
    if (!fileSkipped && !arg.startsWith("-")) {
      fileSkipped = true;
      i++;
      continue;
    }

    // Skip DECX flags with values (--flag value or --flag=value)
    const isDecxWithValue = decxFlagsWithValue.some(
      (f) => arg === f || arg.startsWith(f + "=")
    );
    if (isDecxWithValue) {
      i += arg.includes("=") ? 1 : 2;
      continue;
    }

    // Skip DECX boolean flags
    if (decxFlags.includes(arg)) {
      i++;
      continue;
    }

    result.push(arg);
    i++;
  }

  return result;
}

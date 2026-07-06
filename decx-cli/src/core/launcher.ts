/**
 * Server process lifecycle: open targets, wait for startup, kill process groups.
 */

import { spawn, execSync } from "child_process";
import * as path from "path";
import { totalmem } from "os";
import { createServer } from "net";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "fs";
import { hashFile } from "../utils/hash.js";
import { FileError, ProcessError, ServerError } from "../utils/errors.js";
import { findDecxServerJar } from "./installer.js";
import { isSessionAlive } from "./session.js";
import { logCliEvent } from "../utils/logger.js";
import { decxPath } from "./paths.js";
import { Manager } from "./config.js";
import { resolveFileInput } from "./file-input.js";
import { MAX_SERVER_PORT, MIN_SERVER_PORT, parseServerPort } from "./ports.js";

export interface OpenAnalysisTargetOptions {
  port?: string;
  force?: boolean;
  name?: string;
  mcp?: boolean;
  passthroughArgs?: string[];
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
  return args;
}

export function normalizeJadxPassthroughArgs(args: string[] = []): string[] {
  const result = args.filter((arg) => arg !== "--deobf");
  if (!result.includes("--show-bad-code")) {
    result.push("--show-bad-code");
  }
  if (!result.includes("--no-imports")) {
    result.push("--no-imports");
  }
  if (!result.includes("-Pdex-input.verify-checksum=no")) {
    result.push("-Pdex-input.verify-checksum=no");
  }
  return result;
}

async function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function reserveRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new ProcessError("Failed to allocate a random port"));
        }
      });
    });
  });
}

export async function selectAvailableServerPort(
  preferredPort: number,
  mcp: boolean = false,
): Promise<number> {
  preferredPort = parseServerPort(preferredPort);

  if (await isServerPortAvailable(preferredPort, mcp)) {
    return preferredPort;
  }

  for (let i = 0; i < 20; i++) {
    const port = await reserveRandomPort();
    if (port < MIN_SERVER_PORT) continue;
    if (await isServerPortAvailable(port, mcp)) {
      return port;
    }
  }

  throw new ProcessError("Failed to find an available random port");
}

export async function isServerPortAvailable(
  port: number,
  mcp: boolean = false,
): Promise<boolean> {
  port = parseServerPort(port);
  if (mcp && port >= MAX_SERVER_PORT) return false;
  if (!await canBindPort(port)) return false;
  if (mcp && !await canBindPort(port + 1)) return false;
  return true;
}

export async function openAnalysisTarget(
  filePath: string,
  opts: OpenAnalysisTargetOptions = {},
): Promise<Record<string, unknown>> {
  const mgr = Manager.get();
  const requestedPort = parseServerPort(opts.port ?? mgr.server.defaultPort);

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

  const port = await selectAvailableServerPort(requestedPort, opts.mcp ?? false);
  const javaArgs = buildDecxServerJavaArgs(
    jarPath,
    resolvedFile,
    port,
    normalizeJadxPassthroughArgs(opts.passthroughArgs ?? []),
    opts.mcp,
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

  const session = await mgr.createSession(fileName, fileHash, resolvedFile, proc.pid, port);
  const timeout = 300; // seconds
  const ready = await waitForServer(port, timeout, logPath, () => processExited);
  if (ready) {
    logCliEvent({ command: "process", action: "open", session: session.name, pid: proc.pid, port, file: resolvedFile, mcp: opts.mcp ?? false });
    return { name: session.name, hash: session.hash, pid: proc.pid, port, file: resolvedFile, log: logPath, mcp: opts.mcp ?? false, mcpPort: opts.mcp ? port + 1 : undefined, reused: false };
  }

  mgr.removeSession(fileName);
  if (processExited) {
    throw new ServerError(`decx-server exited unexpectedly (code: ${processExitCode}). Check log: ${logPath}`, port);
  }
  throw new ServerError(`Server did not start within ${timeout}s on port ${port}`, port);
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
export async function killProcessGroup(pid: number): Promise<boolean> {
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

export function extractPassthroughArgs(argv: readonly string[] = process.argv): string[] {
  const cmdArgs = argv.slice(2);
  const openIdx = cmdArgs.indexOf("open");
  if (openIdx === -1) return [];

  const raw = cmdArgs.slice(openIdx + 1);
  const decxFlagsWithValue = ["-P", "--port", "-n", "--name"];
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

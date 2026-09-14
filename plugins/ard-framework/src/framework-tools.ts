/**
 * External tool resolution for framework APEX extraction.
 *
 * No packaged binaries and no platform delegation: `debugfs`/erofs-utils are
 * resolved from PATH (with optional `DECX_DEBUGFS` / `DECX_EXTRACT_EROFS` /
 * `DECX_FSCK_EROFS` overrides). The native ext4/EROFS readers handle every
 * layout apexer/mkfs.erofs produce; the external tools are only resolved
 * lazily when a payload actually needs them, and they are Linux/macOS-only —
 * Windows gets an explicit "run on Linux/macOS" error instead.
 */
const { accessSync, constants, existsSync } = require("fs");
const { spawnSync } = require("child_process");
const path = require("path");
const { ToolError } = require("./errors.js");

const DEBUGFS_ENV = "DECX_DEBUGFS";
const EXTRACT_EROFS_ENV = "DECX_EXTRACT_EROFS";
const FSCK_EROFS_ENV = "DECX_FSCK_EROFS";

const DEBUGFS_MISSING =
  "debugfs not found. Install e2fsprogs (e.g. 'apt install e2fsprogs') so debugfs is on PATH.";
const DEBUGFS_MISSING_WIN32 =
  "ext4 feature not supported by the native reader and debugfs has no native Windows binary. " +
  "Run 'framework process' on Linux/macOS (e2fsprogs) to unpack this payload.";
const EROFS_MISSING =
  "No EROFS extractor found. Install fsck.erofs/extract.erofs (erofs-utils).";
const EROFS_MISSING_WIN32 =
  "EROFS payload images need erofs-utils, which has no native Windows binary. " +
  "Run 'framework process' on Linux/macOS (erofs-utils) to unpack this payload.";

/** Options accepted by a tool runner (a subset of `spawnSync` options). */
interface ToolRunOptions {
  timeoutMs?: number;
  input?: string;
}

/** Captured result of one tool invocation. */
interface ToolRunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Platform/env/runner bundle used by every PATH lookup. */
interface ToolContext {
  platform: string;
  env: NodeJS.ProcessEnv;
  run: (argv: string[], options?: ToolRunOptions) => ToolRunResult;
}

/** A resolved external tool; `argv` is spawned as-is. */
interface ResolvedTool {
  argv: string[];
}

export function defaultToolRun(argv: string[], options: ToolRunOptions = {}): ToolRunResult {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf-8",
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
    input: options.input,
  });
  if (result.error) {
    return { stdout: "", stderr: result.error.message, status: null };
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

export function defaultToolContext(env: NodeJS.ProcessEnv = process.env): ToolContext {
  return { platform: process.platform, env, run: defaultToolRun };
}

function isWindows(ctx: ToolContext): boolean {
  return ctx.platform === "win32";
}

/** PATH lookup without shelling out; returns the resolved executable or null. */
export function findExecutable(name: string, ctx: ToolContext): string | null {
  const candidates = isWindows(ctx) ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  const entries = (ctx.env.PATH ?? "").split(isWindows(ctx) ? ";" : ":").filter(Boolean);
  for (const entry of entries) {
    for (const candidate of candidates) {
      const full = path.join(entry, candidate);
      try {
        accessSync(full, isWindows(ctx) ? constants.F_OK : constants.X_OK);
        return full;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function pathTool(executablePath: string): ResolvedTool {
  return { argv: [executablePath] };
}

/** Resolve `debugfs` from PATH (or the `DECX_DEBUGFS` override). */
export function resolveDebugfsTool(ctx: ToolContext = defaultToolContext()): ResolvedTool {
  const explicit = ctx.env[DEBUGFS_ENV];
  if (explicit) return pathTool(explicit);
  const onPath = findExecutable("debugfs", ctx);
  if (onPath) return pathTool(onPath);
  throw new ToolError(
    isWindows(ctx) ? DEBUGFS_MISSING_WIN32 : DEBUGFS_MISSING,
    "TOOL_NOT_FOUND",
  );
}

/**
 * Resolve an EROFS extractor. `DECX_FSCK_EROFS`/`DECX_EXTRACT_EROFS` pin the
 * respective binaries; otherwise PATH is consulted (fsck.erofs preferred over
 * extract.erofs).
 */
export function resolveErofsTool(ctx: ToolContext = defaultToolContext()): ResolvedTool {
  const explicitName = ctx.env[FSCK_EROFS_ENV];
  if (explicitName) return pathTool(explicitName);
  const explicitExtractName = ctx.env[EXTRACT_EROFS_ENV];
  if (explicitExtractName) return pathTool(explicitExtractName);

  for (const name of ["fsck.erofs", "extract.erofs"]) {
    const onPath = findExecutable(name, ctx);
    if (onPath) return pathTool(onPath);
  }
  throw new ToolError(isWindows(ctx) ? EROFS_MISSING_WIN32 : EROFS_MISSING, "TOOL_NOT_FOUND");
}

/** Basename of the executable inside a resolved tool argv. */
export function toolExecutableName(tool: ResolvedTool): string {
  const last = tool.argv[tool.argv.length - 1] ?? "";
  return path.basename(last.replace(/\\/g, "/"));
}

/** fsck.erofs and extract.erofs take different extraction flags. */
export function isFsckErofs(tool: ResolvedTool): boolean {
  return toolExecutableName(tool) === "fsck.erofs";
}

export function isErofsTool(tool: ResolvedTool): boolean {
  return toolExecutableName(tool).includes("erofs");
}

/** Run a resolved tool. */
export function runFrameworkTool(
  tool: ResolvedTool,
  args: string[],
  options: ToolRunOptions = {},
  ctx: ToolContext = defaultToolContext(),
): ToolRunResult {
  if (tool.argv.length === 0) {
    throw new ToolError("framework tool is not resolved", "TOOL_NOT_FOUND");
  }
  return ctx.run([...tool.argv, ...args], options);
}

export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

module.exports = {
  defaultToolRun,
  defaultToolContext,
  findExecutable,
  resolveDebugfsTool,
  resolveErofsTool,
  toolExecutableName,
  isFsckErofs,
  isErofsTool,
  runFrameworkTool,
  fileExists,
};

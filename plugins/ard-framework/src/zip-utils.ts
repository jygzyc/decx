/**
 * Cross-platform zip/jar helpers.
 *
 * Port of the former CLI `android/zip-utils.ts` with the packaged-tool
 * fallbacks removed: no bundled binaries are used any more, so the tools are
 * resolved from PATH.
 *
 * * Windows: Windows 10+ ships bsdtar (libarchive) at C:\Windows\System32\tar.exe,
 *   which reads and writes zip archives; `zip`/`unzip` are not required.
 * * Other platforms: the standard Info-ZIP `unzip`/`zip` binaries from PATH.
 */
const { closeSync, existsSync, openSync, rmSync } = require("fs");
const { spawnSync } = require("child_process");
const { FileError } = require("./errors.js");

const WINDOWS_BSD_TAR = "C:\\Windows\\System32\\tar.exe";

/** Resolved zip implementation: bsdtar on Windows, Info-ZIP elsewhere. */
type ZipTool = { kind: "bsdtar"; bin: string } | { kind: "infozip" };

/** Minimal `spawnSync` result shape inspected by `ensureSuccess`. */
interface ZipToolResult {
  error?: Error | null;
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}

function resolveZipTool(): ZipTool {
  if (process.platform === "win32" && existsSync(WINDOWS_BSD_TAR)) {
    return { kind: "bsdtar", bin: WINDOWS_BSD_TAR };
  }
  return { kind: "infozip" };
}

/**
 * Explain a failed tool spawn. A missing Info-ZIP binary (common on minimal
 * Linux installs) gets an actionable hint naming the binary and its packages
 * instead of the raw `spawnSync unzip ENOENT` message.
 */
function toolSpawnMessage(error: Error, bin: string): string {
  if ((error as { code?: string }).code === "ENOENT") {
    return (
      `required tool '${bin}' was not found on PATH; install the '${bin}' package ` +
      `('apt install ${bin}' on Debian/Ubuntu, 'brew install ${bin}' on macOS)`
    );
  }
  return error.message;
}

/** Throw a FileError when a zip tool invocation failed. */
function ensureSuccess(result: ZipToolResult, label: string, bin: string): void {
  if (result.error) {
    throw new FileError(`${label}: ${toolSpawnMessage(result.error, bin)}`);
  }
  if (result.status !== 0) {
    throw new FileError(
      result.stderr?.toString().trim() || result.stdout?.toString().trim() || `${label} failed`,
    );
  }
}

/** List entry names in a zip/jar archive (one per line). */
export function listZipEntries(archivePath: string): string[] {
  const tool = resolveZipTool();
  const result =
    tool.kind === "bsdtar"
      ? spawnSync(tool.bin, ["-tf", archivePath], { encoding: "utf-8" })
      : spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf-8" });
  ensureSuccess(result, `Failed to list '${archivePath}'`, tool.kind === "bsdtar" ? tool.bin : "unzip");
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter(Boolean);
}

/**
 * Extract a single zip/jar entry to a file, streaming through a file descriptor
 * so large entries never hit spawnSync's maxBuffer limit.
 */
export function extractZipEntry(archivePath: string, entryName: string, targetPath: string): void {
  const outputFd = openSync(targetPath, "w");
  try {
    const tool = resolveZipTool();
    const result =
      tool.kind === "bsdtar"
        ? spawnSync(tool.bin, ["-xOf", archivePath, entryName], { stdio: ["ignore", outputFd, "pipe"] })
        : spawnSync("unzip", ["-p", archivePath, entryName], { stdio: ["ignore", outputFd, "pipe"] });
    if (result.error) {
      throw new FileError(
        `Failed to read '${entryName}' from ${archivePath}: ${toolSpawnMessage(
          result.error,
          tool.kind === "bsdtar" ? tool.bin : "unzip",
        )}`,
      );
    }
    if (result.status !== 0) {
      throw new FileError(
        result.stderr?.toString().trim() || `Failed to extract '${entryName}' from ${archivePath}`,
      );
    }
  } catch (error) {
    rmSync(targetPath, { force: true });
    throw error;
  } finally {
    closeSync(outputFd);
  }
}

/**
 * Read a single zip/jar entry as UTF-8 text. Intended for small entries such as
 * manifests; large binary entries should use extractZipEntry.
 */
export function readZipEntryText(archivePath: string, entryName: string): string {
  const tool = resolveZipTool();
  const result =
    tool.kind === "bsdtar"
      ? spawnSync(tool.bin, ["-xOf", archivePath, entryName], { encoding: "utf-8" })
      : spawnSync("unzip", ["-p", archivePath, entryName], { encoding: "utf-8" });
  ensureSuccess(
    result,
    `Failed to read '${entryName}' from ${archivePath}`,
    tool.kind === "bsdtar" ? tool.bin : "unzip",
  );
  return result.stdout ?? "";
}

/**
 * Create a zip/jar archive from the given files and/or directories.
 * `entries` are resolved relative to `cwd`. An existing archive is replaced,
 * so a run never merges entries into a stale package (Info-ZIP would).
 */
export function createZipArchive(archivePath: string, entries: string[], cwd: string): void {
  const tool = resolveZipTool();
  rmSync(archivePath, { force: true });
  const result =
    tool.kind === "bsdtar"
      ? spawnSync(tool.bin, ["--format=zip", "-cf", archivePath, ...entries], { cwd, encoding: "utf-8" })
      : spawnSync("zip", ["-q", "-r", archivePath, ...entries], { cwd, encoding: "utf-8" });
  ensureSuccess(result, `Failed to create '${archivePath}'`, tool.kind === "bsdtar" ? tool.bin : "zip");
}

module.exports = { listZipEntries, extractZipEntry, readZipEntryText, createZipArchive };

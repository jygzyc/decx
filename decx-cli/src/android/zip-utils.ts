import { closeSync, existsSync, openSync, rmSync } from "fs";
import { spawnSync, type SpawnSyncReturns } from "child_process";
import { FileError } from "../utils/errors.js";

/**
 * Cross-platform zip/jar helpers.
 *
 * On Windows there is no `zip`/`unzip` binary, but Windows 10+ ships bsdtar
 * (libarchive) at C:\Windows\System32\tar.exe which reads and writes zip
 * archives. On other platforms the standard Info-ZIP binaries are used.
 */

const WINDOWS_BSD_TAR = "C:\\Windows\\System32\\tar.exe";

type ZipTool =
  | { kind: "bsdtar"; bin: string }
  | { kind: "infozip" };

function resolveZipTool(): ZipTool {
  if (process.platform === "win32" && existsSync(WINDOWS_BSD_TAR)) {
    return { kind: "bsdtar", bin: WINDOWS_BSD_TAR };
  }
  return { kind: "infozip" };
}

/** Throw a FileError when a zip tool invocation failed. */
function ensureSuccess(result: SpawnSyncReturns<string | Buffer>, label: string): void {
  if (result.error) {
    throw new FileError(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new FileError(
      result.stderr?.toString().trim() || result.stdout?.toString().trim() || `${label} failed`,
    );
  }
}

/**
 * List entry names in a zip/jar archive (one per line).
 */
export function listZipEntries(archivePath: string): string[] {
  const tool = resolveZipTool();
  const result =
    tool.kind === "bsdtar"
      ? spawnSync(tool.bin, ["-tf", archivePath], { encoding: "utf-8" })
      : spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf-8" });
  ensureSuccess(result, `Failed to list '${archivePath}'`);
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
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
        `Failed to read '${entryName}' from ${archivePath}: ${result.error.message}`,
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
  ensureSuccess(result, `Failed to read '${entryName}' from ${archivePath}`);
  return result.stdout ?? "";
}

/**
 * Create a zip/jar archive from the given files and/or directories.
 * `entries` are resolved relative to `cwd`.
 */
export function createZipArchive(archivePath: string, entries: string[], cwd: string): void {
  const tool = resolveZipTool();
  const result =
    tool.kind === "bsdtar"
      ? spawnSync(tool.bin, ["--format=zip", "-cf", archivePath, ...entries], { cwd, encoding: "utf-8" })
      : spawnSync("zip", ["-q", "-r", archivePath, ...entries], { cwd, encoding: "utf-8" });
  ensureSuccess(result, `Failed to create '${archivePath}'`);
}

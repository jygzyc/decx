import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawnSync } from "child_process";
import { FileError } from "../utils/errors.js";
import { decxPath } from "../core/paths.js";
import type {
  FrameworkToolsCheck,
  FrameworkToolPaths,
  ToolCheckResult,
} from "./types.js";

const archiveCacheKeys = new Map<string, string>();

function assertSupportedFrameworkPlatform(): void {
  if (process.platform === "win32") {
    throw new FileError("Windows is not supported for 'decx ard framework' yet.");
  }
}

function commandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { encoding: "utf-8" });
  return result.status === 0;
}

function currentArchDir(): string {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return process.platform === "darwin" ? "x86_64" : "x86_64";
  if (process.arch === "arm") return "aarch64";
  return process.arch;
}

function packagedBinPath(...parts: string[]): string {
  const entryDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(entryDir, "bin", ...parts),
    path.join(path.resolve(entryDir, ".."), "bin", ...parts),
  ];

  for (const rawPath of candidates) {
    if (existsSync(rawPath)) return rawPath;
  }

  const extracted = extractPackagedBinArchive(parts);
  return extracted ?? candidates[0];
}

function extractPackagedBinArchive(parts: string[]): string | null {
  const entryDir = path.dirname(fileURLToPath(import.meta.url));
  const archiveCandidates = [
    path.join(entryDir, "bin.tar.gz"),
    path.join(path.resolve(entryDir, ".."), "bin.tar.gz"),
  ];
  const archive = archiveCandidates.find((candidate) => existsSync(candidate));
  if (!archive) return null;

  const cacheDir = decxPath("cache", "bin", "decx-cli", archiveCacheKey(archive));
  const cacheFile = path.join(cacheDir, ...parts);
  if (!existsSync(cacheFile)) {
    mkdirSync(cacheDir, { recursive: true });
    try {
      execFileSync("tar", ["-xzf", archive, "-C", cacheDir], { stdio: "ignore" });
    } catch {
      throw new FileError(`Failed to extract packaged binaries from ${archive}`);
    }
  }
  return existsSync(cacheFile) ? cacheFile : null;
}

function archiveCacheKey(archive: string): string {
  const cached = archiveCacheKeys.get(archive);
  if (cached) return cached;
  const key = createHash("sha256").update(readFileSync(archive)).digest("hex").slice(0, 16);
  archiveCacheKeys.set(archive, key);
  return key;
}

function resolvePackagedErofsExtractor(): string | null {
  const platformDir =
    process.platform === "darwin" ? "darwin" :
    process.platform === "linux" ? "linux" :
    null;
  if (!platformDir) return null;

  const candidate = packagedBinPath(platformDir, currentArchDir(), "extract.erofs");
  if (!existsSync(candidate)) return null;
  try {
    chmodSync(candidate, 0o755);
  } catch {
    // Best effort.
  }
  return candidate;
}

function resolveDebugfs(): string | null {
  if (commandExists("debugfs")) return "debugfs";
  if (process.platform !== "linux") return null;

  const candidate = packagedBinPath("linux", currentArchDir(), "debugfs");
  if (!existsSync(candidate)) return null;
  try {
    chmodSync(candidate, 0o755);
  } catch {
    // Best effort.
  }
  return candidate;
}

function resolveAdb(adbPath?: string): string {
  if (adbPath) return adbPath;
  if (commandExists("adb")) return "adb";
  throw new FileError("adb not found. Use --adb-path or install Android platform-tools.");
}

function resolveErofsExtractor(): string {
  if (commandExists("fsck.erofs")) return "fsck.erofs";
  if (commandExists("extract.erofs")) return "extract.erofs";
  const packaged = resolvePackagedErofsExtractor();
  if (packaged) return packaged;
  throw new FileError("No EROFS extractor found. Install fsck.erofs/extract.erofs or use the packaged binary.");
}

export function resolveFrameworkTools(adbPath?: string): FrameworkToolPaths {
  assertSupportedFrameworkPlatform();
  const debugfs = resolveDebugfs();
  if (!debugfs) {
    throw new FileError("debugfs not found. Install e2fsprogs and ensure debugfs is on PATH.");
  }

  return {
    adb: resolveAdb(adbPath),
    debugfs,
    erofsExtractor: resolveErofsExtractor(),
  };
}

function makeToolCheck(pathValue: string | null, detail: string): ToolCheckResult {
  return {
    ok: pathValue !== null,
    path: pathValue,
    detail,
  };
}

export function checkFrameworkTools(adbPath?: string): FrameworkToolsCheck {
  if (process.platform === "win32") {
    return {
      adb: makeToolCheck(adbPath ?? null, "Windows is not supported for 'decx ard framework' yet."),
      debugfs: makeToolCheck(null, "Windows is not supported for 'decx ard framework' yet."),
      erofsExtractor: makeToolCheck(null, "Windows is not supported for 'decx ard framework' yet."),
    };
  }

  const adbResolved = adbPath ?? (commandExists("adb") ? "adb" : null);
  const debugfs = resolveDebugfs();
  const erofs = (commandExists("fsck.erofs") ? "fsck.erofs" : null)
    ?? (commandExists("extract.erofs") ? "extract.erofs" : null)
    ?? resolvePackagedErofsExtractor();

  return {
    adb: makeToolCheck(adbResolved, adbResolved ? "adb is available" : "adb not found"),
    debugfs: makeToolCheck(debugfs, debugfs ? "debugfs is available" : "debugfs not found"),
    erofsExtractor: makeToolCheck(erofs, erofs ? "EROFS extractor is available" : "EROFS extractor not found"),
  };
}

export function ensureDirectory(dir: string): string {
  const resolved = path.resolve(dir);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function defaultFrameworkRoot(): string {
  return decxPath("output", "framework");
}

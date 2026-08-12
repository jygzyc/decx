import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawnSync } from "child_process";
import { FileError } from "../utils/errors.js";
import { decxPath } from "../core/paths.js";
import type { FrameworkTool, FrameworkToolPaths } from "./types.js";

const archiveCacheKeys = new Map<string, string>();

function commandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { encoding: "utf-8" });
  return result.status === 0;
}

function currentArchDir(): string {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  if (process.arch === "arm") return "aarch64";
  return process.arch;
}

// ── WSL helpers ────────────────────────────────────────────────────────────
// `decx android framework` extracts APEX filesystem images with debugfs and
// erofs-utils, which have no native Windows binaries. On Windows those tools are
// delegated to WSL, and Windows absolute paths in their arguments are translated
// to the matching /mnt/<drive>/... paths.

function wslRun(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("wsl.exe", args, { encoding: "utf-8" });
  return { ok: !result.error && result.status === 0, stdout: (result.stdout ?? "").trim() };
}

function wslAvailable(): boolean {
  return process.platform === "win32" && wslRun(["-e", "sh", "-c", "exit 0"]).ok;
}

function wslHasCommand(command: string): boolean {
  return wslRun(["-e", "sh", "-c", `command -v ${command}`]).ok;
}

function windowsPathToWsl(p: string): string {
  const match = p.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return p;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

export { windowsPathToWsl };

/** Translate Windows absolute paths (standalone or embedded in flag values). */
export function translateWslArgs(args: string[]): string[] {
  return args.map((arg) => arg.replace(/[A-Za-z]:[\\/][^\s"'`]+/g, windowsPathToWsl));
}

// ── Packaged native binaries ───────────────────────────────────────────────

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
      // Prefer bsdtar on Windows (GNU tar from Git Bash misparses `E:\...` paths).
      const tarBin =
        process.platform === "win32" && existsSync("C:\\Windows\\System32\\tar.exe")
          ? "C:\\Windows\\System32\\tar.exe"
          : "tar";
      execFileSync(tarBin, ["-xzf", archive, "-C", cacheDir], { stdio: "ignore" });
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

function resolvePackagedErofsExtractor(platformDir: string): string | null {
  const candidate = packagedBinPath(platformDir, currentArchDir(), "extract.erofs");
  if (!existsSync(candidate)) return null;
  try {
    chmodSync(candidate, 0o755);
  } catch {
    // Best effort.
  }
  return candidate;
}

// ── Tool resolution ────────────────────────────────────────────────────────

function resolveDebugfs(wslOk: boolean): FrameworkTool {
  if (commandExists("debugfs")) {
    return { argv: ["debugfs"] };
  }

  if (process.platform === "win32") {
    if (wslOk && wslHasCommand("debugfs")) {
      return { argv: ["wsl.exe", "-e", "debugfs"], translatePaths: true };
    }
    throw new FileError(
      "debugfs not found. On Windows, 'decx android framework' runs its Linux-only tools in WSL: " +
        "install WSL and make sure debugfs is available there (e.g. 'sudo apt install e2fsprogs').",
    );
  }

  const packaged = packagedBinPath("linux", currentArchDir(), "debugfs");
  if (existsSync(packaged)) {
    try {
      chmodSync(packaged, 0o755);
    } catch {
      // Best effort.
    }
    return { argv: [packaged] };
  }

  throw new FileError(
    "debugfs not found. Install e2fsprogs (e.g. 'apt install e2fsprogs') so debugfs is on PATH.",
  );
}

function resolveErofsExtractor(wslOk: boolean): FrameworkTool {
  if (commandExists("fsck.erofs")) {
    return { argv: ["fsck.erofs"] };
  }
  if (commandExists("extract.erofs")) {
    return { argv: ["extract.erofs"] };
  }

  if (process.platform === "win32") {
    if (!wslOk) {
      throw new FileError(
        "Windows requires WSL for 'decx android framework' (it needs Linux-only erofs-utils). " +
          "Install WSL (wsl --install) or run this command on Linux/macOS.",
      );
    }
    if (wslHasCommand("fsck.erofs")) {
      return { argv: ["wsl.exe", "-e", "fsck.erofs"], translatePaths: true };
    }
    if (wslHasCommand("extract.erofs")) {
      return { argv: ["wsl.exe", "-e", "extract.erofs"], translatePaths: true };
    }
    // Fall back to the packaged Linux x86_64 extract.erofs, run through WSL.
    const packaged = packagedBinPath("linux", "x86_64", "extract.erofs");
    if (existsSync(packaged)) {
      return { argv: ["wsl.exe", windowsPathToWsl(packaged)], translatePaths: true };
    }
    throw new FileError(
      "No EROFS extractor found. On Windows, install erofs-utils in WSL " +
        "(e.g. 'sudo apt install erofs-utils') or run this command on Linux/macOS.",
    );
  }

  const platformDir = process.platform === "darwin" ? "darwin" : "linux";
  const packaged = resolvePackagedErofsExtractor(platformDir);
  if (packaged) {
    return { argv: [packaged] };
  }

  throw new FileError(
    "No EROFS extractor found. Install fsck.erofs/extract.erofs (erofs-utils) or use the packaged binary.",
  );
}

function resolveAdb(adbPath?: string): string {
  if (adbPath) return adbPath;
  if (commandExists("adb")) return "adb";
  throw new FileError("adb not found. Use --adb-path or install Android platform-tools.");
}

export function resolveFrameworkTools(
  adbPath?: string,
  options: { wslAvailable?: boolean } = {},
): FrameworkToolPaths {
  // On Windows the filesystem-image tools (debugfs, erofs-utils) have no native
  // binaries; they are delegated to WSL. Require WSL up front with a clear error.
  const wslOk = options.wslAvailable ?? wslAvailable();
  if (process.platform === "win32" && !wslOk) {
    throw new FileError(
      "Windows requires WSL for 'decx android framework': it needs Linux-only debugfs/erofs-utils " +
        "to extract APEX filesystem images. Install WSL (wsl --install) or run this command on Linux/macOS.",
    );
  }

  return {
    adb: resolveAdb(adbPath),
    debugfs: resolveDebugfs(wslOk),
    erofsExtractor: resolveErofsExtractor(wslOk),
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

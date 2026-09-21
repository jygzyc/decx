import { mkdirSync } from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { FileError } from "../utils/errors.js";
import { decxPath } from "../core/paths.js";
import type { FrameworkTool, FrameworkToolPaths } from "./types.js";

function commandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { encoding: "utf-8" });
  return result.status === 0;
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

/**
 * Resolve `command` to its absolute path inside the default WSL distro, or
 * null when it is unavailable.
 *
 * The absolute path is required, not cosmetic: on some WSL builds the relay
 * resolves bare command names (`wsl.exe -e debugfs`) against a PATH that
 * misses /usr/sbin, so exec fails with "execvpe(debugfs) failed: No such file
 * or directory" even though the binary is installed and `command -v` inside
 * sh finds it. Executing the resolved absolute path sidesteps that lookup.
 */
function wslResolveCommand(command: string): string | null {
  const { ok, stdout } = wslRun(["-e", "sh", "-c", `command -v ${command}`]);
  if (!ok) return null;
  const resolved = stdout.trim().split("\n").pop()?.trim() ?? "";
  return resolved.startsWith("/") ? resolved : null;
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

// ── Tool resolution ────────────────────────────────────────────────────────

function resolveDebugfs(wslOk: boolean): FrameworkTool {
  if (commandExists("debugfs")) {
    return { argv: ["debugfs"] };
  }

  if (process.platform === "win32") {
    const resolved = wslOk ? wslResolveCommand("debugfs") : null;
    if (resolved) {
      return { argv: ["wsl.exe", "-e", resolved], translatePaths: true };
    }
    throw new FileError(
      "debugfs not found. On Windows, 'decx android framework' runs its Linux-only tools in WSL: " +
        "install WSL and make sure debugfs is available there (e.g. 'sudo apt install e2fsprogs').",
    );
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
    const fsck = wslResolveCommand("fsck.erofs");
    if (fsck) {
      return { argv: ["wsl.exe", "-e", fsck], translatePaths: true };
    }
    const extract = wslResolveCommand("extract.erofs");
    if (extract) {
      return { argv: ["wsl.exe", "-e", extract], translatePaths: true };
    }
    throw new FileError(
      "No EROFS extractor found. On Windows, install erofs-utils in WSL " +
        "(e.g. 'sudo apt install erofs-utils') or run this command on Linux/macOS.",
    );
  }

  throw new FileError(
    "No EROFS extractor found. Install fsck.erofs/extract.erofs (erofs-utils).",
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

/**
 * Resolve only adb, for framework commands that never extract APEX filesystem
 * images. Collect pulls ready-made jars from the /apex mount, and process only
 * needs the image tools when .apex/.capex inputs are present (see
 * hasApexImageInputs). The image tools are stubs that must never be spawned.
 */
export function resolveAdbOnlyTools(adbPath?: string): FrameworkToolPaths {
  const neverSpawned: FrameworkTool = { argv: [] };
  return { adb: resolveAdb(adbPath), debugfs: neverSpawned, erofsExtractor: neverSpawned };
}

export function ensureDirectory(dir: string): string {
  const resolved = path.resolve(dir);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function defaultFrameworkRoot(): string {
  return decxPath("output", "framework");
}

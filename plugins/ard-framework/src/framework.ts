/**
 * Framework layout and artifact naming helpers.
 *
 * Port of the Go `android.ResolveLayout` plus the artifact summary helpers from
 * `internal/cli/local_commands.go`. The plugin only collects and packs: it
 * never opens, describes or names a session — that stays a CLI concern
 * (`decx session open`).
 */
import type { AdbClient as AdbClientType } from "./adb";
import type {
  ArtifactSummary,
  FrameworkArtifact,
  FrameworkLayout,
  FrameworkLayoutRequest,
  PluginArgs,
} from "./types";

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const path = require("path");
const { AdbClient } = require("./adb.js");
const { DecxError } = require("./errors.js");
const { isInsideDir } = require("./framework-collector.js");

const BAD_SEGMENT = /[^a-z0-9._-]+/g;

/** Lowercase, non `[a-z0-9._-]` runs collapse to `_`, trimmed, never empty. */
function segment(value: string): string {
  const normalized = value.toLowerCase().replace(BAD_SEGMENT, "_").replace(/^[._-]+|[._-]+$/g, "");
  return normalized === "" ? "unknown" : normalized;
}

/** Reads `outDir/.artifact.json`; malformed files are reported, not ignored. */
function readFrameworkArtifact(outDir: string): FrameworkArtifact | null {
  const file = path.join(outDir, ".artifact.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as FrameworkArtifact;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DecxError(`invalid .artifact.json: ${message}`, "INVALID_ARTIFACT", { filePath: file });
  }
}

/**
 * Resolves the collection/processing layout: OEM and vendor come from the
 * explicit flags, the recorded artifact, or the connected device (in that
 * order). The artifact record is written on every successful resolution.
 */
function resolveFrameworkLayout(request: FrameworkLayoutRequest): FrameworkLayout {
  let outDir = request.outDir ? path.resolve(request.outDir) : "";
  const previous = outDir === "" ? null : readFrameworkArtifact(outDir);
  let oem = request.oem ?? "";
  let vendor = request.vendor ?? "";
  if (oem === "" && previous) oem = previous.oem ?? "";
  if (vendor === "" && previous) vendor = previous.vendor ?? "";

  if (request.adb !== null && request.adb !== undefined && (request.device || oem === "" || vendor === "" || vendor === "unknown")) {
    let selected = false;
    try {
      request.adb.select();
      selected = true;
    } catch (error) {
      const ambiguous = error instanceof DecxError && error.code === "ADB_DEVICE_AMBIGUOUS";
      if (request.device || request.serialRequested || ambiguous) throw error;
    }
    if (selected) {
      if (oem === "") oem = request.adb.oem();
      if (vendor === "" || vendor === "unknown") vendor = request.adb.vendor();
    }
  }

  if (oem === "") {
    throw new DecxError(
      "specify --oem for offline processing or provide .artifact.json at --out-dir",
      "MISSING_OEM",
    );
  }
  oem = segment(oem);
  vendor = segment(vendor);
  if (outDir === "") {
    outDir = path.resolve(path.join(request.home, "output", "framework", oem));
  }
  const sourceDir = request.sourceDir
    ? path.resolve(request.sourceDir)
    : path.join(outDir, "source");
  const outTmpDir = path.join(outDir, "out_tmp");
  // Output nesting inside inputs can recursively process its own generated jars.
  if (sourceDir === outDir || isInsideDir(sourceDir, outTmpDir) || isInsideDir(sourceDir, outDir)) {
    throw new DecxError("framework output must not be inside the source directory", "INVALID_LAYOUT");
  }

  const name = `framework_${oem}_${vendor}`;
  const artifact: FrameworkArtifact = {
    name,
    oem,
    vendor,
    rootDir: outDir,
    jarPath: path.join(outDir, `${name}.jar`),
    updatedAt: Date.now(),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, ".artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  return { sourceDir, outDir, outTmpDir, artifact };
}

/** `{session, oem, vendor, jarPath}` summary printed by the CLI. */
function summarizeArtifact(layout: FrameworkLayout): ArtifactSummary {
  return {
    session: layout.artifact.name,
    oem: layout.artifact.oem,
    vendor: layout.artifact.vendor,
    jarPath: layout.artifact.jarPath,
  };
}

/** Single-value flag accessor: last value wins for repeatable flags. */
function argValue(args: PluginArgs, ...ids: string[]): string | undefined {
  for (const id of ids) {
    const value = args[id];
    if (value === undefined) continue;
    return Array.isArray(value) ? value[value.length - 1] : value;
  }
  return undefined;
}

/** Boolean flag accessor accepting `""`, `"true"`, `"1"`, `"yes"`. */
function argFlag(args: PluginArgs, ...ids: string[]): boolean {
  for (const id of ids) {
    const value = args[id];
    if (value === undefined) continue;
    const raw = (Array.isArray(value) ? value[value.length - 1] : value).trim().toLowerCase();
    return raw === "" || raw === "true" || raw === "1" || raw === "yes";
  }
  return false;
}

/** adb executable: explicit flag, then DECX_ADB, then `adb` on PATH. */
function adbPathFrom(args: PluginArgs, env: NodeJS.ProcessEnv): string {
  return argValue(args, "adb-path") ?? env.DECX_ADB ?? "adb";
}

/** Creates an adb client from the command flags (no device selection yet). */
function createAdbClient(args: PluginArgs, env: NodeJS.ProcessEnv): AdbClientType {
  return new AdbClient({ adbPath: adbPathFrom(args, env), serial: argValue(args, "serial") });
}

/**
 * adb client for framework commands. Offline processing is valid, so an
 * unusable device is only fatal when `required` (or when the caller pinned a
 * device with --adb-path/--serial).
 */
function frameworkDevice(args: PluginArgs, env: NodeJS.ProcessEnv, required: boolean): AdbClientType | null {
  const client = createAdbClient(args, env);
  try {
    client.ensureAvailable();
    client.select();
    return client;
  } catch (error) {
    if (required || argValue(args, "adb-path") !== undefined || argValue(args, "serial") !== undefined) {
      throw error;
    }
    return null;
  }
}

/** Device commands always need a usable, selected device. */
function requiredDevice(args: PluginArgs, env: NodeJS.ProcessEnv): AdbClientType {
  const client = createAdbClient(args, env);
  client.ensureAvailable();
  client.select();
  return client;
}

module.exports = {
  segment,
  readFrameworkArtifact,
  resolveFrameworkLayout,
  summarizeArtifact,
  argValue,
  argFlag,
  adbPathFrom,
  createAdbClient,
  frameworkDevice,
  requiredDevice,
};

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { FileError } from "../utils/errors.js";
import { extractZipEntry, listZipEntries } from "./zip-utils.js";
import { Ext4Image, NotExt4ImageError, UnsupportedImageFeatureError as Ext4Unsupported } from "./ext4-reader.js";
import { ErofsImage, NotErofsImageError, UnsupportedImageFeatureError as ErofsUnsupported } from "./erofs-reader.js";
import { translateWslArgs } from "./framework-tools.js";
import type {
  FrameworkPathLayout,
  FrameworkProcessResult,
  FrameworkTool,
  FrameworkToolPaths,
} from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([".apk", ".jar", ".apex", ".capex", ".dex"]);
/** File types extracted from apex payload images (native ext4 path + tool path). */
const APEX_PAYLOAD_EXTENSIONS = new Set([".jar", ".apk", ".dex"]);
const DEFAULT_PROCESS_CONCURRENCY = Math.max(1, Math.min(os.cpus().length || 1, 4));

function walkFiles(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, found);
      continue;
    }
    if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      found.push(fullPath);
    }
  }
  return found;
}

function runTool(tool: FrameworkTool, args: string[]): string {
  const finalArgs = tool.translatePaths ? translateWslArgs(args) : args;
  const result = spawnSync(tool.argv[0], [...tool.argv.slice(1), ...finalArgs], { encoding: "utf-8" });
  const label = tool.argv.join(" ");
  if (result.error) {
    throw new FileError(`Failed to execute ${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new FileError(result.stderr?.trim() || result.stdout?.trim() || `${label} failed`);
  }
  return result.stdout ?? "";
}

function detectFilesystemType(filePath: string): "erofs" | "ext4" | "ext2" {
  const fd = readFileSync(filePath);
  if (fd.subarray(1024, 1028).equals(Buffer.from([0xe2, 0xe1, 0xf5, 0xe0]))) return "erofs";
  if (fd.subarray(1080, 1082).equals(Buffer.from([0x53, 0xef]))) return "ext4";
  return "ext2";
}

function extractDexFromZip(inputFile: string, outputDir: string, prefix: string): void {
  let counter = 0;
  for (const entryName of listZipEntries(inputFile)) {
    if (!entryName.toLowerCase().endsWith(".dex")) continue;
    const targetName = `${prefix}_${path.basename(entryName)}`;
    // Extract via a unique temp file then rename, so concurrent processing
    // of inputs that produce the same target name cannot interleave writes
    // into one file.
    const targetPath = path.join(outputDir, targetName);
    const tmpPath = `${targetPath}.${process.pid}.${counter++}.tmp`;
    try {
      extractZipEntry(inputFile, entryName, tmpPath);
      renameSync(tmpPath, targetPath);
    } catch (error) {
      rmSync(tmpPath, { force: true });
      throw error;
    }
  }
}

function extractApexPayload(apexFile: string, targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  const entries = listZipEntries(apexFile);

  if (entries.includes("original_apex")) {
    const nestedApex = path.join(targetDir, "original.apex");
    extractZipEntry(apexFile, "original_apex", nestedApex);
    return extractApexPayload(nestedApex, targetDir);
  }

  if (!entries.includes("apex_payload.img")) {
    throw new FileError(`No apex_payload.img found in ${apexFile}`);
  }

  const payloadPath = path.join(targetDir, "apex_payload.img");
  extractZipEntry(apexFile, "apex_payload.img", payloadPath);
  return payloadPath;
}

/**
 * Extract jar/apk/dex files from an ext4 or EROFS payload image natively (no
 * external tools). Returns false when the image is not parseable natively
 * (unsupported ext4/EROFS feature) so callers can fall back to the
 * external-tool pipeline.
 */
function extractPayloadNatively(payloadPath: string, payloadDir: string): boolean {
  const fsType = detectFilesystemType(payloadPath);
  if (fsType === "erofs") {
    let image: ErofsImage;
    try {
      image = ErofsImage.open(payloadPath);
    } catch (error) {
      if (error instanceof NotErofsImageError || error instanceof ErofsUnsupported) return false;
      throw error;
    }
    try {
      image.extractTo(payloadDir, (relative) =>
        APEX_PAYLOAD_EXTENSIONS.has(path.extname(relative).toLowerCase()),
      );
    } catch (error) {
      if (error instanceof ErofsUnsupported) return false; // retry with extract.erofs
      throw error;
    } finally {
      image.close();
    }
    return true;
  }
  if (fsType !== "ext4") return false;
  let image: Ext4Image;
  try {
    image = Ext4Image.open(payloadPath);
  } catch (error) {
    if (error instanceof NotExt4ImageError || error instanceof Ext4Unsupported) return false;
    throw error;
  }
  try {
    image.extractTo(payloadDir, (relative) =>
      APEX_PAYLOAD_EXTENSIONS.has(path.extname(relative).toLowerCase()),
    );
  } catch (error) {
    if (error instanceof Ext4Unsupported) return false; // retry with debugfs
    throw error;
  } finally {
    image.close();
  }
  return true;
}

function extractFilesystemImage(
  imagePath: string,
  extractDir: string,
  tools: FrameworkToolPaths,
): void {
  mkdirSync(extractDir, { recursive: true });
  const fsType = detectFilesystemType(imagePath);
  if (fsType === "erofs") {
    const erofsBin = path.basename(tools.erofsExtractor.argv[tools.erofsExtractor.argv.length - 1]);
    if (erofsBin === "fsck.erofs") {
      runTool(tools.erofsExtractor, [`--extract=${extractDir}`, "--overwrite", imagePath]);
      return;
    }
    runTool(tools.erofsExtractor, ["-i", imagePath, "-x", "-f", "-o", extractDir]);
    return;
  }
  runTool(tools.debugfs, ["-R", `rdump ./ ${extractDir}`, imagePath]);
}

async function processApex(
  inputFile: string,
  layout: FrameworkPathLayout,
  resolveTools: () => Promise<FrameworkToolPaths>,
): Promise<void> {
  const apexName = path.basename(inputFile, path.extname(inputFile));
  const apexTmpDir = path.join(layout.apexTmpDir, apexName);
  const payloadDir = path.join(apexTmpDir, "payload");
  const payloadPath = extractApexPayload(inputFile, apexTmpDir);

  if (!extractPayloadNatively(payloadPath, payloadDir)) {
    // Unsupported ext4/EROFS feature: extract via external tools
    // (WSL-backed debugfs / extract.erofs on Windows).
    const tools = await resolveTools();
    extractFilesystemImage(payloadPath, payloadDir, tools);
  }

  for (const nestedFile of walkFiles(payloadDir)) {
    const extension = path.extname(nestedFile).toLowerCase();
    if (extension === ".jar" || extension === ".apk") {
      extractDexFromZip(nestedFile, layout.outTmpDir, `${apexName}_${path.basename(nestedFile, extension)}`);
    } else if (extension === ".dex") {
      copyFileSync(nestedFile, path.join(layout.outTmpDir, `${apexName}_${path.basename(nestedFile)}`));
    }
  }
}

/** True when the source tree contains .apex/.capex inputs needing image extraction. */
export function hasApexImageInputs(sourceDir: string): boolean {
  return walkFiles(sourceDir).some((file) => {
    const extension = path.extname(file).toLowerCase();
    return extension === ".apex" || extension === ".capex";
  });
}

/**
 * Resolve the APEX module name for inputs pulled from the runtime APEX mount
 * point (device `/apex/<module>/...` — activated, i.e. already-extracted,
 * modules). Returns null when the file does not sit inside an `apex/<module>/`
 * layout, or sits directly under an `apex/` directory.
 */
function extractedApexModule(inputFile: string, sourceDir: string): string | null {
  const segments = path.relative(sourceDir, inputFile).split(path.sep).filter((segment) => segment !== "");
  const apexIndex = segments.indexOf("apex");
  // Require at least `apex/<module>/<file>` depth.
  if (apexIndex === -1 || segments.length < apexIndex + 3) return null;
  // Device /apex dirs may carry @<version> suffixes; strip them so outputs are
  // stable whether the module was pulled from /apex or extracted from an .apex.
  const moduleName = segments[apexIndex + 1].split("@")[0];
  return moduleName.length > 0 ? moduleName : null;
}

async function processFrameworkInput(
  inputFile: string,
  layout: FrameworkPathLayout,
  resolveTools: () => Promise<FrameworkToolPaths>,
): Promise<void> {
  const extension = path.extname(inputFile).toLowerCase();
  const apexModule = extractedApexModule(inputFile, layout.sourceDir);
  if (apexModule && (extension === ".jar" || extension === ".apk" || extension === ".dex")) {
    // Pulled from the runtime /apex mount point: the module payload is already
    // extracted on device, so namespace dex outputs by module name — same
    // scheme processApex applies to extracted apex_payload.img content, and it
    // keeps same-named jars from different modules from overwriting each other.
    if (extension === ".dex") {
      copyFileSync(inputFile, path.join(layout.outTmpDir, `${apexModule}_${path.basename(inputFile)}`));
    } else {
      extractDexFromZip(inputFile, layout.outTmpDir, `${apexModule}_${path.basename(inputFile, extension)}`);
    }
    return;
  }

  switch (extension) {
    case ".jar":
    case ".apk":
      extractDexFromZip(inputFile, layout.outTmpDir, path.basename(inputFile, extension));
      return;
    case ".apex":
    case ".capex":
      await processApex(inputFile, layout, resolveTools);
      return;
    case ".dex":
      copyFileSync(inputFile, path.join(layout.outTmpDir, path.basename(inputFile)));
      return;
    default:
      return;
  }
}

export async function runTasksWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const limit = Math.max(1, concurrency);
  const results = new Array<T>(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    let currentIndex = nextIndex;
    nextIndex += 1;
    while (currentIndex < tasks.length) {
      results[currentIndex] = await tasks[currentIndex]();
      currentIndex = nextIndex;
      nextIndex += 1;
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function processFrameworkFiles(
  layout: FrameworkPathLayout,
  resolveTools: () => Promise<FrameworkToolPaths>,
): Promise<FrameworkProcessResult> {
  mkdirSync(layout.outTmpDir, { recursive: true });
  mkdirSync(layout.apexTmpDir, { recursive: true });

  const files = walkFiles(layout.sourceDir);
  const outputsBefore = new Set(walkFiles(layout.outTmpDir));
  const results = await runTasksWithConcurrency(
    files.map((inputFile) => async () => {
      try {
        await processFrameworkInput(inputFile, layout, resolveTools);
        return { ok: true as const, path: inputFile };
      } catch (error) {
        return {
          ok: false as const,
          path: inputFile,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
    DEFAULT_PROCESS_CONCURRENCY,
  );

  const failures = results
    .filter((result): result is { ok: false; path: string; error: string } => !result.ok)
    .map((result) => ({ path: result.path, error: result.error }));
  const processed = results.filter((result) => result.ok).length;

  const outputs = walkFiles(layout.outTmpDir).filter((file) => !outputsBefore.has(file));
  return {
    processed,
    failed: failures.length,
    outputs,
    failures,
  };
}

export function cleanFrameworkTempDirs(layout: FrameworkPathLayout): void {
  rmSync(layout.outTmpDir, { recursive: true, force: true });
  rmSync(layout.apexTmpDir, { recursive: true, force: true });
}

export function cleanFrameworkOutputs(layout: FrameworkPathLayout, cleanSource: boolean = false): void {
  cleanFrameworkTempDirs(layout);
  if (cleanSource) {
    rmSync(layout.sourceDir, { recursive: true, force: true });
  }
}

/**
 * Framework source processing: expands jars/apks and APEX images into the set
 * of dex files that gets packed into the framework jar.
 *
 * Port of the Go `android.Process`/`android.processApex` implementation. APEX
 * payload images are read natively (ext4-reader.js / erofs-reader.js); the
 * external-tool path (`debugfs`/erofs-utils) is only used for payloads the
 * native readers reject, and it is resolved lazily so images handled natively
 * work without those tools installed.
 */
import type { FrameworkLayout } from "./types";

const {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} = require("fs");
const { createHash } = require("crypto");
const path = require("path");
const { Ext4Image, NotExt4ImageError, UnsupportedImageFeatureError } = require("./ext4-reader.js");
const {
  ErofsImage,
  NotErofsImageError,
  UnsupportedErofsFeatureError,
} = require("./erofs-reader.js");
const {
  defaultToolContext,
  isFsckErofs,
  resolveDebugfsTool,
  resolveErofsTool,
  runFrameworkTool,
} = require("./framework-tools.js");
const { remoteModule } = require("./framework-collector.js");
const { extractZipEntry, listZipEntries } = require("./zip-utils.js");
const { DecxError, FileError } = require("./errors.js");

/** Counters and per-input failures returned by `processFramework`. */
interface ProcessResult {
  processed: number;
  outputs: string[];
  failures: { path: string; error: string }[];
}

const MAX_EXPANDED_ENTRY_BYTES = 8 * 1024 * 1024 * 1024;
const SUPPORTED_INPUT_EXTENSIONS = new Set([".jar", ".apk", ".dex", ".apex", ".capex"]);
const APEX_CONTENT_EXTENSIONS = new Set([".jar", ".apk", ".dex"]);

const FILESYSTEM_EROFS = "erofs";
const FILESYSTEM_EXT4 = "ext4";
const FILESYSTEM_EXT2 = "ext2";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSupportedFrameworkInput(filePath: string): boolean {
  return SUPPORTED_INPUT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Regular files under `root` with a supported extension, sorted. */
function walkFrameworkInputs(root: string): string[] {
  if (!existsSync(root)) {
    throw new FileError(`no such directory: ${root}`, root);
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && isSupportedFrameworkInput(full)) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

/** Extracts every `*.dex` entry from a jar/apk into `targetDir`. */
function extractDexFromZip(packagePath: string, targetDir: string, prefix: string): string[] {
  mkdirSync(targetDir, { recursive: true });
  const written = [];
  for (const entry of listZipEntries(packagePath)) {
    if (!entry.toLowerCase().endsWith(".dex")) continue;
    let name = path.posix.basename(entry);
    // Include a path digest for non-root entries so two nested classes.dex
    // files cannot silently overwrite each other.
    if (entry.replace(/^\/+|\/+$/g, "").includes("/")) {
      const digest = createHash("sha256").update(entry).digest("hex").slice(0, 8);
      name = `${digest}_${name}`;
    }
    const target = path.join(targetDir, `${prefix}_${name}`);
    extractZipEntry(packagePath, entry, target);
    if (statSync(target).size > MAX_EXPANDED_ENTRY_BYTES) {
      rmSync(target, { force: true });
      throw new FileError("expanded entry exceeds 8 GiB", packagePath);
    }
    written.push(target);
  }
  return written;
}

/** Payload kind from the superblock magic: EROFS at 1024, ext4 at 1080. */
function detectFilesystemType(imagePath: string): string {
  const header = readImageHeader(imagePath);
  if (header.length >= 1028 && header[1024] === 0xe2 && header[1025] === 0xe1
    && header[1026] === 0xf5 && header[1027] === 0xe0) {
    return FILESYSTEM_EROFS;
  }
  if (header.length >= 1082 && header[1080] === 0x53 && header[1081] === 0xef) {
    return FILESYSTEM_EXT4;
  }
  return FILESYSTEM_EXT2;
}

function readImageHeader(imagePath: string): Buffer {
  const fd = openSync(imagePath, "r");
  try {
    const header = Buffer.alloc(1082);
    let total = 0;
    while (total < header.length) {
      const read = readSync(fd, header, total, header.length - total, total);
      if (read <= 0) break;
      total += read;
    }
    return header.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `apex_payload.img` from an `.apex` container into `targetDir` and
 * returns its path. Nested "original_apex" containers are unwrapped first.
 */
function extractApexPayload(apexFile: string, targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  const names = listZipEntries(apexFile);
  if (names.includes("original_apex")) {
    const nested = path.join(targetDir, "original.apex");
    extractZipEntry(apexFile, "original_apex", nested);
    return extractApexPayload(nested, targetDir);
  }
  if (!names.includes("apex_payload.img")) {
    throw new FileError(`no apex_payload.img found in ${apexFile}`, apexFile);
  }
  const payload = path.join(targetDir, "apex_payload.img");
  extractZipEntry(apexFile, "apex_payload.img", payload);
  return payload;
}

/**
 * External-tool extraction for payload images the native reader rejects.
 * The EROFS extractor is called with the flag set matching its binary name;
 * everything else goes through `debugfs rdump`.
 */
function extractFilesystemImage(
  imagePath: string,
  extractDir: string,
  toolContext: any = defaultToolContext(),
): void {
  mkdirSync(extractDir, { recursive: true });
  const filesystemType = detectFilesystemType(imagePath);
  if (filesystemType === FILESYSTEM_EROFS) {
    const tool = resolveErofsTool(toolContext);
    const args = isFsckErofs(tool)
      ? [`--extract=${extractDir}`, "--overwrite", imagePath]
      : ["-i", imagePath, "-x", "-f", "-o", extractDir];
    runCheckedFrameworkTool(tool, args, toolContext);
    return;
  }
  const tool = resolveDebugfsTool(toolContext);
  runCheckedFrameworkTool(tool, ["-R", `rdump ./ ${extractDir}`, imagePath], toolContext);
}

function runCheckedFrameworkTool(
  tool: any,
  args: string[],
  toolContext: any,
): void {
  const result = runFrameworkTool(tool, args, { timeoutMs: 30 * 60_000 }, toolContext);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new FileError(`${tool.argv.join(" ")}: ${detail}`);
  }
}

function canFallBackExt4(error: unknown): boolean {
  return error instanceof NotExt4ImageError || error instanceof UnsupportedImageFeatureError;
}

function canFallBackErofs(error: unknown): boolean {
  return error instanceof NotErofsImageError || error instanceof UnsupportedErofsFeatureError;
}

/**
 * Native payload extraction. Returns false only when the payload is not an
 * ext4/EROFS image or uses a feature the native readers reject, so the caller
 * can fall back to the external tools; any other error is a hard failure.
 */
function extractPayloadNatively(
  imagePath: string,
  extractDir: string,
  shouldExtract: (relative: string) => boolean,
): boolean {
  const filesystemType = detectFilesystemType(imagePath);
  if (filesystemType === FILESYSTEM_EXT4) {
    let image;
    try {
      image = Ext4Image.open(imagePath);
    } catch (error) {
      if (canFallBackExt4(error)) return false;
      throw error;
    }
    try {
      mkdirSync(extractDir, { recursive: true });
      image.extractTo(extractDir, shouldExtract);
      return true;
    } catch (error) {
      if (canFallBackExt4(error)) return false;
      throw error;
    } finally {
      image.close();
    }
  }
  if (filesystemType === FILESYSTEM_EROFS) {
    let image;
    try {
      image = ErofsImage.open(imagePath);
    } catch (error) {
      if (canFallBackErofs(error)) return false;
      throw error;
    }
    try {
      mkdirSync(extractDir, { recursive: true });
      image.extractTo(extractDir, shouldExtract);
      return true;
    } catch (error) {
      if (canFallBackErofs(error)) return false;
      throw error;
    } finally {
      image.close();
    }
  }
  // ext2 or unknown magic: leave the image to the external tools.
  return false;
}

/**
 * Expands one `.apex`/`.capex` input into dex outputs inside `workDir`. Every
 * output is namespaced with `prefix` so modules shipping same-named jars
 * cannot overwrite each other.
 */
function processApex(
  apexFile: string,
  workDir: string,
  prefix: string,
  toolContext: any = defaultToolContext(),
): void {
  const base = path.basename(apexFile);
  const extension = path.extname(base);
  const apexDir = path.join(workDir, `apex-${base.slice(0, base.length - extension.length)}`);
  const payloadDir = path.join(apexDir, "payload");
  const payload = extractApexPayload(apexFile, apexDir);
  const nestedFilter = (relative: string): boolean =>
    APEX_CONTENT_EXTENSIONS.has(path.extname(relative).toLowerCase());
  const extracted = extractPayloadNatively(payload, payloadDir, nestedFilter);
  if (!extracted) {
    // Payload or feature the native readers reject: extract with the external
    // tools (debugfs / erofs-utils from PATH; Linux/macOS only).
    rmSync(payloadDir, { recursive: true, force: true });
    extractFilesystemImage(payload, payloadDir, toolContext);
  }
  for (const nested of walkFrameworkInputs(payloadDir)) {
    const nestedExtension = path.extname(nested).toLowerCase();
    if (nestedExtension === ".jar" || nestedExtension === ".apk") {
      const stem = path.basename(nested).slice(0, path.basename(nested).length - path.extname(nested).length);
      extractDexFromZip(nested, workDir, `${prefix}_${stem}`);
      continue;
    }
    if (nestedExtension === ".dex") {
      copyFileSync(nested, path.join(workDir, `${prefix}_${path.basename(nested)}`));
    }
  }
}

/**
 * Expands every supported source file into a staging directory and swaps it in
 * as the layout's `outTmpDir`. Nothing is replaced unless every input
 * processed, so a failed run keeps the previous output.
 */
function processFramework(
  layout: FrameworkLayout,
  toolContext: any = defaultToolContext(),
): ProcessResult {
  const result: ProcessResult = { processed: 0, outputs: [], failures: [] };
  const files = walkFrameworkInputs(layout.sourceDir);
  if (files.length === 0) {
    throw new FileError("no supported framework inputs found", layout.sourceDir);
  }
  const staging = mkdtempSync(path.join(layout.outDir, ".process-"));
  try {
    for (const file of files) {
      const relative = path.relative(layout.sourceDir, file).split(path.sep).join("/");
      const extension = path.extname(file).toLowerCase();
      let prefix = path.basename(file).slice(0, path.basename(file).length - extension.length);
      const module = remoteModule(relative);
      if (module) prefix = `${module}_${prefix}`;

      const work = mkdtempSync(path.join(layout.outDir, ".input-"));
      let failure: string | null = null;
      try {
        switch (extension) {
          case ".dex":
            copyFileSync(file, path.join(work, `${prefix}.dex`));
            break;
          case ".jar":
          case ".apk":
            extractDexFromZip(file, work, prefix);
            break;
          default:
            processApex(file, work, prefix, toolContext);
        }
        for (const name of readdirSync(work).sort()) {
          const source = path.join(work, name);
          if (!statSync(source).isFile()) continue;
          const destination = path.join(staging, name);
          if (existsSync(destination)) {
            throw new FileError(`duplicate output ${name} from ${file}`, file);
          }
          copyFileSync(source, destination);
        }
      } catch (error) {
        failure = errorMessage(error);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      if (failure === null) {
        result.processed += 1;
      } else {
        result.failures.push({ path: file, error: failure });
      }
    }

    if (result.failures.length > 0) {
      throw new DecxError(
        `${result.failures.length} framework inputs failed; previous output retained`,
        "PROCESS_FAILED",
        { failures: result.failures },
      );
    }

    const previous = `${layout.outTmpDir}.previous`;
    if (existsSync(previous)) {
      throw new FileError(`recovery directory exists: ${previous}`, previous);
    }
    let hadOld = false;
    if (existsSync(layout.outTmpDir)) {
      renameSync(layout.outTmpDir, previous);
      hadOld = true;
    }
    try {
      renameSync(staging, layout.outTmpDir);
    } catch (error) {
      if (hadOld) renameSync(previous, layout.outTmpDir);
      throw error;
    }
    if (hadOld) rmSync(previous, { recursive: true, force: true });

    result.outputs = walkFrameworkInputs(layout.outTmpDir);
    return result;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Number of regular files under `root` (used for the pack file count). */
function countFrameworkFiles(root: string): number {
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.isFile()) count += 1;
    }
  };
  walk(root);
  return count;
}

/** Removes intermediate processing state and optionally the collected sources. */
function cleanFrameworkOutputs(layout: FrameworkLayout, cleanSource: boolean): void {
  rmSync(layout.outTmpDir, { recursive: true, force: true });
  if (cleanSource) {
    rmSync(layout.sourceDir, { recursive: true, force: true });
  }
}

module.exports = {
  isSupportedFrameworkInput,
  walkFrameworkInputs,
  extractDexFromZip,
  detectFilesystemType,
  extractApexPayload,
  extractFilesystemImage,
  extractPayloadNatively,
  processApex,
  processFramework,
  countFrameworkFiles,
  cleanFrameworkOutputs,
};

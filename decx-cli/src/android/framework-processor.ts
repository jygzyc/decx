import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { FileError } from "../utils/errors.js";
import type {
  FrameworkPathLayout,
  FrameworkProcessResult,
  FrameworkToolPaths,
} from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([".apk", ".jar", ".apex", ".capex", ".dex"]);
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

function runTool(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  if (result.error) {
    throw new FileError(`Failed to execute ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new FileError(result.stderr?.trim() || result.stdout?.trim() || `${command} failed`);
  }
  return result.stdout ?? "";
}

function detectFilesystemType(filePath: string): "erofs" | "ext4" | "ext2" {
  const fd = readFileSync(filePath);
  if (fd.subarray(1024, 1028).equals(Buffer.from([0xe2, 0xe1, 0xf5, 0xe0]))) return "erofs";
  if (fd.subarray(1080, 1082).equals(Buffer.from([0x53, 0xef]))) return "ext4";
  return "ext2";
}

function listZipEntries(inputFile: string): string[] {
  return runTool("unzip", ["-Z1", inputFile])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractZipEntry(inputFile: string, entryName: string, targetPath: string): void {
  const outputFd = openSync(targetPath, "w");
  try {
    const result = spawnSync("unzip", ["-p", inputFile, entryName], {
      stdio: ["ignore", outputFd, "pipe"],
    });
    if (result.error) {
      throw new FileError(`Failed to read '${entryName}' from ${inputFile}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new FileError(
        result.stderr?.toString().trim() || `Failed to extract '${entryName}' from ${inputFile}`,
      );
    }
  } catch (error) {
    rmSync(targetPath, { force: true });
    throw error;
  } finally {
    closeSync(outputFd);
  }
}

function extractDexFromZip(inputFile: string, outputDir: string, prefix: string): void {
  for (const entryName of listZipEntries(inputFile)) {
    if (!entryName.toLowerCase().endsWith(".dex")) continue;
    const targetName = `${prefix}_${path.basename(entryName)}`;
    extractZipEntry(inputFile, entryName, path.join(outputDir, targetName));
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

function extractFilesystemImage(
  imagePath: string,
  extractDir: string,
  tools: FrameworkToolPaths,
): void {
  mkdirSync(extractDir, { recursive: true });
  const fsType = detectFilesystemType(imagePath);
  if (fsType === "erofs") {
    if (path.basename(tools.erofsExtractor) === "fsck.erofs") {
      runTool(tools.erofsExtractor, [`--extract=${extractDir}`, "--overwrite", imagePath]);
      return;
    }
    runTool(tools.erofsExtractor, ["-i", imagePath, "-x", "-f", "-o", extractDir]);
    return;
  }
  runTool(tools.debugfs, ["-R", `rdump ./ ${extractDir}`, imagePath]);
}

function processApex(
  inputFile: string,
  layout: FrameworkPathLayout,
  tools: FrameworkToolPaths,
): void {
  const apexName = path.basename(inputFile, path.extname(inputFile));
  const apexTmpDir = path.join(layout.apexTmpDir, apexName);
  const payloadDir = path.join(apexTmpDir, "payload");
  const payloadPath = extractApexPayload(inputFile, apexTmpDir);
  extractFilesystemImage(payloadPath, payloadDir, tools);

  for (const nestedFile of walkFiles(payloadDir)) {
    const extension = path.extname(nestedFile).toLowerCase();
    if (extension === ".jar" || extension === ".apk") {
      extractDexFromZip(nestedFile, layout.outTmpDir, `${apexName}_${path.basename(nestedFile, extension)}`);
    } else if (extension === ".dex") {
      copyFileSync(nestedFile, path.join(layout.outTmpDir, `${apexName}_${path.basename(nestedFile)}`));
    }
  }
}

function processFrameworkInput(
  inputFile: string,
  layout: FrameworkPathLayout,
  tools: FrameworkToolPaths,
): void {
  const extension = path.extname(inputFile).toLowerCase();
  switch (extension) {
    case ".jar":
    case ".apk":
      extractDexFromZip(inputFile, layout.outTmpDir, path.basename(inputFile, extension));
      return;
    case ".apex":
    case ".capex":
      processApex(inputFile, layout, tools);
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
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= tasks.length) {
        return;
      }
      results[currentIndex] = await tasks[currentIndex]();
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function processFrameworkFiles(
  layout: FrameworkPathLayout,
  tools: FrameworkToolPaths,
): Promise<FrameworkProcessResult> {
  mkdirSync(layout.outTmpDir, { recursive: true });
  mkdirSync(layout.apexTmpDir, { recursive: true });

  const files = walkFiles(layout.sourceDir);
  const outputsBefore = new Set(walkFiles(layout.outTmpDir));
  const results = await runTasksWithConcurrency(
    files.map((inputFile) => async () => {
      try {
        processFrameworkInput(inputFile, layout, tools);
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

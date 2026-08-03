import { Command } from "commander";
import {
  buildFramework,
  collectFramework,
  openFrameworkJar,
  resolveFrameworkJarPath,
  resolveProcessOem,
  runFrameworkPipeline,
  summarizeFrameworkArtifact,
  summarizeFrameworkJarPath,
} from "../android/framework.js";
import { Formatter } from "../utils/formatter.js";
import { withErrorHandler } from "../utils/errors.js";
import { logCliEvent } from "../utils/logger.js";
import { addFrameworkCommonOptions } from "./android-shared.js";

export function registerAndroidFrameworkCommands(cmd: Command): void {
  const framework = cmd
    .command("framework")
    .summary("Collect, process, pack, and open Android framework artifacts")
    .description("Build DECX-readable framework jars from connected devices or local framework file directories.");

  addFrameworkCommonOptions(
    framework
      .command("collect")
      .summary("Pull framework files from a connected Android device")
      .description("Collect framework APK/JAR/APEX inputs from the selected device into a local source directory for later processing.")
  )
    .action(withErrorHandler(async (opts) => {
      const fmt = new Formatter();
      const { oem, layout, result } = await collectFramework(opts);
      const artifact = summarizeFrameworkArtifact(layout, oem);
      logCliEvent({
        command: "android",
        action: "framework_collect",
        ...artifact,
        sourceDir: layout.sourceDir,
        outDir: layout.outDir,
        scanned: result.scanned,
        pulled: result.pulled,
        failed: result.failed,
      });
      fmt.output({ artifact, layout, collection: result });
    }));

  addFrameworkCommonOptions(
    framework
      .command("process [oem]")
      .summary("Process local framework sources and pack framework_<brand>_<vendor>.jar")
      .description("Process a local framework source directory and pack a DECX-readable framework jar. When <oem> is omitted it is resolved from the .artifact.json at --out-dir, or from a connected device as a last resort.")
  )
    .action(withErrorHandler(async (oem: string | undefined, opts) => {
      const fmt = new Formatter();
      const resolvedOem = await resolveProcessOem({ ...opts, oem });
      const result = await buildFramework({ ...opts, oem: resolvedOem });
      const artifact = summarizeFrameworkArtifact(result.layout, resolvedOem);
      logCliEvent({
        command: "android",
        action: "framework_process",
        ...artifact,
        sourceDir: result.layout.sourceDir,
        outDir: result.layout.outDir,
        processed: result.process.processed,
        failed: result.process.failed,
        packedFiles: result.pack.fileCount,
        cleanSource: opts.cleanSource ?? false,
      });
      fmt.output({ artifact, ...result });
    }));

  addFrameworkCommonOptions(
    framework
      .command("run")
      .summary("Collect, process, pack, and optionally open a framework jar")
      .description("Run the full device framework pipeline: collect files, process them, pack framework_<brand>_<vendor>.jar, and open it unless --no-open is used.")
      .option("--no-open", "Only build the framework jar; do not start a DECX session")
      .option("-n, --name <name>", "Session name to use when opening the generated framework jar")
      .option("--port <port>", "DECX HTTP server port to bind when opening the generated framework jar")
  )
    .action(withErrorHandler(async (opts) => {
      const fmt = new Formatter();
      const result = await runFrameworkPipeline({ ...opts, noOpen: opts.open === false });
      const artifact = summarizeFrameworkJarPath(result.pack.jarPath);
      logCliEvent({
        command: "android",
        action: "framework_run",
        ...(artifact ?? { jarPath: result.pack.jarPath }),
        sourceDir: result.layout.sourceDir,
        outDir: result.layout.outDir,
        scanned: result.collection?.scanned,
        pulled: result.collection?.pulled,
        processed: result.process.processed,
        failed: result.process.failed,
        packedFiles: result.pack.fileCount,
        opened: result.open !== undefined,
        cleanSource: opts.cleanSource ?? false,
      });
      fmt.output({ artifact, ...result });
    }));

  addFrameworkCommonOptions(
    framework
      .command("open [jar]")
      .summary("Open a generated or explicit framework jar in DECX")
      .description("Open the latest generated framework jar, or the provided jar path, as a normal DECX process session.")
      .option("-n, --name <name>", "Session name used by -s/--session")
      .option("--port <port>", "DECX HTTP server port to bind")
  )
    .action(withErrorHandler(async (jar: string | undefined, opts) => {
      const fmt = new Formatter();
      const resolvedJar = await resolveFrameworkJarPath(jar, opts);
      const open = await openFrameworkJar(resolvedJar, opts);
      const artifact = summarizeFrameworkJarPath(resolvedJar);
      logCliEvent({
        command: "android",
        action: "framework_open",
        ...(artifact ?? { jarPath: resolvedJar }),
      });
      fmt.output({ artifact, jar: resolvedJar, open });
    }));
}

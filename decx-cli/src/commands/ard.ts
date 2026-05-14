import { Command } from "commander";
import { resolveCommandClient } from "../core/client-helper.js";
import type { ClassFilterOptions, ExportedComponentOptions, ResourceFilterOptions } from "../core/client.js";
import { AdbClient, filterSystemServices } from "../android/adb.js";
import { Formatter } from "../utils/formatter.js";
import { withErrorHandler } from "../utils/errors.js";
import { logCliEvent } from "../utils/logger.js";
import {
  buildFramework,
  collectFramework,
  openFrameworkJar,
  resolveFrameworkJarPath,
  runFrameworkPipeline,
  summarizeFrameworkArtifact,
  summarizeFrameworkJarPath,
} from "../android/framework.js";

function addAdbDeviceOptions(cmd: Command): Command {
  return cmd
    .option("--adb-path <path>", "ADB executable path")
    .option("--serial <serial>", "ADB device serial");
}

function addFrameworkCommonOptions(cmd: Command): Command {
  return addAdbDeviceOptions(cmd)
    .option("--source-dir <dir>", "Framework source directory")
    .option("--out-dir <dir>", "Framework output directory")
    .option("--clean-source", "Remove source/ after the command finishes successfully");
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function addPackageFilterOptions(cmd: Command): Command {
  return cmd
    .option("--limit <n>", "Limit returned results")
    .option("--include-package <name>", "Only include items in this package", collectOption, [])
    .option("--exclude-package <name>", "Exclude items in this package", collectOption, [])
    .option("--no-regex", "Treat filter values as literal text");
}

function parseClassFilterOptions(opts: Record<string, unknown>): ClassFilterOptions {
  return {
    filter: {
      ...(opts.limit ? { limit: parseInt(String(opts.limit), 10) } : {}),
      includes: Array.isArray(opts.includePackage) ? opts.includePackage.map(String) : [],
      excludes: Array.isArray(opts.excludePackage) ? opts.excludePackage.map(String) : [],
      ...(opts.regex === false ? { regex: false } : {}),
    },
  };
}

function parseExportedComponentOptions(opts: Record<string, unknown>): ExportedComponentOptions {
  return {
    includes: Array.isArray(opts.type) ? opts.type.map(String) : [],
    excludes: Array.isArray(opts.excludeType) ? opts.excludeType.map(String) : [],
    ...(opts.regex === false ? { regex: false } : {}),
  };
}

function parseResourceFilterOptions(opts: Record<string, unknown>): ResourceFilterOptions {
  return {
    filter: {
      includes: Array.isArray(opts.include) ? opts.include.map(String) : [],
      ...(opts.regex === false ? { regex: false } : {}),
    },
  };
}

export function makeArdCommand(): Command {
  const cmd = new Command("ard");
  cmd.description("Android Specific Analysis");

  cmd
    .option("-s, --session <name>", "Target session by name")
    .option("-P, --port <port>", "Server port");

  // ── App analysis ──────────────────────────────────────────────────────────

  cmd
    .command("app-manifest")
    .description("Get Android App AndroidManifest.xml")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getAppManifest(page));
    }));

  cmd
    .command("main-activity")
    .description("Get main activity name")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getMainActivity(page));
    }));

  cmd
    .command("app-application")
    .description("Get Application class name")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getApplication(page));
    }));

  cmd
    .command("exported-components")
    .description("List exported components")
    .option("--type <type>", "Only include component type: activity, service, receiver, or provider", collectOption, [])
    .option("--exclude-type <type>", "Exclude component type: activity, service, receiver, or provider", collectOption, [])
    .option("--no-regex", "Treat component type filters as literal text")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getExportedComponents(parseExportedComponentOptions(opts), page));
    }));

  cmd
    .command("app-deeplinks")
    .description("List deep link schemes")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getDeepLinks(page));
    }));

  addPackageFilterOptions(
    cmd
      .command("app-receivers")
      .description("List dynamic broadcast receivers")
      .option("--page <n>", "Page number", String)
  )
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      const receivers = await client.getDynamicReceivers(parseClassFilterOptions(opts), page);
      fmt.output(receivers);
    }));

  cmd
    .command("system-service-impl <interface>")
    .description("Find system service implementations")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (iface: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getSystemServiceImpl(iface, page));
    }));

  addAdbDeviceOptions(
    cmd
      .command("system-services")
      .description("List Android system services via adb shell service list")
      .option("--grep <keyword>", "Filter services by keyword")
  )
    .action(withErrorHandler(async (opts) => {
      const fmt = new Formatter();
      const adb = new AdbClient({ adbPath: opts.adbPath, serial: opts.serial });
      adb.ensureAvailable();
      adb.ensureDeviceConnected();
      const services = filterSystemServices(adb.listSystemServices(), opts.grep);
      logCliEvent({
        command: "ard",
        action: "system_services",
        serial: opts.serial,
        grep: opts.grep,
        count: services.total,
      });
      fmt.output(services);
    }));

  addAdbDeviceOptions(
    cmd
      .command("perm-info <permission>")
      .description("Show adb shell pm list permissions details for one permission")
  )
    .action(withErrorHandler(async (permission: string, opts) => {
      const fmt = new Formatter();
      const adb = new AdbClient({ adbPath: opts.adbPath, serial: opts.serial });
      adb.ensureAvailable();
      adb.ensureDeviceConnected();
      const info = adb.getPermissionInfo(permission);
      logCliEvent({
        command: "ard",
        action: "perm_info",
        serial: opts.serial,
        permission,
      });
      fmt.output(info);
    }));

  cmd
    .command("all-resources")
    .description("List all resource file names")
    .option("--include <pattern>", "Only include resource file names matching this pattern", collectOption, [])
    .option("--no-regex", "Treat resource file name filters as literal text")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getAllResources(parseResourceFilterOptions(opts), page));
    }));

  cmd
    .command("resource-file <res>")
    .description("Get resource file content by name")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (res: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getResourceFile(res, page));
    }));

  cmd
    .command("strings")
    .description("Get strings.xml content from app resources")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getStrings(page));
    }));

  addPackageFilterOptions(
    cmd
      .command("get-aidl")
      .description("Get AIDL interfaces")
      .option("--page <n>", "Page number", String)
  )
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getAidlInterfaces(parseClassFilterOptions(opts), page));
    }));

  const framework = cmd.command("framework").description("Collect and process Android framework files");

  addFrameworkCommonOptions(
    framework
      .command("collect")
      .description("Collect framework files from the connected Android device")
  )
    .action(withErrorHandler(async (opts) => {
      const fmt = new Formatter();
      const { oem, layout, result } = await collectFramework(opts);
      const artifact = summarizeFrameworkArtifact(layout, oem);
      logCliEvent({
        command: "ard",
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
      .command("process <oem>")
      .description("Process a local framework source directory for the specified oem and pack framework_<brand>_<vendor>.jar")
  )
    .action(withErrorHandler(async (oem: string, opts) => {
      const fmt = new Formatter();
      const result = await buildFramework({ ...opts, oem });
      const artifact = summarizeFrameworkArtifact(result.layout, oem);
      logCliEvent({
        command: "ard",
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
      .description("Collect from the connected device, process, pack, and optionally open framework_<brand>_<vendor>.jar")
      .option("--no-open", "Do not open the generated framework jar in a DECX session")
      .option("-n, --name <name>", "Session name when opening the generated framework jar")
      .option("-P, --port <port>", "Server port when opening the generated framework jar")
  )
    .action(withErrorHandler(async (opts) => {
      const fmt = new Formatter();
      const result = await runFrameworkPipeline({ ...opts, noOpen: opts.open === false });
      const artifact = summarizeFrameworkJarPath(result.pack.jarPath);
      logCliEvent({
        command: "ard",
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
      .description("Open the generated framework jar or a provided JAR in a DECX session")
      .option("-n, --name <name>", "Session name")
      .option("-P, --port <port>", "Server port")
  )
    .action(withErrorHandler(async (jar: string | undefined, opts) => {
      const fmt = new Formatter();
      const resolvedJar = await resolveFrameworkJarPath(jar, opts);
      const open = await openFrameworkJar(resolvedJar, opts);
      const artifact = summarizeFrameworkJarPath(resolvedJar);
      logCliEvent({
        command: "ard",
        action: "framework_open",
        ...(artifact ?? { jarPath: resolvedJar }),
      });
      fmt.output({ artifact, jar: resolvedJar, open });
    }));

  return cmd;
}

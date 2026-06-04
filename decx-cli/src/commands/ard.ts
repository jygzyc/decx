import { Command } from "commander";
import { resolveCommandClient } from "../core/client-helper.js";
import type { ExportedComponentOptions, ResourceFilterOptions } from "../core/client.js";
import { AdbClient, filterSystemServices } from "../android/adb.js";
import { Formatter } from "../utils/formatter.js";
import { withErrorHandler } from "../utils/errors.js";
import { logCliEvent } from "../utils/logger.js";
import { collectOption, addPackageFilterOptions, parseClassFilterOptions } from "./shared-options.js";
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
    .option("--adb-path <path>", "Path to the adb executable; defaults to adb on PATH")
    .option("--serial <serial>", "ADB device serial to use when multiple devices are connected");
}

function addFrameworkCommonOptions(cmd: Command): Command {
  return addAdbDeviceOptions(cmd)
    .option("--source-dir <dir>", "Directory containing pulled framework files or receiving collected files")
    .option("--out-dir <dir>", "Directory for processed framework artifacts and packed jar output")
    .option("--clean-source", "Remove the collected source directory after successful processing");
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
  cmd.description("Android app, framework, resource, permission, and device analysis commands");

  cmd
    .option("-s, --session <name>", "Use a named DECX process session instead of the default port")
    .option("-P, --port <port>", "Connect to a DECX HTTP server on this port");

  // ── App analysis ──────────────────────────────────────────────────────────

  cmd
    .command("app-manifest")
    .summary("Return the APK AndroidManifest.xml")
    .description("Return the decoded AndroidManifest.xml for the current app analysis session.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getAppManifest(page));
    }));

  cmd
    .command("main-activity")
    .summary("Return the launcher activity class")
    .description("Return the app launcher activity declared with MAIN and LAUNCHER intent filters.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getMainActivity(page));
    }));

  cmd
    .command("app-application")
    .summary("Return the custom Application class")
    .description("Return the android:name Application class declared by the app manifest, when present.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getApplication(page));
    }));

  cmd
    .command("exported-components")
    .summary("List exported activities, services, receivers, and providers")
    .description("List manifest components exposed to other apps. Filter component types with --type or --exclude-type.")
    .option("--type <type>", "Include only component types matching this value: activity, service, receiver, or provider; repeatable", collectOption, [])
    .option("--exclude-type <type>", "Exclude component types matching this value: activity, service, receiver, or provider; repeatable", collectOption, [])
    .option("--no-regex", "Treat component type filters as literal text instead of regular expressions")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getExportedComponents(parseExportedComponentOptions(opts), page));
    }));

  cmd
    .command("app-deeplinks")
    .summary("List manifest-declared deep links")
    .description("List schemes, hosts, paths, and owning components from app intent filters.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getDeepLinks(page));
    }));

  addPackageFilterOptions(
    cmd
      .command("app-receivers")
      .summary("List dynamically registered broadcast receivers")
      .description("Search code for runtime broadcast receiver registrations, with optional package filters.")
      .option("--page <n>", "Result page number to fetch", String)
  )
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      const receivers = await client.getDynamicReceivers(parseClassFilterOptions(opts), page);
      fmt.output(receivers);
    }));

  cmd
    .command("system-service-impl <interface>")
    .summary("Find framework service implementations for one interface")
    .description("Search the current framework analysis session for classes implementing a system service interface.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (iface: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getSystemServiceImpl(iface, page));
    }));

  addAdbDeviceOptions(
    cmd
      .command("system-services")
      .summary("List live Binder service names from a connected device")
      .description("Run adb shell service list and return structured live system service data from the selected device.")
      .option("--grep <keyword>", "Include only service rows containing this keyword")
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
      .summary("Show live Android permission metadata from a connected device")
      .description("Run adb shell pm list permissions and return details for one permission name such as android.permission.CAMERA.")
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
    .summary("List decoded APK resource file names")
    .description("List resource paths available in the current app analysis session, with optional file-name filters.")
    .option("--include <pattern>", "Include only resource file names matching this pattern; repeatable", collectOption, [])
    .option("--no-regex", "Treat resource file name filters as literal text instead of regular expressions")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getAllResources(parseResourceFilterOptions(opts), page));
    }));

  cmd
    .command("resource-file <res>")
    .summary("Return one decoded APK resource file")
    .description("Return resource content by path or file name, such as res/xml/network_security_config.xml.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (res: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getResourceFile(res, page));
    }));

  cmd
    .command("strings")
    .summary("Return decoded app string resources")
    .description("Return strings.xml content from the current app analysis session.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getStrings(page));
    }));

  addPackageFilterOptions(
    cmd
      .command("get-aidl")
      .summary("List AIDL-style Binder interfaces discovered in code")
      .description("Find AIDL interfaces and Binder stubs/proxies in the current analysis session, with optional package filters.")
      .option("--page <n>", "Result page number to fetch", String)
  )
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getAidlInterfaces(parseClassFilterOptions(opts), page));
    }));

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
      .summary("Process local framework sources and pack framework_<brand>_<vendor>.jar")
      .description("Process a local framework source directory for the specified OEM identifier, then pack a DECX-readable framework jar.")
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
      .summary("Collect, process, pack, and optionally open a framework jar")
      .description("Run the full device framework pipeline: collect files, process them, pack framework_<brand>_<vendor>.jar, and open it unless --no-open is used.")
      .option("--no-open", "Only build the framework jar; do not start a DECX session")
      .option("-n, --name <name>", "Session name to use when opening the generated framework jar")
      .option("-P, --port <port>", "DECX HTTP server port to bind when opening the generated framework jar")
      .option("--heap <size>", "Maximum Java heap for the DECX server JVM (default: floor(2/3 machine memory))")
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
      .summary("Open a generated or explicit framework jar in DECX")
      .description("Open the latest generated framework jar, or the provided jar path, as a normal DECX process session.")
      .option("-n, --name <name>", "Session name used by -s/--session")
      .option("-P, --port <port>", "DECX HTTP server port to bind")
      .option("--heap <size>", "Maximum Java heap for the DECX server JVM (default: floor(2/3 machine memory))")
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

import { Command } from "commander";
import { resolveCommandClient } from "../core/client-helper.js";
import type { ExportedComponentOptions, ResourceFilterOptions } from "../core/client.js";
import { withErrorHandler } from "../utils/errors.js";
import { collectOption, addPackageFilterOptions, parseClassFilterOptions } from "./shared-options.js";

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

function parsePage(opts: Record<string, unknown>): number {
  return opts.page ? parseInt(String(opts.page)) : 1;
}

export function registerAndroidAppAnalysisCommands(cmd: Command): void {
  cmd
    .command("manifest")
    .summary("Return the APK AndroidManifest.xml")
    .description("Return the decoded AndroidManifest.xml for the current app analysis session.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      fmt.output(await client.getAppManifest(parsePage(opts)));
    }));

  cmd
    .command("launcher-activity")
    .summary("Return the launcher activity class")
    .description("Return the app launcher activity declared with MAIN and LAUNCHER intent filters.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      fmt.output(await client.getMainActivity(parsePage(opts)));
    }));

  cmd
    .command("application")
    .summary("Return the custom Application class")
    .description("Return the android:name Application class declared by the app manifest, when present.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      fmt.output(await client.getApplication(parsePage(opts)));
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
      fmt.output(await client.getExportedComponents(parseExportedComponentOptions(opts), parsePage(opts)));
    }));

  cmd
    .command("deep-links")
    .summary("List manifest-declared deep links")
    .description("List schemes, hosts, paths, and owning components from app intent filters.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      fmt.output(await client.getDeepLinks(parsePage(opts)));
    }));

  addPackageFilterOptions(
    cmd
      .command("dynamic-receivers")
      .summary("List dynamically registered broadcast receivers")
      .description("Search code for runtime broadcast receiver registrations, with optional package filters.")
      .option("--page <n>", "Result page number to fetch", String)
  )
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      fmt.output(await client.getDynamicReceivers(parseClassFilterOptions(opts), parsePage(opts)));
    }));

  cmd
    .command("framework-service-implementation <interface>")
    .summary("Find a framework service implementation in loaded decompiled code")
    .description("Search the current decompiled analysis session (loaded DECX session, offline) for classes implementing a system service interface such as android.app.IActivityManager.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (iface: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      fmt.output(await client.getSystemServiceImpl(iface, parsePage(opts)));
    }));
}

export function registerAndroidResourceCommands(cmd: Command): void {
  cmd
    .command("resources")
    .summary("List decoded APK resource file names")
    .description("List resource paths available in the current app analysis session, with optional file-name filters.")
    .option("--include <pattern>", "Include only resource file names matching this pattern; repeatable", collectOption, [])
    .option("--no-regex", "Treat resource file name filters as literal text instead of regular expressions")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      fmt.output(await client.getAllResources(parseResourceFilterOptions(opts), parsePage(opts)));
    }));

  cmd
    .command("resource-file <res>")
    .summary("Return one decoded APK resource file")
    .description("Return resource content by path or file name, such as res/xml/network_security_config.xml.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (res: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      fmt.output(await client.getResourceFile(res, parsePage(opts)));
    }));

  cmd
    .command("strings")
    .summary("Return decoded app string resources")
    .description("Return strings.xml content from the current app analysis session.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      fmt.output(await client.getStrings(parsePage(opts)));
    }));

  addPackageFilterOptions(
    cmd
      .command("aidl-interfaces")
      .summary("List AIDL-style Binder interfaces discovered in code")
      .description("Find AIDL interfaces and Binder stubs/proxies in the current analysis session, with optional package filters.")
      .option("--page <n>", "Result page number to fetch", String)
  )
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      fmt.output(await client.getAidlInterfaces(parseClassFilterOptions(opts), parsePage(opts)));
    }));
}

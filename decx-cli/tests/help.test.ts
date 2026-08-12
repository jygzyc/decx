/**
 * CLI command structure tests.
 *
 * Tests the command tree structure rather than help text output.
 * This decouples tests from description wording and commander internals.
 */

import { Command } from "commander";
import { jest } from "@jest/globals";
import { makeProcessCommand } from "../src/commands/process.js";
import { makeCodeCommand } from "../src/commands/code.js";
import { makeAndroidCommand } from "../src/commands/android.js";
import { makeSelfCommand } from "../src/commands/self.js";
import { main, ROOT_DESCRIPTION } from "../src/index.js";

function createProgram(): Command {
  const program = new Command();
  program
    .name("decx")
    .version("2.0.0")
    .description(ROOT_DESCRIPTION);
  program.addCommand(makeProcessCommand());
  program.addCommand(makeCodeCommand());
  program.addCommand(makeAndroidCommand());
  program.addCommand(makeSelfCommand());
  return program;
}

function findCommand(root: Command, path: string[]): Command | undefined {
  let cmd: Command = root;
  for (const part of path) {
    const sub = cmd.commands.find(c => c.name() === part);
    if (!sub) return undefined;
    cmd = sub;
  }
  return cmd;
}

function getSubcommandNames(parent: Command): string[] {
  return parent.commands.map(c => c.name());
}

function getOptionFlags(cmd: Command): string[] {
  return cmd.options.map(o => o.flags);
}

function hasFlag(cmd: Command, flag: string): boolean {
  return getOptionFlags(cmd).some(optionFlags => optionFlags.includes(flag));
}

function walkCommands(cmd: Command): Command[] {
  const result = [cmd];
  for (const sub of cmd.commands) {
    result.push(...walkCommands(sub));
  }
  return result;
}

// ============================================================================
// Root
// ============================================================================

describe("root", () => {
  it("registers 4 top-level commands", () => {
    const program = createProgram();
    expect(getSubcommandNames(program)).toEqual(["process", "code", "android", "self"]);
  });

  it("never binds -P as a short option anywhere (reserved for JADX -P<key>=<value>)", () => {
    const program = createProgram();
    for (const cmd of walkCommands(program)) {
      for (const opt of cmd.options) {
        expect(opt.short).not.toBe("-P");
      }
    }
  });

  it("describes the CLI purpose for agents choosing a command family", () => {
    const help = createProgram().helpInformation().replace(/\s+/g, " ");
    expect(help).toContain("DECX - Decompiler + X");
    expect(help).toContain("deeper analysis of decompiled Java code");
    expect(help).toContain("powered by JADX");
    expect(help).toContain("Query decompiled classes, methods, source, control flow");
    expect(help).toContain("Analyze Android apps and frameworks, or inspect a connected device");
  });

  it("prints top-level help when invoked without arguments", () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      main(["node", "decx"]);
      output = log.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      log.mockRestore();
    }
    expect(output).toContain("Usage: decx [options] [command]");
    expect(output).toContain("Commands:");
  });
});

// ============================================================================
// decx process
// ============================================================================

describe("process", () => {
  let cmd: Command;

  beforeEach(() => {
    cmd = findCommand(createProgram(), ["process"])!;
  });

  it("registers 5 subcommands (check, open, close, list, status)", () => {
    expect(getSubcommandNames(cmd)).toEqual([
      "check", "open", "close", "list", "status",
    ]);
  });

  it("open has a target argument and --port option (no -P short alias)", () => {
    const open = findCommand(cmd, ["open"])!;
    expect(open.registeredArguments.length).toBeGreaterThanOrEqual(1);
    expect(hasFlag(open, "--port")).toBe(true);
    expect(hasFlag(open, "-P")).toBe(false);
  });

  it("open has --force option", () => {
    const open = findCommand(cmd, ["open"])!;
    expect(hasFlag(open, "--force")).toBe(true);
  });

  it("open help explains session creation and jadx passthrough behavior", () => {
    const open = findCommand(cmd, ["open"])!;
    const help = open.helpInformation();
    expect(help).toContain("record a reusable session");
    expect(help).toContain("forwarded to jadx-cli");
    expect(help).toContain("Session name used by -s/--session");
    expect(help).toContain("Also start MCP Streamable HTTP server on port + 1");
  });

  it("close has optional [name] argument", () => {
    const close = findCommand(cmd, ["close"])!;
    expect(close.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// decx code
// ============================================================================

describe("code", () => {
  let cmd: Command;

  beforeEach(() => {
    cmd = findCommand(createProgram(), ["code"])!;
  });

  it("registers 14 subcommands", () => {
    expect(getSubcommandNames(cmd)).toEqual([
      "classes", "search-global", "class-context", "class-source",
      "method-source", "method-context", "method-cfg",
      "search-class", "search-method", "xref-method", "xref-class",
      "xref-field", "implementations", "subclasses",
    ]);
  });

  it("class-context has <class> argument", () => {
    const info = findCommand(cmd, ["class-context"])!;
    expect(info.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("class-source has <class> argument", () => {
    const src = findCommand(cmd, ["class-source"])!;
    expect(src.registeredArguments.length).toBeGreaterThanOrEqual(1);
    expect(hasFlag(src, "--limit")).toBe(true);
  });

  it("method-source has <signature> argument", () => {
    const ms = findCommand(cmd, ["method-source"])!;
    expect(ms.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("search-global has <keyword> argument", () => {
    const sg = findCommand(cmd, ["search-global"])!;
    expect(sg.registeredArguments.length).toBeGreaterThanOrEqual(1);
    const help = sg.helpInformation();
    expect(help).toContain("Search class names");
    expect(help).toContain("decompiled class bodies");
  });

  it("method-context has <signature> argument", () => {
    const mc = findCommand(cmd, ["method-context"])!;
    expect(mc.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("method-cfg has <signature> argument", () => {
    const mc = findCommand(cmd, ["method-cfg"])!;
    expect(mc.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("implementations has <interface> argument", () => {
    const impl = findCommand(cmd, ["implementations"])!;
    expect(impl.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("subclasses has <class> argument", () => {
    const sub = findCommand(cmd, ["subclasses"])!;
    expect(sub.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("help distinguishes discovery, source, context, cfg, and xref commands", () => {
    const help = cmd.helpInformation();
    expect(help).toContain("List decompiled classes with optional package filters");
    expect(help).toContain("Return decompiled Java or smali source for one method");
    expect(help).toContain("Show callers, callees, and metadata for one method");
    expect(help).toContain("Return the control-flow graph for one method");
    expect(help).toContain("Find callers and references to one method");
  });
});

// ============================================================================
// decx android
// ============================================================================

describe("android", () => {
  let cmd: Command;

  beforeEach(() => {
    cmd = findCommand(createProgram(), ["android"])!;
  });

  it("registers app, device, resource, and framework commands", () => {
    expect(getSubcommandNames(cmd)).toEqual([
      "manifest", "launcher-activity", "application",
      "exported-components", "deep-links", "dynamic-receivers",
      "framework-service-implementation", "device",
      "resources", "resource-file", "strings", "aidl-interfaces", "framework",
    ]);
  });

  it("framework-service-implementation has <interface> argument", () => {
    const service = findCommand(cmd, ["framework-service-implementation"])!;
    expect(service.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("resource-file has <res> argument", () => {
    const rf = findCommand(cmd, ["resource-file"])!;
    expect(rf.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("resources includes file name filter options", () => {
    const resources = findCommand(cmd, ["resources"])!;
    expect(hasFlag(resources, "--include")).toBe(true);
    expect(hasFlag(resources, "--no-regex")).toBe(true);
  });

  it("device permission-info has <permission> and adb options", () => {
    const permissionInfo = findCommand(cmd, ["device", "permission-info"])!;
    expect(permissionInfo.registeredArguments.length).toBeGreaterThanOrEqual(1);
    expect(hasFlag(permissionInfo, "--adb-path")).toBe(true);
    expect(hasFlag(permissionInfo, "--serial")).toBe(true);
  });

  it("device system-services includes adb options", () => {
    const systemServices = findCommand(cmd, ["device", "system-services"])!;
    expect(systemServices.registeredArguments.length).toBe(0);
    expect(hasFlag(systemServices, "--adb-path")).toBe(true);
    expect(hasFlag(systemServices, "--serial")).toBe(true);
    expect(hasFlag(systemServices, "--grep")).toBe(true);
  });

  it("framework registers collect/process/run/open subcommands", () => {
    const framework = findCommand(cmd, ["framework"])!;
    expect(getSubcommandNames(framework)).toEqual([
      "collect", "process", "run", "open",
    ]);
  });

  it("framework collect has no positional argument and includes source/device options", () => {
    const collect = findCommand(cmd, ["framework", "collect"])!;
    expect(collect.registeredArguments.length).toBe(0);
    expect(hasFlag(collect, "--brand")).toBe(false);
    expect(hasFlag(collect, "--vendor")).toBe(false);
    expect(hasFlag(collect, "--source-dir")).toBe(true);
    expect(hasFlag(collect, "--adb-path")).toBe(true);
    expect(hasFlag(collect, "--clean-source")).toBe(true);
  });

  it("framework process takes an optional oem argument", () => {
    const process = findCommand(cmd, ["framework", "process"])!;
    expect(process.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("framework run has no positional argument and open control options", () => {
    const run = findCommand(cmd, ["framework", "run"])!;
    expect(run.registeredArguments.length).toBe(0);
    expect(hasFlag(run, "--no-open")).toBe(true);
    expect(hasFlag(run, "--name")).toBe(true);
    expect(hasFlag(run, "--port")).toBe(true);
  });

  it("help distinguishes APK, live-device, and framework-analysis commands", () => {
    const help = cmd.helpInformation();
    expect(help).toContain("Return the APK AndroidManifest.xml");
    expect(help).toContain("Inspect live state from an adb-connected Android device");
    expect(help).toContain("Collect, process, pack, and open Android framework artifacts");
  });

  it("framework run help explains the full device pipeline and output controls", () => {
    const run = findCommand(cmd, ["framework", "run"])!;
    const help = run.helpInformation();
    expect(help).toContain("Run the full device framework pipeline");
    expect(help).toContain("Only build the framework jar");
    expect(help.replace(/\s+/g, " ")).toContain("Directory for processed framework artifacts and packed jar output");
  });
});

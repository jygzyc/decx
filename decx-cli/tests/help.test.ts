/**
 * CLI command structure tests.
 *
 * Tests the command tree structure rather than help text output.
 * This decouples tests from description wording and commander internals.
 */

import { Command } from "commander";
import { makeProcessCommand } from "../src/commands/process.js";
import { makeCodeCommand } from "../src/commands/code.js";
import { makeArdCommand } from "../src/commands/ard.js";
import { makeSelfCommand } from "../src/commands/self.js";

function createProgram(): Command {
  const program = new Command();
  program.name("decx").version("2.0.0");
  program.addCommand(makeProcessCommand());
  program.addCommand(makeCodeCommand());
  program.addCommand(makeArdCommand());
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

// ============================================================================
// Root
// ============================================================================

describe("root", () => {
  it("registers 4 top-level commands", () => {
    const program = createProgram();
    expect(getSubcommandNames(program)).toEqual(["process", "code", "ard", "self"]);
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

  it("open has <file> argument and -P/--port option", () => {
    const open = findCommand(cmd, ["open"])!;
    expect(open.registeredArguments.length).toBeGreaterThanOrEqual(1);
    expect(hasFlag(open, "--port")).toBe(true);
  });

  it("open has --force option", () => {
    const open = findCommand(cmd, ["open"])!;
    expect(hasFlag(open, "--force")).toBe(true);
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
      "xref-field", "implement", "subclass",
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
  });

  it("method-context has <signature> argument", () => {
    const mc = findCommand(cmd, ["method-context"])!;
    expect(mc.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("method-cfg has <signature> argument", () => {
    const mc = findCommand(cmd, ["method-cfg"])!;
    expect(mc.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("implement has <interface> argument", () => {
    const impl = findCommand(cmd, ["implement"])!;
    expect(impl.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("subclass has <class> argument", () => {
    const sub = findCommand(cmd, ["subclass"])!;
    expect(sub.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// decx ard
// ============================================================================

describe("ard", () => {
  let cmd: Command;

  beforeEach(() => {
    cmd = findCommand(createProgram(), ["ard"])!;
  });

  it("registers adb and framework subcommands under ard", () => {
    expect(getSubcommandNames(cmd)).toEqual([
      "app-manifest", "main-activity", "app-application",
      "exported-components", "app-deeplinks", "app-receivers",
      "system-service-impl", "system-services", "perm-info",
      "all-resources", "resource-file", "strings", "get-aidl", "framework",
    ]);
  });

  it("system-service-impl has <interface> argument", () => {
    const ssi = findCommand(cmd, ["system-service-impl"])!;
    expect(ssi.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("resource-file has <res> argument", () => {
    const rf = findCommand(cmd, ["resource-file"])!;
    expect(rf.registeredArguments.length).toBeGreaterThanOrEqual(1);
  });

  it("all-resources includes file name filter options", () => {
    const allResources = findCommand(cmd, ["all-resources"])!;
    expect(hasFlag(allResources, "--include")).toBe(true);
    expect(hasFlag(allResources, "--no-regex")).toBe(true);
  });

  it("perm-info has <permission> argument and adb device options", () => {
    const permInfo = findCommand(cmd, ["perm-info"])!;
    expect(permInfo.registeredArguments.length).toBeGreaterThanOrEqual(1);
    expect(hasFlag(permInfo, "--adb-path")).toBe(true);
    expect(hasFlag(permInfo, "--serial")).toBe(true);
  });

  it("system-services includes adb device options", () => {
    const systemServices = findCommand(cmd, ["system-services"])!;
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

  it("framework process requires <oem>", () => {
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
});

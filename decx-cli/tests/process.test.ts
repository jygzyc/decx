/**
 * Process command unit tests.
 *
 * Tests command structure, option registration, and error handling.
 * Does NOT spawn real DECX server processes — server interaction is mocked.
 */

import { Command } from "commander";
import { makeProcessCommand, normalizeJadxPassthroughArgs } from "../src/commands/process.js";

function createProgram(): Command {
  const program = new Command();
  program.name("decx").version("2.0.0");
  program.addCommand(makeProcessCommand());
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

// ============================================================================
// Command structure
// ============================================================================

describe("process command structure", () => {
  let processCmd: Command;

  beforeEach(() => {
    processCmd = findCommand(createProgram(), ["process"])!;
  });

  it("registers 5 subcommands (check, open, close, list, status)", () => {
    const names = getSubcommandNames(processCmd);
    expect(names).toEqual([
      "check", "open", "close", "list", "status",
    ]);
  });

  // ── check ────────────────────────────────────────────────────────────────

  describe("check", () => {
    it("has -P/--port option", () => {
      const check = findCommand(processCmd, ["check"])!;
      const flags = getOptionFlags(check);
      expect(flags.some(f => f.includes("--port"))).toBe(true);
    });
  });

  // ── open ─────────────────────────────────────────────────────────────────

  describe("open", () => {
    it("has <file> argument", () => {
      const open = findCommand(processCmd, ["open"])!;
      expect(open.registeredArguments.length).toBeGreaterThanOrEqual(1);
    });

    it("has --port, --force, --name options", () => {
      const open = findCommand(processCmd, ["open"])!;
      const flags = getOptionFlags(open);
      expect(flags.some(f => f.includes("--port"))).toBe(true);
      expect(flags.some(f => f.includes("--force"))).toBe(true);
      expect(flags.some(f => f.includes("--name"))).toBe(true);
    });
  });

  // ── close ────────────────────────────────────────────────────────────────

  describe("close", () => {
    it("has optional [name] argument, --port option, and --all option", () => {
      const close = findCommand(processCmd, ["close"])!;
      expect(close.registeredArguments.length).toBeGreaterThanOrEqual(1);
      const flags = getOptionFlags(close);
      expect(flags.some(f => f.includes("--all"))).toBe(true);
      expect(flags.some(f => f.includes("--port"))).toBe(true);
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("has no options", () => {
      const list = findCommand(processCmd, ["list"])!;
      expect(getOptionFlags(list)).toEqual([]);
    });
  });

  // ── status ───────────────────────────────────────────────────────────────

  describe("status", () => {
    it("has optional [name] argument and --port option", () => {
      const status = findCommand(processCmd, ["status"])!;
      expect(status.registeredArguments.length).toBeGreaterThanOrEqual(1);
      const flags = getOptionFlags(status);
      expect(flags.some(f => f.includes("--port"))).toBe(true);
    });
  });

});

// ============================================================================
// Jadx passthrough defaults
// ============================================================================

describe("normalizeJadxPassthroughArgs", () => {
  it("adds --show-bad-code by default", () => {
    expect(normalizeJadxPassthroughArgs(["--deobf"])).toEqual([
      "--deobf",
      "--show-bad-code",
    ]);
  });

  it("does not duplicate --show-bad-code when already provided", () => {
    expect(normalizeJadxPassthroughArgs(["--deobf", "--show-bad-code"])).toEqual([
      "--deobf",
      "--show-bad-code",
    ]);
  });
});

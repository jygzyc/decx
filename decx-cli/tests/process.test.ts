/**
 * Process command unit tests.
 *
 * Tests command structure, option registration, and error handling.
 * Does NOT spawn real DECX server processes — server interaction is mocked.
 */

import { Command } from "commander";
import { createServer, type Server } from "net";
import { makeProcessCommand } from "../src/commands/process.js";
import {
  buildDecxServerJavaArgs,
  defaultJavaHeap,
  extractPassthroughArgs,
  normalizeJadxPassthroughArgs,
  selectAvailableServerPort,
} from "../src/core/launcher.js";
import { parseServerPort } from "../src/core/ports.js";

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
    it("has a target argument", () => {
      const open = findCommand(processCmd, ["open"])!;
      expect(open.registeredArguments.length).toBeGreaterThanOrEqual(1);
    });

    it("has --port, --force, --name, and --mcp options", () => {
      const open = findCommand(processCmd, ["open"])!;
      const flags = getOptionFlags(open);
      expect(flags.some(f => f.includes("--port"))).toBe(true);
      expect(flags.some(f => f.includes("--force"))).toBe(true);
      expect(flags.some(f => f.includes("--name"))).toBe(true);
      expect(flags.some(f => f.includes("--mcp"))).toBe(true);
      expect(flags.some(f => f.includes("--heap"))).toBe(false);
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
  it("adds --show-bad-code by default without enabling deobfuscation", () => {
    expect(normalizeJadxPassthroughArgs(["--deobf"])).toEqual([
      "--show-bad-code",
      "--no-imports",
      "-Pdex-input.verify-checksum=no",
    ]);
  });

  it("adds --no-imports by default", () => {
    expect(normalizeJadxPassthroughArgs([])).toContain("--no-imports");
  });

  it("adds checksum verification disable option by default", () => {
    expect(normalizeJadxPassthroughArgs(["--deobf"])).toContain("-Pdex-input.verify-checksum=no");
  });

  it("does not duplicate default jadx options when already provided", () => {
    expect(normalizeJadxPassthroughArgs([
      "--deobf",
      "--show-bad-code",
      "--no-imports",
      "-Pdex-input.verify-checksum=no",
    ])).toEqual([
      "--show-bad-code",
      "--no-imports",
      "-Pdex-input.verify-checksum=no",
    ]);
  });

  it("removes deobfuscation passthrough because DECX requires original names", () => {
    expect(normalizeJadxPassthroughArgs([
      "--threads-count",
      "4",
      "--deobf",
      "--no-imports",
    ])).toEqual([
      "--threads-count",
      "4",
      "--no-imports",
      "--show-bad-code",
      "-Pdex-input.verify-checksum=no",
    ]);
  });
});

describe("extractPassthroughArgs", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("passes unknown options through to jadx", () => {
    process.argv = [
      "node",
      "decx",
      "process",
      "open",
      "app.apk",
      "--deobf",
    ];

    expect(extractPassthroughArgs()).toEqual(["--deobf"]);
  });

  it("strips --mcp so it is not forwarded to jadx", () => {
    process.argv = [
      "node",
      "decx",
      "process",
      "open",
      "app.apk",
      "--mcp",
      "--deobf",
    ];

    expect(extractPassthroughArgs()).toEqual(["--deobf"]);
  });

  it("strips --no-mcp so it is not forwarded to jadx", () => {
    process.argv = [
      "node",
      "decx",
      "process",
      "open",
      "app.apk",
      "--no-mcp",
      "--deobf",
    ];

    expect(extractPassthroughArgs()).toEqual(["--deobf"]);
  });
});

describe("buildDecxServerJavaArgs", () => {
  it("uses two thirds of machine memory rounded down by default", () => {
    expect(buildDecxServerJavaArgs("server.jar", "app.apk", 25419, ["--show-bad-code"])).toEqual([
      `-Xmx${defaultJavaHeap()}`,
      "-jar",
      "server.jar",
      "app.apk",
      "--port",
      "25419",
      "--show-bad-code",
    ]);
  });

  it("omits --mcp by default (MCP disabled unless explicitly enabled)", () => {
    const args = buildDecxServerJavaArgs("server.jar", "app.apk", 25419, []);
    expect(args).not.toContain("--mcp");
  });

  it("omits --mcp when mcp is false or undefined", () => {
    expect(buildDecxServerJavaArgs("server.jar", "app.apk", 25419, [], false))
      .not.toContain("--mcp");
    expect(buildDecxServerJavaArgs("server.jar", "app.apk", 25419, [], undefined))
      .not.toContain("--mcp");
  });

  it("includes --mcp between --port and jadx args when mcp is true", () => {
    expect(buildDecxServerJavaArgs("server.jar", "app.apk", 25419, ["--show-bad-code"], true)).toEqual([
      `-Xmx${defaultJavaHeap()}`,
      "-jar",
      "server.jar",
      "app.apk",
      "--port",
      "25419",
      "--mcp",
      "--show-bad-code",
    ]);
  });
});

describe("parseServerPort", () => {
  it("accepts numeric ports greater than 1000", () => {
    expect(parseServerPort("1001")).toBe(1001);
    expect(parseServerPort(65535)).toBe(65535);
  });

  it("rejects partial, non-numeric, and out-of-range ports", () => {
    expect(() => parseServerPort("1001abc")).toThrow("Invalid port: 1001abc");
    expect(() => parseServerPort("abc")).toThrow("Invalid port: abc");
    expect(() => parseServerPort("1000")).toThrow("Invalid port: 1000");
    expect(() => parseServerPort("65536")).toThrow("Invalid port: 65536");
  });
});

describe("selectAvailableServerPort", () => {
  async function listen(port: number): Promise<{ server: Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen({ port, host: "127.0.0.1" }, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to read test server port"));
          return;
        }
        resolve({ server, port: address.port });
      });
    });
  }

  async function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }

  it("keeps the preferred port when it is available", async () => {
    const { server, port } = await listen(0);
    await close(server);

    const selected = await selectAvailableServerPort(port);
    expect(selected).toBe(port);
  });

  it("falls back to a random port when the preferred port is occupied", async () => {
    const { server, port } = await listen(0);
    try {
      const selected = await selectAvailableServerPort(port);
      expect(selected).not.toBe(port);
      expect(selected).toBeGreaterThan(1000);
      expect(selected).toBeLessThanOrEqual(65535);
    } finally {
      await close(server);
    }
  });

  it("chooses a random base port whose MCP companion port is also available", async () => {
    const { server, port } = await listen(0);
    try {
      const selected = await selectAvailableServerPort(port - 1, true);
      expect(selected).not.toBe(port - 1);
      expect(selected).toBeGreaterThan(1000);
      expect(selected).toBeLessThan(65535);
    } finally {
      await close(server);
    }
  });

  it("rejects ports at or below 1000", async () => {
    await expect(selectAvailableServerPort(1000)).rejects.toThrow("Invalid port: 1000");
  });
});

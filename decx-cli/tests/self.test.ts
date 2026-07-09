import { jest } from "@jest/globals";
import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import {
  buildCliUpdateArgs,
  executeSelfInstall,
  getCliPackageMetadata,
  resolveNpmUpdateCommand,
} from "../src/commands/self.js";
import { VERSION } from "../src/core/version.js";
import { resetTestDir, testPath } from "./test-paths.js";

describe("self command metadata", () => {
  it("uses npm env package name and project version from VERSION", () => {
    expect(getCliPackageMetadata({
      npm_package_name: "@custom/decx-cli",
      npm_package_version: "9.9.9",
    } as NodeJS.ProcessEnv)).toEqual({
      name: "@custom/decx-cli",
      version: VERSION,
    });
  });

  it("falls back to package.json package name when npm env is missing", () => {
    const { name, version } = getCliPackageMetadata({} as NodeJS.ProcessEnv);
    expect(name).toBe("@jygzyc/decx-cli");
    expect(version).toBe(VERSION);
  });

  it("finds package metadata from the bundled dist directory", () => {
    const distDir = resetTestDir("tmp", "self-dist");
    const nestedDir = path.join(distDir, "commands");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(path.join(distDir, "package.json"), JSON.stringify({
      name: "@custom/bundled-decx",
      version: "1.2.3",
    }));

    expect(getCliPackageMetadata({} as NodeJS.ProcessEnv, nestedDir)).toEqual({
      name: "@custom/bundled-decx",
      version: VERSION,
    });
  });

  it("builds npm install args from the package name", () => {
    expect(buildCliUpdateArgs("@custom/decx-cli")).toEqual([
      "install",
      "-g",
      "@custom/decx-cli@latest",
    ]);
  });

  it("runs npm through its JS entrypoint from npm_execpath when available", () => {
    const cmd = resolveNpmUpdateCommand("@custom/decx-cli", {
      env: { npm_execpath: "/tmp/npm-cli.js", PATH: "" },
      execPath: "/node/bin/node",
      platform: "darwin",
      exists: (p) => p === "/tmp/npm-cli.js",
    });

    expect(cmd.command).toBe("/node/bin/node");
    expect(cmd.args).toEqual([
      "/tmp/npm-cli.js",
      "install",
      "-g",
      "@custom/decx-cli@latest",
    ]);
    expect(cmd.shell).toBe(false);
  });

  it("prefers npm-cli.js installed next to the node binary over the npm shim", () => {
    const nodeDir = "/node/bin";
    const cliJs = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    const cmd = resolveNpmUpdateCommand("@custom/decx-cli", {
      env: { PATH: "" },
      execPath: `${nodeDir}/node`,
      platform: "linux",
      exists: (p) => p === cliJs,
    });

    expect(cmd.command).toBe(`${nodeDir}/node`);
    expect(cmd.args).toEqual([
      cliJs,
      "install",
      "-g",
      "@custom/decx-cli@latest",
    ]);
    expect(cmd.shell).toBe(false);
    expect(cmd.env.PATH?.split(path.delimiter)[0]).toBe(nodeDir);
  });

  it("probes ../lib/node_modules when npm is not in the node bin dir (Unix homebrew/nvm layout)", () => {
    const execPath = "/node/bin/node";
    const nodeDir = path.dirname(execPath);
    // Mirror the candidate the implementation builds so the assertion is
    // path-separator agnostic (win32 vs posix) under jest.
    const cliJs = path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    const cmd = resolveNpmUpdateCommand("@custom/decx-cli", {
      env: { PATH: "" },
      execPath,
      platform: "darwin",
      exists: (p) => p === cliJs,
    });

    expect(cmd.command).toBe(execPath);
    expect(cmd.args[0]).toBe(cliJs);
    expect(cmd.shell).toBe(false);
  });

  it("falls back to the npm shim and requires no shell on Unix", () => {
    const execPath = "/node/bin/node";
    const nodeDir = path.dirname(execPath);
    const npmShim = path.join(nodeDir, "npm");
    const cmd = resolveNpmUpdateCommand("@custom/decx-cli", {
      env: { PATH: "" },
      execPath,
      platform: "darwin",
      exists: (p) => p === npmShim,
    });

    expect(cmd.command).toBe(npmShim);
    expect(cmd.args).toEqual([
      "install",
      "-g",
      "@custom/decx-cli@latest",
    ]);
    expect(cmd.shell).toBe(false);
    expect(cmd.env.PATH?.split(path.delimiter)[0]).toBe(nodeDir);
  });

  it("falls back to npm.cmd on Windows and requires a shell (batch file)", () => {
    const nodeDir = "D:\\node";
    const cmd = resolveNpmUpdateCommand("@custom/decx-cli", {
      env: { PATH: "" },
      execPath: `${nodeDir}\\node.exe`,
      platform: "win32",
      exists: (p) => p === `${nodeDir}\\npm.cmd`,
    });

    expect(cmd.command).toBe(`${nodeDir}\\npm.cmd`);
    expect(cmd.args).toEqual([
      "install",
      "-g",
      "@custom/decx-cli@latest",
    ]);
    // npm.cmd is a batch file: Node 20.12+/22+/24+ refuses to spawn it
    // without a shell, so this MUST be true.
    expect(cmd.shell).toBe(true);
  });

  it("resolves to npm.cmd via bare fallback when nothing exists and uses a shell on Windows", () => {
    const cmd = resolveNpmUpdateCommand("@custom/decx-cli", {
      env: { PATH: "" },
      execPath: "D:\\node\\node.exe",
      platform: "win32",
      exists: () => false,
    });

    expect(cmd.command).toBe("npm.cmd");
    expect(cmd.shell).toBe(true);
  });

  it("updates stored server version and returns a real install path on self install", async () => {
    const updateServerVersion = jest.fn();
    const jarPath = testPath("install", "self", "decx-server.jar");
    const result = await executeSelfInstall(false, {
      installDecxServerFn: async () => ({
        ok: true,
        version: "0.0.0",
        path: jarPath,
        message: `Installed decx-server v0.0.0 to ${jarPath}`,
      }),
      manager: { updateServerVersion },
    });

    expect(updateServerVersion).toHaveBeenCalledWith("0.0.0");
    expect(result).toEqual({
      ok: true,
      version: "0.0.0",
      path: jarPath,
      message: `Installed decx-server v0.0.0 to ${jarPath}`,
    });
  });

});

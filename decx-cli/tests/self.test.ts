import { jest } from "@jest/globals";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import {
  buildCliUpdateArgs,
  executeSelfInstall,
  getCliPackageMetadata,
  npmUpdateNeedsShell,
  resolveNpmUpdateCommand,
} from "../src/commands/self.js";
import { VERSION } from "../src/core/version.js";
import { resetTestDir, testPath } from "./test-paths.js";
import { installSkills, parseSkillClients, skillClientDirectory } from "../src/core/skills-installer.js";

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

  it("runs npm through npm_execpath when npm provides one", () => {
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
  });

  it("falls back to npm next to the current node binary when PATH may not contain npm", () => {
    const cmd = resolveNpmUpdateCommand("@custom/decx-cli", {
      env: { PATH: "" },
      execPath: "/node/bin/node",
      platform: "darwin",
      exists: (p) => p === "/node/bin/npm",
    });

    expect(cmd.command).toBe("/node/bin/npm");
    expect(cmd.args).toEqual([
      "install",
      "-g",
      "@custom/decx-cli@latest",
    ]);
    expect(cmd.env.PATH?.split(path.delimiter)[0]).toBe("/node/bin");
  });

  it("requires a shell for .cmd shims on Windows but not for node binaries", () => {
    expect(npmUpdateNeedsShell("C:\\Program Files\\nodejs\\npm.cmd", "win32")).toBe(true);
    expect(npmUpdateNeedsShell("C:\\Program Files\\nodejs\\npm.bat", "win32")).toBe(true);
    expect(npmUpdateNeedsShell("C:\\Program Files\\nodejs\\npm", "win32")).toBe(false);
    expect(npmUpdateNeedsShell("/usr/bin/npm", "darwin")).toBe(false);
    expect(npmUpdateNeedsShell("/usr/bin/npm", "linux")).toBe(false);
  });

  it("uses dedicated clients explicitly and maps all other or empty selections to agents", () => {
    expect(parseSkillClients(["opencode,codex", "claude", "other-client"])).toEqual([
      "agents",
      "codex",
      "claude-code",
    ]);
    expect(parseSkillClients([])).toEqual(["agents"]);
    expect(parseSkillClients(["unknown"])).toEqual(["agents"]);
  });

  it("installs downloaded skills into each selected client directory", () => {
    const root = resetTestDir("tmp", "self-skills");
    const sourceDir = path.join(root, "source");
    const home = path.join(root, "home");
    mkdirSync(path.join(sourceDir, "decx-cli"), { recursive: true });
    mkdirSync(path.join(sourceDir, "not-a-skill"), { recursive: true });
    writeFileSync(path.join(sourceDir, "decx-cli", "SKILL.md"), "# DECX CLI\n");

    const result = installSkills(["agents", "codex"], { sourceDir, home });

    expect(result.skills).toEqual(["decx-cli"]);
    expect(result.sourcePath).toBe(path.join(home, ".decx", "skills"));
    expect(existsSync(path.join(result.sourcePath, "decx-cli", "SKILL.md"))).toBe(true);
    expect(lstatSync(path.join(skillClientDirectory("agents", home), "decx-cli")).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(skillClientDirectory("codex", home), "decx-cli")).isSymbolicLink()).toBe(true);
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

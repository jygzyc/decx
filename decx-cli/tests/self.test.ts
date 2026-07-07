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

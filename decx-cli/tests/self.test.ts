import { jest } from "@jest/globals";
import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { buildCliUpdateArgs, executeSelfInstall, getCliPackageMetadata } from "../src/commands/self.js";
import { resetTestDir, testPath } from "./test-paths.js";

describe("self command metadata", () => {
  it("prefers npm env metadata when available", () => {
    expect(getCliPackageMetadata({
      npm_package_name: "@custom/decx-cli",
      npm_package_version: "9.9.9",
    } as NodeJS.ProcessEnv)).toEqual({
      name: "@custom/decx-cli",
      version: "9.9.9",
    });
  });

  it("falls back to package.json metadata when npm env is missing", () => {
    const { name, version } = getCliPackageMetadata({} as NodeJS.ProcessEnv);
    expect(name).toBe("@jygzyc/decx-cli");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
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
      version: "1.2.3",
    });
  });

  it("builds npm install args from the package name", () => {
    expect(buildCliUpdateArgs("@custom/decx-cli")).toEqual([
      "install",
      "-g",
      "@custom/decx-cli@latest",
    ]);
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

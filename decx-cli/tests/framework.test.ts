import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { cleanFrameworkOutputs, cleanFrameworkTempDirs } from "../src/android/framework-processor.js";
import { getOemSearchPaths, normalizeOem } from "../src/android/framework-collector.js";
import { resolveFrameworkJarPath, resolveFrameworkLayout, resolveProcessOem, summarizeFrameworkArtifact } from "../src/android/framework.js";
import { resolveFrameworkTools, translateWslArgs, windowsPathToWsl } from "../src/android/framework-tools.js";
import { resetTestDir, testPath } from "./test-paths.js";

function writeArtifact(outDir: string, vendor: string, oem: string = "xiaomi"): string {
  const jarPath = path.join(outDir, `framework_${oem}_${vendor.toLowerCase().replace(/\s+/g, "_")}.jar`);
  writeFileSync(
    path.join(outDir, ".artifact.json"),
    JSON.stringify({
      name: `framework_${oem}_${vendor.toLowerCase().replace(/\s+/g, "_")}`,
      oem,
      vendor,
      rootDir: outDir,
      jarPath,
      updatedAt: Date.now(),
    }),
    "utf-8",
  );
  return jarPath;
}

describe("framework OEM handling", () => {
  it("normalizes supported OEM names", () => {
    expect(normalizeOem("XIAOMI")).toBe("xiaomi");
    expect(normalizeOem("google")).toBe("google");
    expect(normalizeOem("Samsung")).toBe("samsung");
  });

  it("rejects unsupported OEM names", () => {
    expect(() => normalizeOem("meizu")).toThrow("Unsupported OEM");
  });

  it("resolves the process oem from the explicit argument", async () => {
    await expect(resolveProcessOem({ oem: "XIAOMI" })).resolves.toBe("xiaomi");
  });

  it("resolves the process oem from the persisted .artifact.json when omitted", async () => {
    const outDir = resetTestDir("tmp", "decx-fw-process-artifact");
    writeArtifact(outDir, "K70 Ultra", "xiaomi");

    await expect(
      resolveProcessOem({ outDir }, async () => { throw new Error("device should not be queried"); }),
    ).resolves.toBe("xiaomi");

    rmSync(outDir, { recursive: true, force: true });
  });

  it("resolves the process oem from a connected device when no artifact is present", async () => {
    const outDir = resetTestDir("tmp", "decx-fw-process-detect");
    await expect(
      resolveProcessOem({ outDir }, async () => "samsung"),
    ).resolves.toBe("samsung");

    rmSync(outDir, { recursive: true, force: true });
  });

  it("fails with a clear error when the process oem cannot be resolved", async () => {
    const outDir = resetTestDir("tmp", "decx-fw-process-error");
    await expect(
      resolveProcessOem({ outDir }, async () => { throw new Error("no device"); }),
    ).rejects.toThrow("Framework OEM could not be resolved");

    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("framework OEM search paths", () => {
  const defaultDirs = ["/system/framework", "/system/apex", "/vendor/framework", "/system_ext/framework"];

  it("uses the default collection directories for non-listed OEMs", () => {
    for (const oem of ["vivo", "honor", "google", "samsung"] as const) {
      expect(getOemSearchPaths(oem)).toEqual(defaultDirs);
    }
  });

  it("keeps the oppo and xiaomi overrides", () => {
    expect(getOemSearchPaths("oppo")).toEqual(["/system/framework", "/system/apex", "/system_ext/framework"]);
    expect(getOemSearchPaths("xiaomi")).toEqual(["/system/framework", "/system/apex", "/system_ext/framework", "/vendor/framework"]);
  });
});

describe("framework artifact layout", () => {
  it("derives source, temp, and jar paths from out-dir", () => {
    const outDir = testPath("tmp", "decx-fw");
    const layout = resolveFrameworkLayout({ outDir });
    expect(layout.rootDir).toBe(outDir);
    expect(layout.sourceDir).toBe(path.join(outDir, "source"));
    expect(layout.outTmpDir).toBe(path.join(outDir, "out_tmp"));
    expect(layout.apexTmpDir).toBe(path.join(outDir, "apex_tmp"));
    expect(layout.artifactPath).toBe(path.join(outDir, ".artifact.json"));
    expect(layout.jarPath).toBe(path.join(outDir, "framework_google_unknown.jar"));
  });

  it("uses oem as brand and defaults vendor to unknown without persisted artifact", () => {
    const outDir = testPath("tmp", "decx-fw-xiaomi");
    const layout = resolveFrameworkLayout({
      oem: "xiaomi",
      outDir,
    });
    expect(layout.jarPath).toBe(path.join(outDir, "framework_xiaomi_unknown.jar"));
  });

  it("ignores legacy meta files when no artifact exists", () => {
    const outDir = resetTestDir("tmp", "decx-fw-legacy-meta");
    writeFileSync(path.join(outDir, ".meta.json"), JSON.stringify({ vendor: "K70 Ultra" }), "utf-8");

    const layout = resolveFrameworkLayout({ oem: "xiaomi", outDir });
    expect(layout.jarPath).toBe(path.join(outDir, "framework_xiaomi_unknown.jar"));

    rmSync(outDir, { recursive: true, force: true });
  });

  it("uses oem as brand and reuses vendor from persisted artifact", () => {
    const outDir = resetTestDir("tmp", "decx-fw-meta");
    writeArtifact(outDir, "K70 Ultra");

    const layout = resolveFrameworkLayout({ oem: "xiaomi", outDir });
    expect(layout.jarPath).toBe(path.join(outDir, "framework_xiaomi_k70_ultra.jar"));

    rmSync(outDir, { recursive: true, force: true });
  });

  it("builds an artifact summary with oem, vendor, and jar path", () => {
    const outDir = resetTestDir("tmp", "decx-fw-summary");
    writeArtifact(outDir, "K70 Ultra");
    const layout = resolveFrameworkLayout({ oem: "xiaomi", outDir });

    expect(summarizeFrameworkArtifact(layout, "xiaomi")).toEqual({
      session: "framework_xiaomi_k70_ultra",
      oem: "xiaomi",
      vendor: "k70_ultra",
      jarPath: path.join(outDir, "framework_xiaomi_k70_ultra.jar"),
    });

    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("framework jar resolution", () => {
  it("resolves an explicit framework jar path without device detection", async () => {
    const jarPath = testPath("tmp", "custom.jar");
    await expect(resolveFrameworkJarPath(jarPath, {})).resolves.toBe(jarPath);
  });

  it("resolves the generated framework jar using detected device oem", async () => {
    const outDir = resetTestDir("tmp", "decx-fw-open");
    const expectedJar = writeArtifact(outDir, "K70 Ultra");
    writeFileSync(expectedJar, "", "utf-8");

    await expect(
      resolveFrameworkJarPath(undefined, { outDir }, async () => "xiaomi"),
    ).resolves.toBe(expectedJar);

    rmSync(outDir, { recursive: true, force: true });
  });

  it("falls back to the persisted artifact record when the computed jar path changed", async () => {
    const outDir = resetTestDir("tmp", "decx-fw-artifact-fallback");
    const expectedJar = writeArtifact(outDir, "k70_ultra");
    writeFileSync(expectedJar, "", "utf-8");

    await expect(
      resolveFrameworkJarPath(undefined, { outDir }, async () => "xiaomi"),
    ).resolves.toBe(expectedJar);

    rmSync(outDir, { recursive: true, force: true });
  });

  it("fails with a clear error when no generated framework jar exists", async () => {
    const outDir = resetTestDir("tmp", "decx-fw-open-missing");

    await expect(
      resolveFrameworkJarPath(undefined, { outDir }, async () => "xiaomi"),
    ).rejects.toThrow("No generated framework jar found for OEM 'xiaomi'");

    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("framework build cleanup", () => {
  it("removes all tmp directories after packing cleanup", () => {
    const outDir = resetTestDir("tmp", "decx-fw-clean-pack");
    const layout = resolveFrameworkLayout({ outDir });
    mkdirSync(layout.outTmpDir, { recursive: true });
    mkdirSync(layout.apexTmpDir, { recursive: true });

    cleanFrameworkTempDirs(layout);

    expect(existsSync(layout.outTmpDir)).toBe(false);
    expect(existsSync(layout.apexTmpDir)).toBe(false);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("optionally removes source during final cleanup", () => {
    const outDir = resetTestDir("tmp", "decx-fw-clean-source");
    const layout = resolveFrameworkLayout({ outDir });
    mkdirSync(layout.sourceDir, { recursive: true });
    mkdirSync(layout.outTmpDir, { recursive: true });
    mkdirSync(layout.apexTmpDir, { recursive: true });

    cleanFrameworkOutputs(layout, true);

    expect(existsSync(layout.sourceDir)).toBe(false);
    expect(existsSync(layout.outTmpDir)).toBe(false);
    expect(existsSync(layout.apexTmpDir)).toBe(false);
    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("framework platform support", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("throws WSL guidance on Windows when WSL is unavailable", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(() => resolveFrameworkTools(undefined, { wslAvailable: false })).toThrow("Windows requires WSL");
  });
});

describe("wsl path translation", () => {
  it("converts Windows drive paths to WSL /mnt paths", () => {
    expect(windowsPathToWsl("C:\\Users\\foo\\bar.img")).toBe("/mnt/c/Users/foo/bar.img");
    expect(windowsPathToWsl("E:/code/decx/apex.img")).toBe("/mnt/e/code/decx/apex.img");
    expect(windowsPathToWsl("/already/posix")).toBe("/already/posix");
  });

  it("translates standalone and embedded paths in tool arguments", () => {
    expect(translateWslArgs(["C:\\a\\b.img"])).toEqual(["/mnt/c/a/b.img"]);
    expect(translateWslArgs(["--extract=C:\\out\\dir", "C:\\in\\img"])).toEqual([
      "--extract=/mnt/c/out/dir",
      "/mnt/c/in/img",
    ]);
    expect(translateWslArgs(["-R", "rdump ./ C:\\out\\dir"])).toEqual(["-R", "rdump ./ /mnt/c/out/dir"]);
  });
});

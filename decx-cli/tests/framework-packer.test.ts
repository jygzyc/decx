import { mkdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { packFrameworkJar } from "../src/android/framework-packer.js";
import { resolveFrameworkLayout } from "../src/android/framework.js";
import { resetTestDir } from "./test-paths.js";

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
  return result.stdout;
}

describe("framework packer", () => {
  it("adds META-INF/MANIFEST.MF to the packed framework jar", async () => {
    const outDir = resetTestDir("tmp", "framework-packer");
    const layout = resolveFrameworkLayout({ outDir, oem: "xiaomi" });

    mkdirSync(layout.outTmpDir, { recursive: true });
    writeFileSync(path.join(layout.outTmpDir, "classes.dex"), "dex", "utf-8");

    const result = await packFrameworkJar(layout);
    const entries = runCommand("unzip", ["-Z1", result.jarPath]).split(/\r?\n/).filter(Boolean);
    const manifest = runCommand("unzip", ["-p", result.jarPath, "META-INF/MANIFEST.MF"]);

    expect(entries).toContain("META-INF/MANIFEST.MF");
    expect(entries).toContain("classes.dex");
    expect(manifest).toContain("Manifest-Version: 1.0");
    expect(manifest).toContain("Created-By: decx");

    rmSync(outDir, { recursive: true, force: true });
  });
});

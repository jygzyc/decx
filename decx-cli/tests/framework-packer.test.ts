import { mkdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import AdmZip from "adm-zip";
import { packFrameworkJar } from "../src/android/framework-packer.js";
import { resolveFrameworkLayout } from "../src/android/framework.js";
import { resetTestDir } from "./test-paths.js";

describe("framework packer", () => {
  it("adds META-INF/MANIFEST.MF to the packed framework jar", async () => {
    const outDir = resetTestDir("tmp", "framework-packer");
    const layout = resolveFrameworkLayout({ outDir, oem: "xiaomi" });

    mkdirSync(layout.outTmpDir, { recursive: true });
    writeFileSync(path.join(layout.outTmpDir, "classes.dex"), "dex", "utf-8");

    const result = await packFrameworkJar(layout);
    const zip = new AdmZip(result.jarPath);
    const entries = zip.getEntries().map((entry) => entry.entryName);
    const manifest = zip.readAsText("META-INF/MANIFEST.MF");

    expect(entries).toContain("META-INF/MANIFEST.MF");
    expect(entries).toContain("classes.dex");
    expect(manifest).toContain("Manifest-Version: 1.0");
    expect(manifest).toContain("Created-By: decx");

    rmSync(outDir, { recursive: true, force: true });
  });
});

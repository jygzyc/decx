import { mkdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { packFrameworkJar } from "../src/android/framework-packer.js";
import { resolveFrameworkLayout } from "../src/android/framework.js";
import { listZipEntries, readZipEntryText } from "../src/android/zip-utils.js";
import { resetTestDir } from "./test-paths.js";

describe("framework packer", () => {
  it("adds META-INF/MANIFEST.MF to the packed framework jar", async () => {
    const outDir = resetTestDir("tmp", "framework-packer");
    const layout = resolveFrameworkLayout({ outDir, oem: "xiaomi" });

    mkdirSync(layout.outTmpDir, { recursive: true });
    writeFileSync(path.join(layout.outTmpDir, "classes.dex"), "dex", "utf-8");

    const result = await packFrameworkJar(layout);
    const entries = listZipEntries(result.jarPath);
    const manifest = readZipEntryText(result.jarPath, "META-INF/MANIFEST.MF");

    expect(entries).toContain("META-INF/MANIFEST.MF");
    expect(entries).toContain("classes.dex");
    expect(manifest).toContain("Manifest-Version: 1.0");
    expect(manifest).toContain("Created-By: decx");

    rmSync(outDir, { recursive: true, force: true });
  });
});

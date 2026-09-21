import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import * as path from "path";
import type { FrameworkPathLayout, FrameworkToolPaths } from "../src/android/types.js";
import { processFrameworkFiles, hasApexImageInputs, runTasksWithConcurrency } from "../src/android/framework-processor.js";
import { createZipArchive } from "../src/android/zip-utils.js";
import { fileURLToPath } from "url";
import { resetTestDir } from "./test-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("framework processor concurrency", () => {
  it("runs tasks with a bounded level of concurrency", async () => {
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 6 }, (_, index) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return index;
    });

    const results = await runTasksWithConcurrency(tasks, 3);

    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxActive).toBe(3);
  });

  it("preserves task result ordering under concurrent execution", async () => {
    const tasks = [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "slow";
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "fast";
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "mid";
      },
    ];

    await expect(runTasksWithConcurrency(tasks, 3)).resolves.toEqual(["slow", "fast", "mid"]);
  });
});

describe("apex image input detection", () => {
  it("is false for plain jar/dex sources and true when .apex/.capex files exist", () => {
    const rootDir = resetTestDir("tmp", "framework-apex-detect");
    const sourceDir = path.join(rootDir, "source");
    mkdirSync(path.join(sourceDir, "system", "framework"), { recursive: true });
    mkdirSync(path.join(sourceDir, "apex", "com.android.art", "javalib"), { recursive: true });
    expect(hasApexImageInputs(sourceDir)).toBe(false);

    writeFileSync(path.join(sourceDir, "system", "framework", "com.foo.capex"), "capex");
    expect(hasApexImageInputs(sourceDir)).toBe(true);

    rmSync(path.join(sourceDir, "system", "framework", "com.foo.capex"));
    writeFileSync(path.join(sourceDir, "apex", "com.android.art", "com.android.art.apex"), "apex");
    expect(hasApexImageInputs(sourceDir)).toBe(true);

    rmSync(rootDir, { recursive: true, force: true });
  });
});

describe("extracted /apex module processing", () => {
  function makeLayout(rootDir: string): FrameworkPathLayout {
    return {
      rootDir,
      sourceDir: path.join(rootDir, "source"),
      outDir: rootDir,
      outTmpDir: path.join(rootDir, "out_tmp"),
      apexTmpDir: path.join(rootDir, "apex_tmp"),
      artifactPath: path.join(rootDir, ".artifact.json"),
      jarPath: path.join(rootDir, "framework_test.jar"),
    };
  }

  const tools: FrameworkToolPaths = {
    adb: "adb",
    debugfs: { argv: [] },
    erofsExtractor: { argv: [] },
  };

  it("namespaces jars and dex from runtime /apex by module name", async () => {
    const rootDir = resetTestDir("tmp", "framework-apex-mounted");
    const layout = makeLayout(rootDir);
    mkdirSync(path.join(layout.sourceDir, "apex", "com.android.art", "javalib"), { recursive: true });
    mkdirSync(path.join(layout.sourceDir, "apex", "com.android.art@341100000", "javalib"), { recursive: true });
    mkdirSync(path.join(layout.sourceDir, "apex", "com.android.i18n", "javalib"), { recursive: true });
    mkdirSync(path.join(layout.sourceDir, "system", "framework"), { recursive: true });

    writeFileSync(path.join(rootDir, "classes.dex"), Buffer.from("art-dex"));
    writeFileSync(path.join(rootDir, "classes2.dex"), Buffer.from("art-dex-2"));
    createZipArchive(
      path.join(layout.sourceDir, "apex", "com.android.art", "javalib", "core-oj.jar"),
      ["classes.dex"],
      rootDir,
    );
    // Versioned module dir must produce the same prefix as the unversioned one.
    createZipArchive(
      path.join(layout.sourceDir, "apex", "com.android.art@341100000", "javalib", "core-oj.jar"),
      ["classes2.dex"],
      rootDir,
    );
    writeFileSync(
      path.join(layout.sourceDir, "apex", "com.android.i18n", "javalib", "i18nphony.dex"),
      Buffer.from("i18n-dex"),
    );
    createZipArchive(
      path.join(layout.sourceDir, "system", "framework", "framework.jar"),
      ["classes.dex"],
      rootDir,
    );

    try {
      const result = await processFrameworkFiles(layout, async () => tools);
      expect(result.failed).toBe(0);
      expect(result.processed).toBe(4);
      expect(result.outputs).toContain(path.join(layout.outTmpDir, "com.android.art_core-oj_classes.dex"));
      expect(result.outputs).toContain(path.join(layout.outTmpDir, "com.android.art_core-oj_classes2.dex"));
      expect(result.outputs).toContain(path.join(layout.outTmpDir, "com.android.i18n_i18nphony.dex"));
      // Plain framework jars outside an apex/<module>/ layout keep bare prefixes.
      expect(result.outputs).toContain(path.join(layout.outTmpDir, "framework_classes.dex"));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps plain prefixes for files sitting directly under an apex/ directory", async () => {
    const rootDir = resetTestDir("tmp", "framework-apex-flat");
    const layout = makeLayout(rootDir);
    mkdirSync(path.join(layout.sourceDir, "system", "apex"), { recursive: true });

    writeFileSync(path.join(rootDir, "classes.dex"), Buffer.from("flat-dex"));
    createZipArchive(
      path.join(layout.sourceDir, "system", "apex", "standalone.jar"),
      ["classes.dex"],
      rootDir,
    );

    try {
      const result = await processFrameworkFiles(layout, async () => tools);
      expect(result.failed).toBe(0);
      expect(result.outputs).toContain(path.join(layout.outTmpDir, "standalone_classes.dex"));
      expect(result.outputs).not.toContain(
        path.join(layout.outTmpDir, "standalone_standalone_classes.dex"),
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("framework processor zip extraction", () => {
  it("extracts large dex entries without hitting unzip buffer limits", async () => {
    const rootDir = resetTestDir("tmp", "framework-processor");
    const sourceDir = path.join(rootDir, "source");
    const outTmpDir = path.join(rootDir, "out_tmp");
    const apexTmpDir = path.join(rootDir, "apex_tmp");
    mkdirSync(sourceDir, { recursive: true });

    const dexPath = path.join(rootDir, "classes.dex");
    const jarPath = path.join(sourceDir, "framework.jar");
    writeFileSync(dexPath, Buffer.alloc(2 * 1024 * 1024, 0x7f));

    createZipArchive(path.join(sourceDir, "framework.jar"), ["classes.dex"], rootDir);

    const layout: FrameworkPathLayout = {
      rootDir,
      sourceDir,
      outDir: rootDir,
      outTmpDir,
      apexTmpDir,
      artifactPath: path.join(rootDir, ".artifact.json"),
      jarPath: path.join(rootDir, "framework_test.jar"),
    };
    const tools: FrameworkToolPaths = {
      adb: "adb",
      debugfs: { argv: ["debugfs"] },
      erofsExtractor: { argv: ["fsck.erofs"] },
    };

    try {
      const result = await processFrameworkFiles(layout, async () => tools);
      const extractedDex = path.join(outTmpDir, "framework_classes.dex");

      expect(result.failed).toBe(0);
      expect(result.processed).toBe(1);
      expect(result.failures).toEqual([]);
      expect(result.outputs).toContain(extractedDex);
      expect(existsSync(extractedDex)).toBe(true);
      expect(statSync(extractedDex).size).toBe(2 * 1024 * 1024);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("native erofs apex payload processing", () => {
  function makeLayout(rootDir: string): FrameworkPathLayout {
    return {
      rootDir,
      sourceDir: path.join(rootDir, "source"),
      outDir: rootDir,
      outTmpDir: path.join(rootDir, "out_tmp"),
      apexTmpDir: path.join(rootDir, "apex_tmp"),
      artifactPath: path.join(rootDir, ".artifact.json"),
      jarPath: path.join(rootDir, "framework_test.jar"),
    };
  }

  it.each([
    ["compact lz4 with compressed packed fragment", "apex_payload_erofs.img", "test-erofs.apex"],
    ["ztailpacking inline tail", "apex_payload_erofs_ztp.img", "test-erofs-ztp.apex"],
    ["deflate compression", "apex_payload_erofs_deflate.img", "test-erofs-deflate.apex"],
  ])("extracts erofs payloads (%s) natively without resolving any image tools", async (_label, fixture, apexName) => {
    const rootDir = resetTestDir("tmp", "framework-apex-erofs");
    const layout = makeLayout(rootDir);
    mkdirSync(path.join(layout.sourceDir, "system", "apex"), { recursive: true });

    copyFileSync(path.join(__dirname, "fixtures", fixture), path.join(rootDir, "apex_payload.img"));
    createZipArchive(
      path.join(layout.sourceDir, "system", "apex", apexName),
      ["apex_payload.img"],
      rootDir,
    );

    let toolResolutions = 0;
    try {
      const result = await processFrameworkFiles(layout, async () => {
        toolResolutions += 1;
        return {
          adb: "adb",
          debugfs: { argv: ["debugfs"] },
          erofsExtractor: { argv: ["extract.erofs"] },
        };
      });
      expect(result.failed).toBe(0);
      expect(result.processed).toBe(1);
      expect(result.failures).toEqual([]);
      // Native extraction ran (payload/ populated with jar/apk content)...
      expect(
        existsSync(path.join(layout.apexTmpDir, apexName.replace(/\.apex$/, ""), "payload")),
      ).toBe(true);
      // ...produced namespaced dex outputs...
      expect(result.outputs.length).toBeGreaterThan(0);
      for (const output of result.outputs) expect(existsSync(output)).toBe(true);
      // ...and no external image tools were ever resolved (no WSL needed).
      expect(toolResolutions).toBe(0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("native ext4 apex payload processing", () => {
  function makeLayout(rootDir: string): FrameworkPathLayout {
    return {
      rootDir,
      sourceDir: path.join(rootDir, "source"),
      outDir: rootDir,
      outTmpDir: path.join(rootDir, "out_tmp"),
      apexTmpDir: path.join(rootDir, "apex_tmp"),
      artifactPath: path.join(rootDir, ".artifact.json"),
      jarPath: path.join(rootDir, "framework_test.jar"),
    };
  }

  it("extracts ext4 payloads natively without resolving any image tools", async () => {
    const rootDir = resetTestDir("tmp", "framework-apex-native");
    const layout = makeLayout(rootDir);
    mkdirSync(path.join(layout.sourceDir, "system", "apex"), { recursive: true });

    // Real ext4 payload image (com.android.apex.cts.shim) zipped as an .apex.
    copyFileSync(path.join(__dirname, "fixtures", "apex_payload_ext4.img"), path.join(rootDir, "apex_payload.img"));
    createZipArchive(
      path.join(layout.sourceDir, "system", "apex", "test-shim.apex"),
      ["apex_payload.img"],
      rootDir,
    );

    let toolResolutions = 0;
    try {
      const result = await processFrameworkFiles(layout, async () => {
        toolResolutions += 1;
        return {
          adb: "adb",
          debugfs: { argv: ["debugfs"] },
          erofsExtractor: { argv: ["extract.erofs"] },
        };
      });
      expect(result.failed).toBe(0);
      expect(result.processed).toBe(1);
      // Native extraction ran: the payload's apk landed in the temp dir...
      expect(
        existsSync(path.join(layout.apexTmpDir, "test-shim", "payload", "app", "CtsShim@MAIN", "CtsShim.apk")),
      ).toBe(true);
      // ...and no external image tools were ever resolved (no WSL needed).
      expect(toolResolutions).toBe(0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

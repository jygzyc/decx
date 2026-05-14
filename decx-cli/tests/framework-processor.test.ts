import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import type { FrameworkPathLayout, FrameworkToolPaths } from "../src/android/types.js";
import { processFrameworkFiles, runTasksWithConcurrency } from "../src/android/framework-processor.js";
import { resetTestDir } from "./test-paths.js";

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

    const zipResult = spawnSync("zip", ["-q", "source/framework.jar", "classes.dex"], {
      cwd: rootDir,
      encoding: "utf-8",
    });
    if (zipResult.status !== 0) {
      throw new Error(zipResult.stderr || zipResult.stdout || zipResult.error?.message || "zip failed");
    }
    expect(zipResult.error).toBeUndefined();

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
      debugfs: "debugfs",
      erofsExtractor: "fsck.erofs",
    };

    try {
      const result = await processFrameworkFiles(layout, tools);
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

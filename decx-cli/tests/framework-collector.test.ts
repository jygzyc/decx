import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { collectFrameworkFiles } from "../src/android/framework-collector.js";
import { resetTestDir } from "./test-paths.js";

/**
 * Minimal fake of the AdbClient surface used by collectFrameworkFiles:
 * `shell()` returns a newline-joined list of remote paths, and `pull()`
 * materializes a stub file at the given local path. Tests can override
 * either to inject failures.
 */
interface FakeAdb {
  shell(): string;
  pull(remotePath: string, localPath: string): void;
}

function makeFakeAdb(remotePaths: string[], pullImpl?: FakeAdb["pull"]): FakeAdb {
  return {
    shell: () => remotePaths.join("\n"),
    pull: pullImpl ?? ((_remote, local) => {
      writeFileSync(local, "stub", "utf-8");
    }),
  };
}

const STAGING_PREFIX = ".decx_pull_tmp_";

function listCwdStagingDirs(): string[] {
  return readdirSync(process.cwd(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX))
    .map((entry) => entry.name);
}

describe("collectFrameworkFiles", () => {
  it("pulls remote files into nested subdirs of sourceDir mirroring the device layout", async () => {
    const sourceDir = resetTestDir("tmp", "collector-nested");
    const adb = makeFakeAdb([
      "/system/framework/foo.jar",
      "/system_ext/framework/vendor.qti.ims.rcsuceaidlservice-V1-java.jar",
      "/vendor/framework/bar.apk",
    ]);

    const result = await collectFrameworkFiles(adb as never, "xiaomi", sourceDir);

    expect(result.scanned).toBe(3);
    expect(result.pulled).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.files).toEqual([
      path.join(sourceDir, "system", "framework", "foo.jar"),
      path.join(sourceDir, "system_ext", "framework", "vendor.qti.ims.rcsuceaidlservice-V1-java.jar"),
      path.join(sourceDir, "vendor", "framework", "bar.apk"),
    ]);
    for (const file of result.files) {
      expect(existsSync(file)).toBe(true);
    }
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("records per-file pull failures without aborting the loop", async () => {
    const sourceDir = resetTestDir("tmp", "collector-failures");
    const good = "/system/framework/ok.jar";
    const bad = "/system_ext/framework/broken.jar";
    const adb = makeFakeAdb([good, bad], (remote, local) => {
      if (remote === bad) {
        throw new Error("adb: error: cannot create file/directory");
      }
      writeFileSync(local, "stub", "utf-8");
    });

    const result = await collectFrameworkFiles(adb as never, "xiaomi", sourceDir);

    expect(result.scanned).toBe(2);
    expect(result.pulled).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.files).toEqual([path.join(sourceDir, "system", "framework", "ok.jar")]);
    expect(result.failures).toEqual([
      { path: bad, error: "adb: error: cannot create file/directory" },
    ]);
    // The failed file must not leak into sourceDir or as a staged leftover.
    expect(existsSync(path.join(sourceDir, "system_ext", "framework", "broken.jar"))).toBe(false);
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("always cleans up the CWD-relative staging dir, even on partial failure", async () => {
    const sourceDir = resetTestDir("tmp", "collector-staging-cleanup");
    expect(listCwdStagingDirs()).toEqual([]);

    const adb = makeFakeAdb(
      ["/system/framework/a.jar", "/system_ext/framework/b.jar"],
      (_remote, local) => {
        writeFileSync(local, "stub", "utf-8");
      },
    );

    await collectFrameworkFiles(adb as never, "vivo", sourceDir);

    expect(listCwdStagingDirs()).toEqual([]);
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("cleans up the staging dir even when every pull fails", async () => {
    const sourceDir = resetTestDir("tmp", "collector-all-fail");
    expect(listCwdStagingDirs()).toEqual([]);

    const adb = makeFakeAdb(
      ["/system/framework/x.jar"],
      () => {
        throw new Error("device offline");
      },
    );

    const result = await collectFrameworkFiles(adb as never, "xiaomi", sourceDir);

    expect(result.pulled).toBe(0);
    expect(result.failed).toBe(1);
    expect(listCwdStagingDirs()).toEqual([]);
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("does not hand adb an absolute local path (uses a CWD-relative staging name)", async () => {
    const sourceDir = resetTestDir("tmp", "collector-relative-pull");
    const seenLocalPaths: string[] = [];
    const adb = makeFakeAdb(["/system/framework/foo.jar"], (_remote, local) => {
      seenLocalPaths.push(local);
      writeFileSync(local, "stub", "utf-8");
    });

    await collectFrameworkFiles(adb as never, "xiaomi", sourceDir);

    expect(seenLocalPaths).toHaveLength(1);
    // The path given to adb must be relative (staging dir under CWD), never an
    // absolute /mnt/... path that a Windows adb.exe cannot resolve.
    expect(path.isAbsolute(seenLocalPaths[0])).toBe(false);
    expect(seenLocalPaths[0].startsWith(STAGING_PREFIX)).toBe(true);
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("handles duplicate basenames across different subtrees without collision", async () => {
    const sourceDir = resetTestDir("tmp", "collector-dup-basename");
    const adb = makeFakeAdb([
      "/system/framework/framework.jar",
      "/system_ext/framework/framework.jar",
      "/vendor/framework/framework.jar",
    ]);

    const result = await collectFrameworkFiles(adb as never, "honor", sourceDir);

    expect(result.pulled).toBe(3);
    expect(result.failed).toBe(0);
    expect(existsSync(path.join(sourceDir, "system", "framework", "framework.jar"))).toBe(true);
    expect(existsSync(path.join(sourceDir, "system_ext", "framework", "framework.jar"))).toBe(true);
    expect(existsSync(path.join(sourceDir, "vendor", "framework", "framework.jar"))).toBe(true);
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("propagates errors from adb shell", async () => {
    const sourceDir = resetTestDir("tmp", "collector-shell-error");
    const adb: FakeAdb = {
      shell: () => {
        throw new Error("adb shell failed");
      },
      pull: () => {},
    };

    await expect(collectFrameworkFiles(adb as never, "xiaomi", sourceDir)).rejects.toThrow(
      "adb shell failed",
    );
    expect(listCwdStagingDirs()).toEqual([]);
    rmSync(sourceDir, { recursive: true, force: true });
  });
});

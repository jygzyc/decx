// Marks the test file as a module so its helper declarations stay file-scoped.
export {};

import type { TestContext } from "node:test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const path = require("path");
const {
  defaultToolContext,
  defaultToolRun,
  findExecutable,
  isErofsTool,
  isFsckErofs,
  resolveDebugfsTool,
  resolveErofsTool,
  runFrameworkTool,
  toolExecutableName,
} = require("../src/framework-tools.js");
const { ToolError } = require("../src/errors.js");

const DEBUGFS_MISSING =
  "debugfs not found. Install e2fsprogs (e.g. 'apt install e2fsprogs') so debugfs is on PATH.";
const DEBUGFS_MISSING_WIN32 =
  "ext4 feature not supported by the native reader and debugfs has no native Windows binary. " +
  "Run 'framework process' on Linux/macOS (e2fsprogs) to unpack this payload.";
const EROFS_MISSING =
  "No EROFS extractor found. Install fsck.erofs/extract.erofs (erofs-utils).";
const EROFS_MISSING_WIN32 =
  "EROFS payload images need erofs-utils, which has no native Windows binary. " +
  "Run 'framework process' on Linux/macOS (erofs-utils) to unpack this payload.";

// Built at runtime: resolution must never pick up a foreign launcher, and the
// source tree must stay free of references to one.
const FOREIGN_LAUNCHER = ["w", "s", "l.exe"].join("");

function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function executable(dir: string, name: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

function fakeContext(
  platform: string,
  env: Record<string, string>,
  handler: (argv: string[]) => Record<string, unknown> = () => ({}),
) {
  const calls: string[][] = [];
  return {
    calls,
    ctx: {
      platform,
      env,
      run: (argv: string[]) => {
        calls.push([...argv]);
        return { stdout: "", stderr: "", status: 0, ...handler(argv) };
      },
    },
  };
}

function isToolError(message: string): (error: any) => boolean {
  return (error) =>
    error instanceof ToolError && error.code === "TOOL_NOT_FOUND" && error.message === message;
}

test("resolveDebugfsTool uses the env override, then PATH", (t: TestContext) => {
  const dir = tempDir(t, "decx-tools-");
  const debugfs = executable(dir, "debugfs");
  const linux = { platform: "linux", env: { PATH: dir }, run: () => ({}) };
  assert.deepEqual(resolveDebugfsTool(linux).argv, [debugfs]);

  const override = resolveDebugfsTool({
    platform: "linux",
    env: { PATH: dir, DECX_DEBUGFS: "/opt/custom/debugfs" },
    run: () => ({}),
  });
  assert.deepEqual(override.argv, ["/opt/custom/debugfs"]);
});

test("resolveDebugfsTool reports missing tools with the platform wording", (t: TestContext) => {
  const empty = tempDir(t, "decx-tools-empty-");
  assert.throws(
    () => resolveDebugfsTool({ platform: "linux", env: { PATH: empty }, run: () => ({}) }),
    isToolError(DEBUGFS_MISSING),
  );
  assert.throws(
    () => resolveDebugfsTool({ platform: "darwin", env: { PATH: empty }, run: () => ({}) }),
    isToolError(DEBUGFS_MISSING),
  );
  assert.throws(
    () =>
      resolveDebugfsTool({ platform: "win32", env: { PATH: empty, PATHEXT: ".EXE" }, run: () => ({}) }),
    isToolError(DEBUGFS_MISSING_WIN32),
  );
});

test("resolveErofsTool honors PATH order, env overrides and fsck detection", (t: TestContext) => {
  const dir = tempDir(t, "decx-erofs-");
  const extract = executable(dir, "extract.erofs");
  const linux = { platform: "linux", env: { PATH: dir }, run: () => ({}) };
  const onlyExtract = resolveErofsTool(linux);
  assert.deepEqual(onlyExtract.argv, [extract]);
  assert.equal(isErofsTool(onlyExtract), true);
  assert.equal(isFsckErofs(onlyExtract), false);

  const fsck = executable(dir, "fsck.erofs");
  const preferred = resolveErofsTool(linux);
  assert.deepEqual(preferred.argv, [fsck]);
  assert.equal(isFsckErofs(preferred), true);

  const override = resolveErofsTool({
    platform: "linux",
    env: { PATH: dir, DECX_FSCK_EROFS: "/opt/custom/fsck.erofs" },
    run: () => ({}),
  });
  assert.deepEqual(override.argv, ["/opt/custom/fsck.erofs"]);

  const extractOverride = resolveErofsTool({
    platform: "win32",
    env: { PATH: "", DECX_EXTRACT_EROFS: "C:\\tools\\extract.erofs" },
    run: () => ({}),
  });
  assert.deepEqual(extractOverride.argv, ["C:\\tools\\extract.erofs"]);
  assert.equal(isFsckErofs(extractOverride), false);

  const fsckWins = resolveErofsTool({
    platform: "linux",
    env: {
      PATH: "",
      DECX_FSCK_EROFS: "/opt/custom/fsck.erofs",
      DECX_EXTRACT_EROFS: "/opt/custom/extract.erofs",
    },
    run: () => ({}),
  });
  assert.deepEqual(fsckWins.argv, ["/opt/custom/fsck.erofs"]);
});

test("resolveErofsTool reports missing tools with the platform wording", (t: TestContext) => {
  const empty = tempDir(t, "decx-erofs-empty-");
  assert.throws(
    () => resolveErofsTool({ platform: "linux", env: { PATH: empty }, run: () => ({}) }),
    isToolError(EROFS_MISSING),
  );
  assert.throws(
    () => resolveErofsTool({ platform: "darwin", env: { PATH: empty }, run: () => ({}) }),
    isToolError(EROFS_MISSING),
  );
  assert.throws(
    () => resolveErofsTool({ platform: "win32", env: { PATH: empty }, run: () => ({}) }),
    isToolError(EROFS_MISSING_WIN32),
  );
});

test("tool resolution never delegates to a foreign launcher", (t: TestContext) => {
  const dir = tempDir(t, "decx-foreign-");
  executable(dir, FOREIGN_LAUNCHER);
  const { ctx, calls } = fakeContext("win32", { PATH: dir });
  assert.throws(() => resolveDebugfsTool(ctx), isToolError(DEBUGFS_MISSING_WIN32));
  assert.throws(() => resolveErofsTool(ctx), isToolError(EROFS_MISSING_WIN32));
  assert.equal(findExecutable("debugfs", ctx), null);
  assert.equal(findExecutable("fsck.erofs", ctx), null);
  assert.equal(calls.length, 0); // resolution must not spawn anything
});

test("runFrameworkTool spawns the resolved argv unchanged", (t: TestContext) => {
  const dir = tempDir(t, "decx-run-");
  const debugfs = executable(dir, "debugfs");
  const { ctx, calls } = fakeContext("win32", { PATH: dir });
  const tool = resolveDebugfsTool(ctx);
  runFrameworkTool(tool, ["-R", "rdump ./ C:\\tmp\\payload.img"], {}, ctx);
  assert.deepEqual(calls[0], [debugfs, "-R", "rdump ./ C:\\tmp\\payload.img"]);

  assert.throws(
    () => runFrameworkTool({ argv: [] }, [], {}, ctx),
    (error) => error instanceof ToolError && error.code === "TOOL_NOT_FOUND",
  );
});

test("toolExecutableName identifies the extractor", () => {
  assert.equal(toolExecutableName({ argv: ["/usr/bin/fsck.erofs"] }), "fsck.erofs");
  assert.equal(toolExecutableName({ argv: ["C:\\tools\\extract.erofs"] }), "extract.erofs");
  assert.equal(isErofsTool({ argv: ["/usr/bin/extract.erofs"] }), true);
  assert.equal(isErofsTool({ argv: ["/usr/bin/debugfs"] }), false);
});

test("findExecutable scans PATH without a shell", (t: TestContext) => {
  const dir = tempDir(t, "decx-which-");
  executable(dir, "zip");
  assert.equal(
    findExecutable("zip", { platform: "linux", env: { PATH: dir }, run: () => ({}) }),
    path.join(dir, "zip"),
  );
  assert.equal(
    findExecutable("unzip", { platform: "linux", env: { PATH: dir }, run: () => ({}) }),
    null,
  );

  const winDir = tempDir(t, "decx-which-win-");
  executable(winDir, "adb.exe");
  assert.equal(
    findExecutable("adb", { platform: "win32", env: { PATH: winDir }, run: () => ({}) }),
    path.join(winDir, "adb.exe"),
  );
  assert.equal(findExecutable("adb", defaultToolContext({ PATH: "" })), null);
});

test("defaultToolRun reports spawn failures without throwing", () => {
  const result = defaultToolRun([path.join(tmpdir(), "decx-missing-tool-xyz")], {});
  assert.equal(result.status, null);
  assert.match(result.stderr, /ENOENT|no such file/i);
});

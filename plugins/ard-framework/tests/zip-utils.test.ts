// Marks the test file as a module so its helper declarations stay file-scoped.
export {};

import type { TestContext } from "node:test";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const path = require("path");
const {
  createZipArchive,
  extractZipEntry,
  listZipEntries,
  readZipEntryText,
} = require("../src/zip-utils.js");
const { defaultToolContext, findExecutable } = require("../src/framework-tools.js");

function hasTool(name: string): boolean {
  return findExecutable(name, defaultToolContext()) !== null;
}

const zipAvailable =
  process.platform === "win32" ? true : hasTool("zip") && hasTool("unzip");

test("zip round-trip: create, list and extract entries", { skip: !zipAvailable }, (t: TestContext) => {
  const dir = mkdtempSync(path.join(tmpdir(), "decx-zip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const source = path.join(dir, "source");
  mkdirSync(path.join(source, "nested"), { recursive: true });
  writeFileSync(path.join(source, "a.txt"), "alpha");
  const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x41]);
  writeFileSync(path.join(source, "nested", "b.bin"), binary);

  const archive = path.join(dir, "out.zip");
  createZipArchive(archive, ["a.txt", "nested/b.bin"], source);

  const entries = listZipEntries(archive).map((entry: string) => entry.replace(/^\.\//, ""));
  assert.deepEqual(entries.sort(), ["a.txt", "nested/b.bin"]);
  assert.equal(readZipEntryText(archive, "a.txt"), "alpha");

  const extracted = path.join(dir, "a.txt");
  extractZipEntry(archive, "a.txt", extracted);
  assert.equal(readFileSync(extracted, "utf8"), "alpha");

  const extractedBinary = path.join(dir, "b.bin");
  extractZipEntry(archive, "nested/b.bin", extractedBinary);
  assert.deepEqual(readFileSync(extractedBinary), binary);
});

test("createZipArchive replaces an existing archive", { skip: !zipAvailable }, (t: TestContext) => {
  const dir = mkdtempSync(path.join(tmpdir(), "decx-zip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const source = path.join(dir, "source");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "one.txt"), "1");
  const archive = path.join(dir, "out.zip");
  createZipArchive(archive, ["one.txt"], source);
  assert.deepEqual(listZipEntries(archive), ["one.txt"]);

  writeFileSync(path.join(source, "two.txt"), "2");
  createZipArchive(archive, ["two.txt"], source);
  assert.deepEqual(listZipEntries(archive), ["two.txt"]);
});

test(
  "a missing Info-ZIP tool reports an actionable install hint",
  { skip: process.platform === "win32" },
  () => {
    // Windows resolves bsdtar and needs no Info-ZIP tools; on POSIX stripping
    // PATH makes spawnSync fail with ENOENT like a minimal Linux install.
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(tmpdir(), "decx-no-tools");
    try {
      assert.throws(
        () => listZipEntries(path.join(tmpdir(), "missing.zip")),
        /required tool 'unzip' was not found on PATH.*apt install unzip/s,
      );
    } finally {
      process.env.PATH = savedPath;
    }
  },
);

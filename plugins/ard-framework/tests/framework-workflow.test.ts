import type { FrameworkLayout } from "../src/types";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const path = require("path");
const { DecxError } = require("../src/errors.js");
const {
  acceptsRemoteFile,
  collectFramework,
  isApexModuleImage,
  parseFrameworkFindOutput,
  remoteModule,
  scanCoveredModules,
} = require("../src/framework-collector.js");
const {
  cleanFrameworkOutputs,
  countFrameworkFiles,
  extractDexFromZip,
  isSupportedFrameworkInput,
  processFramework,
  walkFrameworkInputs,
} = require("../src/framework-processor.js");
const { packFrameworkJar } = require("../src/framework-packer.js");
const {
  readFrameworkArtifact,
  resolveFrameworkLayout,
  segment,
} = require("../src/framework.js");
const { createZipArchive, listZipEntries, readZipEntryText } = require("../src/zip-utils.js");
const { defaultToolContext, findExecutable } = require("../src/framework-tools.js");
const { buildExt4Image } = require("./helpers/ext4-image.js");

const zipAvailable =
  process.platform === "win32"
    ? true
    : findExecutable("zip", defaultToolContext()) !== null &&
      findExecutable("unzip", defaultToolContext()) !== null;

function tempDir(t: any, prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function layoutFor(root: string, oem: string = "acme"): FrameworkLayout {
  return resolveFrameworkLayout({
    home: path.join(root, "home"),
    oem,
    outDir: path.join(root, "out"),
    device: false,
    serialRequested: false,
    adb: null,
  });
}

function fakeAdb(shell: (script: string) => string, pull: (remote: string, local: string) => void) {
  return { shell, pull };
}

function writeDex(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// ── remote path helpers ────────────────────────────────────────────────────

test("remoteModule extracts apex module names only from apex layouts", () => {
  assert.equal(remoteModule("apex/com.android.foo/javalib/core.jar"), "com.android.foo");
  assert.equal(remoteModule("apex/com.android.foo@350090000/javalib/core.jar"), "com.android.foo");
  assert.equal(remoteModule("system/framework/boot.jar"), "");
  assert.equal(remoteModule("apex/com.android.foo.apex"), "");
  assert.equal(remoteModule("system/apex/com.android.foo.apex"), "");
});

test("isApexModuleImage rejects versioned source names", () => {
  assert.equal(isApexModuleImage("/system/apex/com.android.foo.apex"), true);
  assert.equal(isApexModuleImage("/system/apex/com.android.foo.capex"), true);
  assert.equal(isApexModuleImage("/system/apex/com.android.foo@350090000.apex"), false);
});

test("acceptsRemoteFile enforces the per-root extension rules", () => {
  assert.equal(acceptsRemoteFile("/system/framework", "/system/framework/boot.jar"), true);
  assert.equal(acceptsRemoteFile("/system/framework", "/system/framework/boot.oat"), false);
  assert.equal(acceptsRemoteFile("/system/apex", "/system/apex/com.android.foo.apex"), true);
  assert.equal(acceptsRemoteFile("/system/apex", "/system/apex/com.android.foo.jar"), false);
  assert.equal(acceptsRemoteFile("/vendor/framework", "/vendor/framework/lib.dex"), true);
});

test("parseFrameworkFindOutput trims noise and blocks outside-root paths", () => {
  const output = [
    "",
    "/system/framework/boot.jar",
    "/system/framework/boot.oat",
    "/system/framework/sub/framework.jar",
    "/data/local/tmp/evil.jar",
    "/system/framework-ish/evil.jar",
    "",
  ].join("\n");
  assert.deepEqual(parseFrameworkFindOutput("/system/framework", output), [
    "/system/framework/boot.jar",
    "/system/framework/sub/framework.jar",
  ]);
});

test("scanCoveredModules finds already pulled apex modules", (t) => {
  const root = tempDir(t, "decx-covered-");
  const source = path.join(root, "source");
  writeDex(path.join(source, "apex/com.android.foo/javalib/core.jar"), "cached");
  writeDex(path.join(source, "apex/com.android.bar@1/javalib/other.jar"), "cached");
  const covered = scanCoveredModules(source);
  assert.deepEqual([...covered].sort(), ["com.android.bar", "com.android.foo"]);
});

// ── collection ─────────────────────────────────────────────────────────────

test("collectFramework scans roots, skips covered modules and pulls the rest", (t) => {
  const root = tempDir(t, "decx-collect-");
  const layout = layoutFor(root);
  writeDex(path.join(layout.sourceDir, "apex/com.android.a/x.jar"), "cached");

  const pulls = [];
  const adb = fakeAdb(
    (script) => {
      if (script.includes("/system/apex")) {
        return "\n/system/apex/com.android.a.apex\n/system/apex/com.android.b@15.apex\n/system/apex/com.android.c.apex\n";
      }
      if (script.includes("/system/framework")) {
        return "/system/framework/boot.jar\n/system/framework/boot.oat\n";
      }
      return "";
    },
    (remote, local) => {
      pulls.push(remote);
      writeFileSync(local, `pulled:${remote}`);
    },
  );

  const result = collectFramework(adb, layout);
  assert.deepEqual(result, { scanned: 3, pulled: 2, skippedCoveredModules: 1, failures: [] });
  assert.deepEqual(pulls.sort(), ["/system/apex/com.android.c.apex", "/system/framework/boot.jar"]);
  assert.equal(
    readFileSync(path.join(layout.sourceDir, "system/framework/boot.jar"), "utf8"),
    "pulled:/system/framework/boot.jar",
  );
  assert.equal(existsSync(path.join(layout.sourceDir, "system/apex/com.android.c.apex")), true);
  assert.equal(existsSync(path.join(layout.sourceDir, "system/apex/com.android.a.apex")), false);
  // Pull staging directories must not survive.
  assert.deepEqual(readdirSync(path.join(layout.sourceDir, "system/framework")), ["boot.jar"]);
});

test("collectFramework records per-file failures without aborting", (t) => {
  const root = tempDir(t, "decx-collect-fail-");
  const layout = layoutFor(root);
  const adb = fakeAdb(
    (script) => (script.includes("/vendor/framework") ? "/vendor/framework/vendor.jar\n" : ""),
    () => {
      throw new Error("adb pull failed: device offline");
    },
  );
  const result = collectFramework(adb, layout);
  assert.equal(result.scanned, 1);
  assert.equal(result.pulled, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].path, "/vendor/framework/vendor.jar");
  assert.match(result.failures[0].error, /device offline/);
});

// ── layout and naming ──────────────────────────────────────────────────────

test("segment normalizes oem and vendor names", () => {
  assert.equal(segment("SM-T970/Android 13"), "sm-t970_android_13");
  assert.equal(segment(".."), "unknown");
  assert.equal(segment(""), "unknown");
  assert.equal(segment("Google.Pixel_7"), "google.pixel_7");
});

test("resolveFrameworkLayout needs an oem and reuses the recorded artifact", (t) => {
  const root = tempDir(t, "decx-layout-");
  assert.throws(
    () =>
      resolveFrameworkLayout({
        home: path.join(root, "home"),
        outDir: path.join(root, "empty"),
        device: false,
        serialRequested: false,
        adb: null,
      }),
    (error) =>
      error instanceof DecxError && /specify --oem/.test(error.message) && error.code === "MISSING_OEM",
  );

  const first = layoutFor(root, "Samsung/Device");
  assert.equal(first.artifact.name, "framework_samsung_device_unknown");
  assert.equal(first.sourceDir, path.join(root, "out", "source"));
  assert.equal(first.outTmpDir, path.join(root, "out", "out_tmp"));
  assert.deepEqual(readFrameworkArtifact(first.outDir)?.oem, "samsung_device");

  const restored = resolveFrameworkLayout({
    home: path.join(root, "home"),
    outDir: path.join(root, "out"),
    device: false,
    serialRequested: false,
    adb: null,
  });
  assert.equal(restored.artifact.oem, "samsung_device");
  assert.equal(restored.artifact.vendor, "unknown");

  const sourceDir = path.join(root, "src");
  assert.throws(
    () =>
      resolveFrameworkLayout({
        home: path.join(root, "home"),
        oem: "acme",
        sourceDir,
        outDir: path.join(sourceDir, "out"),
        device: false,
        serialRequested: false,
        adb: null,
      }),
    (error) => error instanceof DecxError && /inside the source/.test(error.message),
  );
});

test("readFrameworkArtifact reports malformed records", (t) => {
  const root = tempDir(t, "decx-artifact-");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, ".artifact.json"), "{not json");
  assert.throws(
    () => readFrameworkArtifact(root),
    (error) => error instanceof DecxError && error.code === "INVALID_ARTIFACT",
  );
  assert.equal(readFrameworkArtifact(path.join(root, "missing")), null);
});

// ── processing and packing ────────────────────────────────────────────────

test("processFramework expands dex inputs and swaps in a fresh out_tmp", (t) => {
  const root = tempDir(t, "decx-process-");
  const layout = layoutFor(root);
  writeDex(path.join(layout.sourceDir, "classes.dex"), "dex-one");
  writeDex(path.join(layout.sourceDir, "sub/extra.dex"), "dex-two");

  const first = processFramework(layout);
  assert.equal(first.processed, 2);
  assert.deepEqual(first.failures, []);
  assert.deepEqual(first.outputs.map((file) => path.basename(file)).sort(), [
    "classes.dex",
    "extra.dex",
  ]);
  assert.deepEqual(readdirSync(layout.outTmpDir).sort(), ["classes.dex", "extra.dex"]);
  assert.equal(walkFrameworkInputs(layout.sourceDir).length, 2);
  assert.equal(isSupportedFrameworkInput("x.jar"), true);
  assert.equal(isSupportedFrameworkInput("x.so"), false);

  // A second run replaces the previous output atomically.
  rmSync(path.join(layout.sourceDir, "sub"), { recursive: true, force: true });
  writeFileSync(path.join(layout.sourceDir, "classes.dex"), "dex-updated");
  const second = processFramework(layout);
  assert.deepEqual(second.outputs.map((file) => path.basename(file)), ["classes.dex"]);
  assert.equal(
    readFileSync(path.join(layout.outTmpDir, "classes.dex"), "utf8"),
    "dex-updated",
  );
  assert.equal(existsSync(`${layout.outTmpDir}.previous`), false);
});

test("processFramework fails when no supported inputs exist", (t) => {
  const root = tempDir(t, "decx-process-empty-");
  const layout = layoutFor(root);
  mkdirSync(layout.sourceDir, { recursive: true });
  writeFileSync(path.join(layout.sourceDir, "notes.txt"), "nothing to do");
  assert.throws(
    () => processFramework(layout),
    (error) => error instanceof DecxError && /no supported framework inputs/.test(error.message),
  );
});

test("packFrameworkJar writes a manifest plus the processed dex files", { skip: !zipAvailable }, (t) => {
  const root = tempDir(t, "decx-pack-");
  const layout = layoutFor(root);
  writeDex(path.join(layout.sourceDir, "classes.dex"), "dex-one");
  writeDex(path.join(layout.sourceDir, "extra.dex"), "dex-two");
  const result = processFramework(layout);

  const jarPath = packFrameworkJar(layout);
  assert.equal(jarPath, layout.artifact.jarPath);
  assert.equal(existsSync(jarPath), true);
  assert.equal(countFrameworkFiles(layout.outTmpDir), 2);
  const entries = listZipEntries(jarPath);
  assert.equal(entries.includes("META-INF/MANIFEST.MF"), true);
  assert.equal(entries.includes("classes.dex"), true);
  assert.equal(entries.includes("extra.dex"), true);
  assert.equal(
    readZipEntryText(jarPath, "META-INF/MANIFEST.MF"),
    "Manifest-Version: 1.0\r\nCreated-By: decx\r\n\r\n",
  );

  cleanFrameworkOutputs(layout, true);
  assert.equal(existsSync(layout.sourceDir), false);
  assert.equal(existsSync(layout.outTmpDir), false);
  assert.equal(existsSync(jarPath), true);
  assert.equal(result.processed, 2);
});

test("packFrameworkJar refuses an empty output directory", (t) => {
  const root = tempDir(t, "decx-pack-empty-");
  const layout = layoutFor(root);
  mkdirSync(layout.outTmpDir, { recursive: true });
  assert.throws(
    () => packFrameworkJar(layout),
    (error) => error instanceof DecxError && /no processed dex files/.test(error.message),
  );
});

test("jar inputs expand with prefixes and nested dex names get a hash", { skip: !zipAvailable }, (t) => {
  const root = tempDir(t, "decx-jar-");
  const layout = layoutFor(root);
  const staging = path.join(root, "staging");
  mkdirSync(path.join(staging, "dir"), { recursive: true });
  writeFileSync(path.join(staging, "a.dex"), "a");
  writeFileSync(path.join(staging, "b.dex"), "b");
  writeFileSync(path.join(staging, "dir", "deep.dex"), "deep");
  const jarSource = path.join(root, "base.jar");
  createZipArchive(jarSource, ["a.dex", "b.dex", "dir/deep.dex"], staging);
  mkdirSync(path.join(layout.sourceDir, "nested"), { recursive: true });
  writeFileSync(path.join(layout.sourceDir, "nested", "base.jar"), readFileSync(jarSource));

  const result = processFramework(layout);
  const names = result.outputs.map((file) => path.basename(file));
  const simple = names.filter((name) => !name.endsWith("_deep.dex")).sort();
  const nested = names.filter((name) => name.endsWith("_deep.dex"));
  assert.deepEqual(simple, ["base_a.dex", "base_b.dex"]);
  assert.equal(nested.length, 1);
  assert.match(nested[0], /^base_[0-9a-f]{8}_deep\.dex$/);

  const target = path.join(root, "out-dex");
  extractDexFromZip(jarSource, target, "pfx");
  const extracted = readdirSync(target).sort();
  assert.deepEqual(
    extracted.filter((name) => !/_[0-9a-f]{8}_deep\.dex$/.test(name)),
    ["pfx_a.dex", "pfx_b.dex"],
  );
  assert.match(
    extracted.find((name) => /_[0-9a-f]{8}_deep\.dex$/.test(name)) ?? "",
    /^pfx_[0-9a-f]{8}_deep\.dex$/,
  );
});

test("apex inputs are expanded natively via the ext4 reader", { skip: !zipAvailable }, (t) => {
  const root = tempDir(t, "decx-apex-");
  const layout = layoutFor(root);
  const apexSource = path.join(root, "apex-source");
  mkdirSync(apexSource, { recursive: true });
  writeFileSync(
    path.join(apexSource, "apex_payload.img"),
    buildExt4Image([{ name: "classes.dex", content: "payload dex" }]),
  );
  const apexPath = path.join(layout.sourceDir, "apex", "com.android.mod.apex");
  mkdirSync(path.dirname(apexPath), { recursive: true });
  createZipArchive(apexPath, ["apex_payload.img"], apexSource);

  const result = processFramework(layout);
  assert.equal(result.processed, 1);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.outputs.map((file) => path.basename(file)), [
    "com.android.mod_classes.dex",
  ]);
  assert.equal(
    readFileSync(path.join(layout.outTmpDir, "com.android.mod_classes.dex"), "utf8"),
    "payload dex",
  );
});

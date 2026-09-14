// Marks the test file as a module so its helper declarations stay file-scoped.
export {};

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const path = require("path");
const { detectFilesystemType, extractPayloadNatively } = require("../src/framework-processor.js");
const { MalformedErofsImageError } = require("../src/erofs-reader.js");
const { buildExt4Image } = require("./helpers/ext4-image.js");
const { fixturesDir } = require("./helpers/paths.js");

const EROFS_FIXTURE = path.join(fixturesDir(), "apex_payload_erofs.img");

function withTempDir(tag: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), `decx-processor-${tag}-`));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface ErofsOverrides {
  blkSzBits?: number;
  featureIncompat?: number;
}

/** Minimal EROFS superblock at offset 1024, enough for magic-based detection. */
function synthesizedErofs(overrides: ErofsOverrides = {}): Buffer {
  const image = Buffer.alloc(4096, 0);
  image.writeUInt32LE(0xe0f5e1e2, 1024);
  image[1024 + 12] = overrides.blkSzBits ?? 12;
  image.writeUInt32LE(overrides.featureIncompat ?? 0, 1024 + 80);
  return image;
}

test("extractPayloadNatively reads EROFS images without external tools", () => {
  withTempDir("erofs", (dir) => {
    const out = path.join(dir, "payload");
    const extracted = extractPayloadNatively(
      EROFS_FIXTURE,
      out,
      (relative) => relative.endsWith(".jar") || relative.endsWith(".bin"),
    );
    assert.equal(extracted, true);
    assert.equal(existsSync(path.join(out, "javalib", "module.jar")), true);
    assert.equal(existsSync(path.join(out, "priv-app", "shim", "dup1.bin")), true);
  });
});

test("extractPayloadNatively reads synthesized ext4 images", () => {
  withTempDir("ext4", (dir) => {
    const imagePath = path.join(dir, "apex_payload.img");
    writeFileSync(imagePath, buildExt4Image([{ name: "classes.dex", content: "dex-bytes" }]));
    const out = path.join(dir, "payload");
    const extracted = extractPayloadNatively(imagePath, out, (relative) => relative.endsWith(".dex"));
    assert.equal(extracted, true);
    assert.equal(readFileSync(path.join(out, "classes.dex"), "utf8"), "dex-bytes");
  });
});

test("extractPayloadNatively falls back for unsupported EROFS features", () => {
  withTempDir("erofs-unsupported", (dir) => {
    const imagePath = path.join(dir, "payload.img");
    writeFileSync(imagePath, synthesizedErofs({ featureIncompat: 0x100 })); // metabox
    assert.equal(detectFilesystemType(imagePath), "erofs");
    assert.equal(extractPayloadNatively(imagePath, path.join(dir, "out"), () => true), false);
  });
});

test("extractPayloadNatively hard-fails on malformed EROFS images", () => {
  withTempDir("erofs-malformed", (dir) => {
    const imagePath = path.join(dir, "payload.img");
    writeFileSync(imagePath, synthesizedErofs({ blkSzBits: 3 }));
    assert.throws(
      () => extractPayloadNatively(imagePath, path.join(dir, "out"), () => true),
      MalformedErofsImageError,
    );
  });
});

test("extractPayloadNatively leaves non-filesystem images to the tools", () => {
  withTempDir("unknown", (dir) => {
    const imagePath = path.join(dir, "payload.img");
    writeFileSync(imagePath, Buffer.alloc(4096, 0x41));
    assert.equal(extractPayloadNatively(imagePath, path.join(dir, "out"), () => true), false);
  });
});

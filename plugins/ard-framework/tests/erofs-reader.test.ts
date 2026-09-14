import type { ErofsImage as ErofsImageHandle } from "../src/erofs-reader";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const path = require("path");
const {
  ErofsImage,
  NotErofsImageError,
  lz4Decode,
  stripLeadingZeros,
} = require("../src/erofs-reader.js");
const { fixturesDir } = require("./helpers/paths.js");

/**
 * Real EROFS image generated with `mkfs.erofs -zlz4hc -E fragments` over a
 * deterministic apex-payload-like tree:
 *   apex_manifest.pb      "fixed manifest payload bytes" (28 B)
 *   javalib/module.jar    3000 x "payload line %04d lorem ipsum dolor
 *                         sit amet consectetur\n" (57 B each, 171000 B)
 *   javalib/random.bin    150000 B incompressible (SHIFTED pclusters)
 *   priv-app/shim/tiny.txt "tiny"
 *   priv-app/shim/dup{1,2}.bin  3000 zero bytes (fragment dedupe)
 *   etc/permissions/etc-permissions.xml
 */
const FIXTURE = path.join(fixturesDir(), "apex_payload_erofs.img");

function withTempDir<T>(tag: string, run: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), `decx-erofs-${tag}-`));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withImage<T>(run: (image: ErofsImageHandle) => T): T {
  const image: ErofsImageHandle = ErofsImage.open(FIXTURE);
  try {
    return run(image);
  } finally {
    image.close();
  }
}

function collectRelativeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relative);
      } else {
        out.push(relative);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

test("rejects non-erofs images", () => {
  withTempDir("not-erofs", (dir) => {
    const bogus = path.join(dir, "bogus.img");
    writeFileSync(bogus, Buffer.alloc(4096, 0));
    assert.throws(() => ErofsImage.open(bogus), NotErofsImageError);
  });
});

test("reads the root directory", () => {
  withImage((image) => {
    const names = image
      .listDir("/")
      .map((entry) => entry.name)
      .filter((name) => name !== "." && name !== "..");
    assert.deepEqual(names, ["apex_manifest.pb", "etc", "javalib", "priv-app"]);
  });
});

test("reads small and large files", () => {
  withImage((image) => {
    const tiny = image.readFile("/priv-app/shim/tiny.txt");
    assert.equal(tiny.toString("utf8"), "tiny");

    const manifest = image.readFile("/apex_manifest.pb");
    assert.equal(manifest.length, 28);
    assert.equal(manifest.toString("utf8"), "fixed manifest payload bytes");

    const jar = image.readFile("/javalib/module.jar");
    assert.equal(jar.length, 171000);
    let newlines = 0;
    for (const byte of jar) {
      if (byte === 0x0a) newlines += 1;
    }
    assert.equal(newlines, 3000); // 3000 lines, each ending with '\n'
    assert.ok(jar.subarray(0, 13).equals(Buffer.from("payload line ", "ascii")));

    const dup1 = image.readFile("/priv-app/shim/dup1.bin");
    const dup2 = image.readFile("/priv-app/shim/dup2.bin");
    assert.equal(dup1.length, 3000);
    assert.ok(dup1.equals(dup2));
    assert.ok(dup1.every((byte) => byte === 0));

    const random = image.readFile("/javalib/random.bin");
    assert.equal(random.length, 150000);
    assert.ok(random.some((byte) => byte !== 0));
  });
});

test("extractTo honors the filter and preserves the inner layout", () => {
  withImage((image) => {
    withTempDir("extract", (root) => {
      const extracted = image
        .extractTo(root, (relative) => relative.endsWith(".jar") || relative.endsWith(".bin"))
        .sort();
      assert.deepEqual(extracted, [
        "javalib/module.jar",
        "javalib/random.bin",
        "priv-app/shim/dup1.bin",
        "priv-app/shim/dup2.bin",
      ]);
      assert.deepEqual(collectRelativeFiles(root), [
        "javalib/module.jar",
        "javalib/random.bin",
        "priv-app/shim/dup1.bin",
        "priv-app/shim/dup2.bin",
      ]);
      assert.equal(readFileSync(path.join(root, "javalib/module.jar")).length, 171000);
      const dup1 = readFileSync(path.join(root, "priv-app/shim/dup1.bin"));
      const dup2 = readFileSync(path.join(root, "priv-app/shim/dup2.bin"));
      assert.ok(dup1.equals(dup2));
    });
  });
});

/** Dev-machine cross-validation against mkfs.erofs/fsck.erofs reference
 * trees: set DECX_EROFS_FIXTURES=<dir with *.img + ref/<name>/ trees>. */
test("cross validates against fsck references", () => {
  const dir = process.env.DECX_EROFS_FIXTURES;
  if (!dir) return;
  let checked = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".img")) continue;
    const name = entry.name.slice(0, -".img".length);
    const reference = path.join(dir, "ref", name);
    let referenceExists = false;
    try {
      referenceExists = readdirSync(reference).length >= 0;
    } catch {
      referenceExists = false;
    }
    if (!referenceExists) continue;
    withTempDir(`xval-${name}`, (out) => {
      const image: ErofsImageHandle = ErofsImage.open(path.join(dir, entry.name));
      try {
        image.extractTo(out, () => true);
      } finally {
        image.close();
      }
      const expected: string[] = [];
      const stack: string[] = [reference];
      while (stack.length > 0) {
        const current = stack.pop();
        for (const child of readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, child.name);
          if (child.isDirectory()) {
            stack.push(full);
          } else {
            expected.push(path.relative(reference, full).split(path.sep).join("/"));
          }
        }
      }
      expected.sort();
      assert.deepEqual(collectRelativeFiles(out), expected, `${name}: file lists differ`);
      for (const relative of expected) {
        const a = readFileSync(path.join(reference, relative));
        const b = readFileSync(path.join(out, relative));
        assert.ok(a.equals(b), `${name}/${relative}: bytes differ`);
      }
      checked += 1;
    });
  }
  assert.ok(checked > 0, `no fixtures found under ${dir}`);
});

test("lz4 roundtrip basics", () => {
  // literals + non-overlapping match (match len 4, offset 1)
  let out = Buffer.alloc(10);
  lz4Decode(Buffer.from([0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 1, 0]), out);
  assert.equal(out.toString("latin1"), "abcdefffff");

  // overlapping match (RLE): 2 literals, match len 4, offset 1
  out = Buffer.alloc(6);
  lz4Decode(Buffer.from([0x20, 0x78, 0x79, 1, 0]), out);
  assert.equal(out.toString("latin1"), "xyyyyy");

  // long literals with length continuation (15 + 100)
  const input = Buffer.concat([Buffer.from([0xf0, 100]), Buffer.alloc(115, 0x4c)]);
  out = Buffer.alloc(115);
  lz4Decode(input, out);
  assert.ok(out.every((byte) => byte === 0x4c));

  // leading zero padding is stripped
  const padded = Buffer.concat([Buffer.from([0, 0]), Buffer.from([0x10, 0x7a, 1, 0])]);
  out = Buffer.alloc(5);
  lz4Decode(stripLeadingZeros(padded), out);
  assert.equal(out.toString("latin1"), "zzzzz");
});

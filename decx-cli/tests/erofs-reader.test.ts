import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ErofsImage, NotErofsImageError } from "../src/android/erofs-reader.js";
import { resetTestDir } from "./test-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * EROFS fixtures generated with mkfs.erofs 1.9.4, byte-verified against
 * fsck.erofs --extract:
 *
 * - apex_payload_erofs.img (80 KiB): compact indexes, LZ4 fragments, *   multi-lcluster extents, a PLAIN incompressible jar, an empty file, a
 *   symlink (javalib/link.jar -> core-oj.jar) and a fragment-backed manifest.
 *   Jars/apk are REAL zip files so the framework pipeline can open them.
 *   Layout: apex_manifest.pb (25 B), app/CtsShim/base.apk (real zip),
 *   etc/classes.txt (278999 B), javalib/core-oj.jar (40000 B real zip, PLAIN),
 *   javalib/empty.bin (0 B), javalib/link.jar (symlink).
 * - apex_payload_erofs_ztp.img (16 KiB): ztailpacking inline tail
 *   (javalib/service.jar, 14379 B real zip).
 * - apex_payload_erofs_deflate.img (128 KiB): DEFLATE compression
 *   (etc/table.csv 151774 B, plus a real jar for the pipeline).
 *
 * Regenerate with `node tests/fixtures/gen-erofs-fixtures.mjs` (needs
 * erofs-utils 1.9.x on PATH); files are padded to the exact sizes asserted
 * by tests/erofs-reader.test.ts.
 */
const FIXTURE = path.join(__dirname, "fixtures", "apex_payload_erofs.img");
const ZTP_FIXTURE = path.join(__dirname, "fixtures", "apex_payload_erofs_ztp.img");
const DEFLATE_FIXTURE = path.join(__dirname, "fixtures", "apex_payload_erofs_deflate.img");

function withImage<T>(fixture: string, fn: (image: ErofsImage) => T): T {
  const image = ErofsImage.open(fixture);
  try {
    return fn(image);
  } finally {
    image.close();
  }
}

describe("erofs image reader", () => {
  it("rejects non-erofs images", () => {
    const rootDir = resetTestDir("tmp", "erofs-not-erofs");
    const bogus = path.join(rootDir, "bogus.img");
    writeFileSync(bogus, Buffer.alloc(4096, 0));
    expect(() => ErofsImage.open(bogus)).toThrow(NotErofsImageError);
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("reads the root directory", () => {
    withImage(FIXTURE, (image) => {
      const names = image.listDir("/").map((entry) => `${entry.name}:${entry.kind}`).sort();
      expect(names).toEqual(["apex_manifest.pb:file", "app:dir", "etc:dir", "javalib:dir"]);
    });
  });

  it("reads a fragment-backed file", () => {
    withImage(FIXTURE, (image) => {
      const manifest = image.readFile("/apex_manifest.pb");
      expect(manifest.length).toBe(25);
      expect(manifest.toString("utf8")).toContain("APEX manifest payload");
    });
  });

  it("reads a multi-lcluster LZ4 file byte-exactly", () => {
    withImage(FIXTURE, (image) => {
      const text = image.readFile("/etc/classes.txt");
      expect(text.length).toBe(278999);
      expect(text.subarray(0, 28).toString("utf8")).toBe("public final class Klass0000");
      expect(text.subarray(-30).toString("utf8")).toContain("*/ } }");
    });
  });

  it("reads PLAIN (incompressible) clusters and empty files", () => {
    withImage(FIXTURE, (image) => {
      const jar = image.readFile("/javalib/core-oj.jar");
      expect(jar.length).toBe(40000);
      expect(jar.subarray(0, 2).toString("latin1")).toBe("PK");
      expect(image.readFile("/javalib/empty.bin").length).toBe(0);
    });
  });

  it("follows symlinks when reading by path", () => {
    withImage(FIXTURE, (image) => {
      const viaLink = image.readFile("/javalib/link.jar");
      expect(viaLink.length).toBe(40000);
      expect(viaLink.equals(image.readFile("/javalib/core-oj.jar"))).toBe(true);
    });
  });

  it("extracts only matching files into a target directory", () => {
    const rootDir = resetTestDir("tmp", "erofs-extract");
    const outDir = path.join(rootDir, "out");
    const extracted = withImage(FIXTURE, (image) =>
      image.extractTo(outDir, (relative) => relative.endsWith(".jar")),
    );
    expect(extracted.sort()).toEqual(["javalib/core-oj.jar"]);
    // link.jar is a symlink: skipped, not materialized
    expect(existsSync(path.join(outDir, "javalib", "core-oj.jar"))).toBe(true);
    expect(existsSync(path.join(outDir, "javalib", "link.jar"))).toBe(false);
    expect(existsSync(path.join(outDir, "etc"))).toBe(false);
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("reads ztailpacking inline tails", () => {
    withImage(ZTP_FIXTURE, (image) => {
      const jar = image.readFile("/javalib/service.jar");
      expect(jar.length).toBe(14379);
      expect(jar.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    });
  });

  it("reads DEFLATE-compressed payloads", () => {
    withImage(DEFLATE_FIXTURE, (image) => {
      const csv = image.readFile("/etc/table.csv");
      expect(csv.length).toBe(151774);
      expect(csv.subarray(0, 3).toString("utf8")).toBe("0,z");
    });
  });
});

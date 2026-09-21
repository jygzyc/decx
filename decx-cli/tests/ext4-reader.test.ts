import { existsSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { Ext4Image, NotExt4ImageError } from "../src/android/ext4-reader.js";
import { resetTestDir } from "./test-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Real APEX payload image (com.android.apex.cts.shim, ext4, 274432 bytes)
 * pulled from a device. Layout verified against debugfs:
 *   /app/CtsShim@MAIN/CtsShim.apk
 *   /priv-app/CtsShimPriv@MAIN/CtsShimPriv.apk
 *   /etc/..., /apex_manifest.pb (29 bytes)
 */
const FIXTURE = path.join(__dirname, "fixtures", "apex_payload_ext4.img");

function withImage<T>(fn: (image: Ext4Image) => T): T {
  const image = Ext4Image.open(FIXTURE);
  try {
    return fn(image);
  } finally {
    image.close();
  }
}

describe("ext4 image reader", () => {
  it("rejects non-ext4 images", () => {
    const rootDir = resetTestDir("tmp", "ext4-not-ext4");
    const bogus = path.join(rootDir, "bogus.img");
    writeFileSync(bogus, Buffer.alloc(4096, 0));
    expect(() => Ext4Image.open(bogus)).toThrow(NotExt4ImageError);
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("reads the root directory", () => {
    withImage((image) => {
      const names = image.listDir("/").map((entry) => entry.name).sort();
      expect(names).toEqual([".", "..", "apex_manifest.pb", "app", "etc", "lost+found", "priv-app"]);
    });
  });

  it("reads a small regular file", () => {
    withImage((image) => {
      const manifest = image.readFile("/apex_manifest.pb");
      expect(manifest.length).toBe(29);
    });
  });

  it("resolves nested versioned directories", () => {
    withImage((image) => {
      const entries = image.listDir("/app/CtsShim@MAIN");
      expect(entries.map((entry) => entry.name)).toContain("CtsShim.apk");
    });
  });

  it("extracts only matching files and skips lost+found", () => {
    const rootDir = resetTestDir("tmp", "ext4-extract");
    const outDir = path.join(rootDir, "out");
    const extracted = withImage((image) =>
      image.extractTo(outDir, (relative) => relative.toLowerCase().endsWith(".apk")),
    );
    expect(extracted.sort()).toEqual([
      "app/CtsShim@MAIN/CtsShim.apk",
      "priv-app/CtsShimPriv@MAIN/CtsShimPriv.apk",
    ]);
    expect(existsSync(path.join(outDir, "app", "CtsShim@MAIN", "CtsShim.apk"))).toBe(true);
    expect(existsSync(path.join(outDir, "lost+found"))).toBe(false);
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns NotExt4ImageError for images without a superblock", () => {
    const rootDir = resetTestDir("tmp", "ext4-unsupported");
    const truncated = path.join(rootDir, "truncated.img");
    writeFileSync(truncated, Buffer.from("clearly not a filesystem image"));
    expect(() => Ext4Image.open(truncated)).toThrow(NotExt4ImageError);
    rmSync(rootDir, { recursive: true, force: true });
  });
});

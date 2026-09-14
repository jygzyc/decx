import type { Ext4Image as Ext4ImageHandle } from "../src/ext4-reader";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const path = require("path");
const { Ext4Image, NotExt4ImageError, UnsupportedImageFeatureError } = require("../src/ext4-reader.js");

const BLOCK_SIZE = 1024;
const INODE_TABLE_BLOCK = 3;
const INODE_SIZE = 128;
const INODES_PER_GROUP = 32;
const EXTENT_MAGIC = 0xf30a;
const EXT4_MAGIC = 0xef53;
const FLAG_EXTENTS = 0x80000;
const FLAG_ENCRYPT = 0x800;

const MODE_DIRECTORY = 0x4000 | 0o755;
const MODE_REGULAR = 0x8000 | 0o644;
const MODE_SYMLINK = 0xa000 | 0o777;

function writeInode(buffer: Buffer, inode: number, options: { mode: number; size: number; flags: number; block?: number; inline?: string }): void {
  const base = INODE_TABLE_BLOCK * BLOCK_SIZE + (inode - 1) * INODE_SIZE;
  buffer.writeUInt16LE(options.mode, base);
  buffer.writeUInt32LE(options.size, base + 4);
  buffer.writeUInt32LE(options.flags, base + 32);
  if (options.inline !== undefined) {
    buffer.write(options.inline, base + 40, "utf8");
    return;
  }
  const inodeBlock = base + 40;
  buffer.writeUInt16LE(EXTENT_MAGIC, inodeBlock);
  buffer.writeUInt16LE(1, inodeBlock + 2);
  buffer.writeUInt16LE(4, inodeBlock + 4);
  buffer.writeUInt16LE(0, inodeBlock + 6);
  buffer.writeUInt32LE(0, inodeBlock + 12);
  buffer.writeUInt16LE(1, inodeBlock + 16);
  buffer.writeUInt16LE(0, inodeBlock + 18);
  buffer.writeUInt32LE(options.block ?? 0, inodeBlock + 20);
}

function writeDirBlock(buffer: Buffer, block: number, entries: Array<{ inode: number; type: number; name: string }>): void {
  const base = block * BLOCK_SIZE;
  let offset = 0;
  entries.forEach((entry, index) => {
    const needed = Math.ceil((8 + entry.name.length) / 4) * 4;
    const recLen = index === entries.length - 1 ? BLOCK_SIZE - offset : needed;
    buffer.writeUInt32LE(entry.inode, base + offset);
    buffer.writeUInt16LE(recLen, base + offset + 4);
    buffer.writeUInt8(entry.name.length, base + offset + 6);
    buffer.writeUInt8(entry.type, base + offset + 7);
    buffer.write(entry.name, base + offset + 8, "utf8");
    offset += recLen;
  });
}

/**
 * Image layout: block 7 = root dir, 8 = hello.txt, 9 = sub dir, 10 = nested,
 * 11 = encrypted. Inodes: 2 root, 12 hello, 13 sub, 14 nested, 15 link, 16 secret.
 */
function buildFixtureImage(): Buffer {
  const buffer = Buffer.alloc(BLOCK_SIZE * 16);

  const superblock = buffer.subarray(1024, 1536);
  superblock.writeUInt32LE(INODES_PER_GROUP, 0);
  superblock.writeUInt32LE(16, 4);
  superblock.writeUInt32LE(1, 20);
  superblock.writeUInt32LE(0, 24);
  superblock.writeUInt32LE(64, 32);
  superblock.writeUInt32LE(INODES_PER_GROUP, 40);
  superblock.writeUInt16LE(EXT4_MAGIC, 56);
  superblock.writeUInt16LE(INODE_SIZE, 88);
  superblock.writeUInt16LE(32, 256);
  buffer.writeUInt32LE(INODE_TABLE_BLOCK, 2 * BLOCK_SIZE + 8);

  writeInode(buffer, 2, { mode: MODE_DIRECTORY, size: BLOCK_SIZE, flags: FLAG_EXTENTS, block: 7 });
  writeInode(buffer, 12, { mode: MODE_REGULAR, size: 10, flags: FLAG_EXTENTS, block: 8 });
  writeInode(buffer, 13, { mode: MODE_DIRECTORY, size: BLOCK_SIZE, flags: FLAG_EXTENTS, block: 9 });
  writeInode(buffer, 14, { mode: MODE_REGULAR, size: 6, flags: FLAG_EXTENTS, block: 10 });
  writeInode(buffer, 15, { mode: MODE_SYMLINK, size: 9, flags: 0, inline: "hello.txt" });
  writeInode(buffer, 16, {
    mode: MODE_REGULAR,
    size: 6,
    flags: FLAG_EXTENTS | FLAG_ENCRYPT,
    block: 11,
  });

  buffer.write("hello ext4", 8 * BLOCK_SIZE, "utf8");
  buffer.write("nested", 10 * BLOCK_SIZE, "utf8");
  buffer.write("secret", 11 * BLOCK_SIZE, "utf8");

  writeDirBlock(buffer, 7, [
    { inode: 2, type: 2, name: "." },
    { inode: 2, type: 2, name: ".." },
    { inode: 12, type: 1, name: "hello.txt" },
    { inode: 13, type: 2, name: "sub" },
    { inode: 15, type: 7, name: "link.txt" },
    { inode: 16, type: 1, name: "secret.txt" },
  ]);
  writeDirBlock(buffer, 9, [
    { inode: 13, type: 2, name: "." },
    { inode: 2, type: 2, name: ".." },
    { inode: 14, type: 1, name: "nested.txt" },
  ]);
  return buffer;
}

function withImage<T>(contents: Buffer, run: (imagePath: string, dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "decx-ext4-"));
  try {
    const imagePath = path.join(dir, "payload.img");
    writeFileSync(imagePath, contents);
    return run(imagePath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rejects images without an ext4 superblock", () => {
  withImage(Buffer.alloc(2048, 0x41), (imagePath) => {
    assert.throws(() => Ext4Image.open(imagePath), NotExt4ImageError);
  });
});

test("lists directories and reads files through the extent tree", () => {
  withImage(buildFixtureImage(), (imagePath) => {
    const image: Ext4ImageHandle = Ext4Image.open(imagePath);
    try {
      const names = image
        .listDir("/")
        .map((entry) => entry.name)
        .filter((name) => name !== "." && name !== "..")
        .sort();
      assert.deepEqual(names, ["hello.txt", "link.txt", "secret.txt", "sub"]);
      assert.equal(image.readFile("/hello.txt").toString("utf8"), "hello ext4");
      assert.equal(image.readFile("/sub/nested.txt").toString("utf8"), "nested");
      assert.equal(image.readFile("/link.txt").toString("utf8"), "hello ext4");
      assert.throws(() => image.readFile("/secret.txt"), UnsupportedImageFeatureError);
      assert.throws(() => image.readFile("/missing.txt"), UnsupportedImageFeatureError);
    } finally {
      image.close();
    }
  });
});

test("extractTo honors the filter and preserves the inner layout", () => {
  withImage(buildFixtureImage(), (imagePath, dir) => {
    const image: Ext4ImageHandle = Ext4Image.open(imagePath);
    const outDir = path.join(dir, "payload");
    try {
      const extracted = image
        .extractTo(outDir, (relative) => relative.endsWith(".txt") && !relative.includes("secret"))
        .sort();
      assert.deepEqual(extracted, ["hello.txt", "link.txt", "sub/nested.txt"]);
      assert.equal(readFileSync(path.join(outDir, "hello.txt"), "utf8"), "hello ext4");
      assert.equal(readFileSync(path.join(outDir, "sub", "nested.txt"), "utf8"), "nested");
    } finally {
      image.close();
    }
  });
});

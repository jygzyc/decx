/**
 * Minimal read-only ext4 image reader for APEX payload images.
 *
 * Parses the filesystem natively (superblock → group descriptors → inodes →
 * extent trees → directory entries) so payload extraction needs no external
 * tools (debugfs/WSL). Only the read paths used by APEX payloads are
 * implemented; unsupported layouts raise {@link UnsupportedImageFeatureError}
 * so callers can fall back to the external-tool pipeline.
 */
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from "fs";
import * as path from "path";

const EXT4_MAGIC = 0xef53;
const EXTENT_MAGIC = 0xf30a;
const ROOT_INODE = 2;
const SUPERBLOCK_OFFSET = 1024;
const MAX_SYMLINK_DEPTH = 10;

const INODE_MODE_FMT_MASK = 0xf000;
const MODE_REG = 0x8000;
const MODE_DIR = 0x4000;
const MODE_LNK = 0xa000;

const FLAG_EXTENTS = 0x80000;
const FLAG_INLINE_DATA = 0x10000000;
const FLAG_ENCRYPT = 0x800;

const DIRENT_MIN = 8;
const DIRENT_FT_REG = 1;
const DIRENT_FT_DIR = 2;
const DIRENT_FT_LNK = 7;

/** Image is a filesystem this module cannot parse; caller should fall back to tools. */
export class UnsupportedImageFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedImageFeatureError";
  }
}

export class NotExt4ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotExt4ImageError";
  }
}

export interface Ext4DirEntry {
  name: string;
  inode: number;
  kind: "file" | "dir" | "symlink";
}

interface Extent {
  logicalBlock: number;
  physicalBlock: number;
  blockCount: number;
  unwritten: boolean;
}

interface ImageGeometry {
  blockSize: number;
  inodesPerGroup: number;
  inodeSize: number;
  groupDescOffset: number; // byte offset of group descriptor 0
  groupDescSize: number;
}

interface InodeInfo {
  mode: number;
  size: number;
  flags: number;
  raw: Buffer; // full inode bytes (fast-symlink targets live in i_block)
}

interface Ext4Node {
  name: string;
  kind: "file" | "dir" | "symlink";
  inode: number;
}

/** Node kind derived from the dirent file_type, trusted over dirent names. */
function direntKind(fileType: number): Ext4Node["kind"] | null {
  switch (fileType) {
    case DIRENT_FT_REG:
      return "file";
    case DIRENT_FT_DIR:
      return "dir";
    case DIRENT_FT_LNK:
      return "symlink";
    default:
      return null;
  }
}

export class Ext4Image {
  private readonly fd: number;
  private readonly geometry: ImageGeometry;

  private constructor(fd: number, geometry: ImageGeometry) {
    this.fd = fd;
    this.geometry = geometry;
  }

  static open(imagePath: string): Ext4Image {
    const fd = openSync(imagePath, "r");
    try {
      const geometry = readGeometry(fd);
      return new Ext4Image(fd, geometry);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  close(): void {
    closeSync(this.fd);
  }

  private readAt(position: number, length: number): Buffer {
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const read = readSync(this.fd, buffer, total, length - total, position + total);
      if (read <= 0) {
        throw new UnsupportedImageFeatureError(`Unexpected EOF at ${position + total}`);
      }
      total += read;
    }
    return buffer;
  }

  private readBlock(block: number): Buffer {
    return this.readAt(block * this.geometry.blockSize, this.geometry.blockSize);
  }

  private inode(ino: number): InodeInfo {
    if (ino === 0) throw new UnsupportedImageFeatureError("Lookup of inode 0");
    const { blockSize, inodesPerGroup, inodeSize, groupDescOffset, groupDescSize } = this.geometry;
    const group = Math.floor((ino - 1) / inodesPerGroup);
    const index = (ino - 1) % inodesPerGroup;
    const desc = this.readAt(groupDescOffset + group * groupDescSize, groupDescSize);
    const tableBlock = desc.readUInt32LE(8) + (groupDescSize === 64 ? desc.readUInt32LE(40) * 2 ** 32 : 0);
    if (tableBlock === 0) throw new UnsupportedImageFeatureError(`No inode table for group ${group}`);

    const inodeOffset = tableBlock * blockSize + index * inodeSize;
    const raw = this.readAt(inodeOffset, inodeSize);
    return {
      mode: raw.readUInt16LE(0),
      size: raw.readUInt32LE(4) + raw.readUInt32LE(108) * 2 ** 32,
      flags: raw.readUInt32LE(32),
      raw,
    };
  }

  private inodeKind(ino: number): Ext4Node["kind"] {
    const mode = this.inode(ino).mode & INODE_MODE_FMT_MASK;
    if (mode === MODE_REG) return "file";
    if (mode === MODE_DIR) return "dir";
    if (mode === MODE_LNK) return "symlink";
    throw new UnsupportedImageFeatureError(`Inode ${ino} has unsupported mode 0x${mode.toString(16)}`);
  }

  /** Collect leaf extents of an inode's extent tree. */
  private extents(inode: InodeInfo): Extent[] {
    const result: Extent[] = [];
    const walk = (header: Buffer, depthGuard: number): void => {
      if (depthGuard > 4) throw new UnsupportedImageFeatureError("Extent tree too deep");
      if (header.readUInt16LE(0) !== EXTENT_MAGIC) {
        throw new UnsupportedImageFeatureError("Inode without extent tree (legacy block pointers)");
      }
      const entries = header.readUInt16LE(2);
      const depth = header.readUInt16LE(6);
      for (let i = 0; i < entries; i += 1) {
        const at = 12 + i * 12;
        if (depth === 0) {
          const len = header.readUInt16LE(at + 4);
          result.push({
            logicalBlock: header.readUInt32LE(at),
            physicalBlock: header.readUInt32LE(at + 8) + header.readUInt16LE(at + 6) * 2 ** 32,
            blockCount: len & 0x7fff,
            unwritten: (len & 0x8000) !== 0,
          });
        } else {
          const childBlock =
            header.readUInt32LE(at + 4) + header.readUInt16LE(at + 8) * 2 ** 32;
          walk(this.readBlock(childBlock), depthGuard + 1);
        }
      }
    };
    walk(inode.raw.subarray(40, 100), 0);
    return result;
  }

  /** Full data of a regular file or slow symlink, honoring holes/unwritten extents. */
  private readInodeData(inode: InodeInfo): Buffer {
    const { blockSize } = this.geometry;
    const out = Buffer.alloc(inode.size);
    if (inode.size === 0) return out;
    for (const extent of this.extents(inode)) {
      const start = extent.logicalBlock * blockSize;
      const end = Math.min(start + extent.blockCount * blockSize, inode.size);
      if (end <= start || extent.unwritten) continue; // holes stay zero
      const chunk = this.readAt(extent.physicalBlock * blockSize, end - start);
      chunk.copy(out, start);
    }
    return out;
  }

  private readSymlink(inode: InodeInfo): string {
    if (inode.size > 60) return this.readInodeData(inode).toString("utf8");
    const inline = inode.raw.subarray(40, 40 + inode.size);
    // An extent-based symlink longer than 60 bytes goes through readInodeData;
    // short symlinks store the target directly in i_block.
    if (inline.readUInt16LE(0) === EXTENT_MAGIC && inode.flags & FLAG_EXTENTS) {
      return this.readInodeData(inode).toString("utf8");
    }
    return inline.toString("utf8");
  }

  /** Directory entries of one directory inode. */
  listDir(innerPath: string): Ext4DirEntry[] {
    const dirIno = this.resolveInode(innerPath);
    const inode = this.inode(dirIno);
    if ((inode.mode & INODE_MODE_FMT_MASK) !== MODE_DIR) {
      throw new UnsupportedImageFeatureError(`${innerPath} is not a directory`);
    }
    return this.listDirEntriesOfInode(dirIno);
  }

  /** Raw content of a regular file at innerPath. */
  readFile(innerPath: string): Buffer {
    const ino = this.resolveInode(innerPath);
    const inode = this.inode(ino);
    if ((inode.mode & INODE_MODE_FMT_MASK) === MODE_LNK) {
      return this.readFile(this.resolveLink(innerPath, this.readSymlink(inode), 0));
    }
    if ((inode.mode & INODE_MODE_FMT_MASK) !== MODE_REG) {
      throw new UnsupportedImageFeatureError(`${innerPath} is not a regular file`);
    }
    this.checkReadableInode(inode, innerPath);
    return this.readInodeData(inode);
  }

  private checkReadableInode(inode: InodeInfo, label: string): void {
    if (inode.flags & FLAG_ENCRYPT) {
      throw new UnsupportedImageFeatureError(`${label} is encrypted`);
    }
    if (inode.flags & FLAG_INLINE_DATA) {
      throw new UnsupportedImageFeatureError(`${label} uses inline data`);
    }
    if (!(inode.flags & FLAG_EXTENTS)) {
      throw new UnsupportedImageFeatureError(`${label} has no extent tree`);
    }
  }

  private resolveLink(fromPath: string, target: string, depth: number): string {
    if (depth > MAX_SYMLINK_DEPTH) throw new UnsupportedImageFeatureError("Symlink chain too deep");
    if (target.startsWith("/")) return normalizeInnerPath(target);
    const base = fromPath.split("/").slice(0, -1).join("/");
    return normalizeInnerPath(`${base}/${target}`);
  }

  /** Resolve an inner path (following symlinks) to an inode number. */
  private resolveInode(innerPath: string, depth = 0): number {
    if (depth > MAX_SYMLINK_DEPTH) throw new UnsupportedImageFeatureError("Symlink chain too deep");
    const segments = normalizeInnerPath(innerPath).split("/").filter(Boolean);
    let ino = ROOT_INODE;
    for (let i = 0; i < segments.length; i += 1) {
      const entry = this.listDirEntriesOfInode(ino).find((candidate) => candidate.name === segments[i]);
      if (!entry) throw new UnsupportedImageFeatureError(`No such entry: ${innerPath}`);
      if (entry.kind === "symlink") {
        const link = this.readSymlink(this.inode(entry.inode));
        const basePath = link.startsWith("/") ? "" : segments.slice(0, i).join("/");
        const remaining = segments.slice(i + 1).join("/");
        const combined = [basePath, link, remaining].filter(Boolean).join("/");
        return this.resolveInode(combined, depth + 1);
      }
      ino = entry.inode;
    }
    return ino;
  }

  private listDirEntriesOfInode(ino: number): Ext4DirEntry[] {
    const inode = this.inode(ino);
    if ((inode.mode & INODE_MODE_FMT_MASK) !== MODE_DIR) {
      throw new UnsupportedImageFeatureError(`Inode ${ino} is not a directory`);
    }
    const { blockSize } = this.geometry;
    const entries: Ext4DirEntry[] = [];
    const dirBlocks = new Set(
      this.extents(inode).flatMap((e) =>
        Array.from({ length: e.blockCount }, (_, i) => e.physicalBlock + i),
      ),
    );
    for (const block of dirBlocks) {
      const data = this.readBlock(block);
      let offset = 0;
      while (offset + DIRENT_MIN <= blockSize) {
        const recLen = data.readUInt16LE(offset + 4);
        if (recLen < DIRENT_MIN || offset + recLen > blockSize) break;
        const entryIno = data.readUInt32LE(offset);
        const nameLen = data.readUInt8(offset + 6);
        const fileType = data.readUInt8(offset + 7);
        if (entryIno !== 0 && nameLen > 0 && offset + DIRENT_MIN + nameLen <= offset + recLen) {
          const name = data.subarray(offset + DIRENT_MIN, offset + DIRENT_MIN + nameLen).toString("utf8");
          const kind = direntKind(fileType);
          entries.push({ name, inode: entryIno, kind: kind ?? "file" });
        }
        offset += recLen;
      }
    }
    return entries;
  }

  /**
   * Walk the whole tree starting at `/` and extract regular files matching
   * `shouldExtract` into outDir, preserving inner paths. Symlinks pointing at
   * matching files are followed. Returns the extracted relative paths.
   */
  extractTo(outDir: string, shouldExtract: (relativePath: string) => boolean): string[] {
    const extracted: string[] = [];
    const visitedDirs = new Set<number>();
    const walk = (dirIno: number, prefix: string, depth: number): void => {
      if (depth > 32 || visitedDirs.has(dirIno)) return;
      visitedDirs.add(dirIno);
      for (const entry of this.listDirEntriesOfInode(dirIno)) {
        if (entry.name === "." || entry.name === ".." || entry.name === "lost+found") continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const kind = this.inodeKind(entry.inode);
        if (kind === "dir") {
          walk(entry.inode, relative, depth + 1);
          continue;
        }
        if (kind !== "file") continue; // devices, sockets, fifos: skip
        if (!shouldExtract(relative)) continue;
        const inode = this.inode(entry.inode);
        this.checkReadableInode(inode, relative);
        const target = path.join(outDir, ...relative.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, this.readInodeData(inode));
        extracted.push(relative);
      }
    };
    walk(ROOT_INODE, "", 0);
    return extracted;
  }
}

function normalizeInnerPath(innerPath: string): string {
  const out: string[] = [];
  for (const segment of innerPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function readGeometry(fd: number): ImageGeometry {
  const read = (offset: number, length: number): Buffer => {
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const n = readSync(fd, buffer, total, length - total, offset + total);
      if (n <= 0) throw new NotExt4ImageError("Image too small to be ext4");
      total += n;
    }
    return buffer;
  };
  const sb = read(SUPERBLOCK_OFFSET, 512);
  if (sb.readUInt16LE(56) !== EXT4_MAGIC) {
    throw new NotExt4ImageError("Superblock magic not found");
  }
  const blockSize = 1024 * (1 << sb.readUInt32LE(24));
  const firstDataBlock = sb.readUInt32LE(20);
  const descSize = blockSize > 1024 ? sb.readUInt16LE(256) || 32 : 32;
  return {
    blockSize,
    inodesPerGroup: sb.readUInt32LE(40),
    inodeSize: sb.readUInt16LE(88),
    groupDescOffset: (firstDataBlock + 1) * blockSize,
    groupDescSize: descSize === 32 || descSize === 64 ? descSize : 32,
  };
}

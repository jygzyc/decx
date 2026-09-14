/**
 * Minimal read-only EROFS image reader for APEX payload images.
 *
 * Pure-JavaScript implementation of the EROFS on-disk format (kernel
 * `fs/erofs/erofs_fs.h`; decoding logic ported from `fs/erofs/zmap.c`,
 * `dir.c`, `data.c`, `decompressor.c`): superblock -> inode
 * (compact/extended) -> dirent walk -> file reads, covering exactly the
 * layouts `apexer`/`mkfs.erofs` produce for APEX payloads:
 *
 * - datalayout 0 (flat plain), 2 (flat inline tail), 3 (compressed compact
 *   indexes) with LZ4 compression, big pclusters, `fragments` + dedupe
 *   (packed inode) and `ztailpacking` (inline compressed tails);
 * - PLAIN lclusters inside compressed inodes (SHIFTED raw storage).
 *
 * Multi-device / metabox / 48-bit / chunked / LZMA-deflate-zstd / interlaced
 * layouts are not produced for APEX payloads and raise
 * {@link UnsupportedErofsFeatureError} so callers can fall back to the
 * external-tool pipeline.
 *
 * LZ4 pclusters are self-contained LZ4 blocks (the kernel decodes each
 * pcluster with a single `LZ4_decompress_safe` call, no dictionary), so a
 * plain block decoder is sufficient.
 */
const { closeSync, mkdirSync, openSync, readSync, writeFileSync } = require("fs");
const path = require("path");

const EROFS_MAGIC = 0xe0f5e1e2; // little-endian bytes e2 e1 f5 e0
const SUPERBLOCK_OFFSET = 1024;
const MAX_SYMLINK_DEPTH = 10;

// i_format datalayouts
const DL_FLAT_PLAIN = 0;
const DL_COMPRESSED_FULL = 1;
const DL_FLAT_INLINE = 2;
const DL_COMPRESSED_COMPACT = 3;
const DL_CHUNK_BASED = 4;

// superblock feature_incompat bits
const INCOMPAT_LZ4_0PADDING = 0x1;
const INCOMPAT_BIG_PCLUSTER = 0x2; // == COMPR_CFGS
const INCOMPAT_CHUNKED_FILE = 0x4;
const INCOMPAT_COMPR_HEAD2_OR_DEVICE = 0x8;
const INCOMPAT_ZTAILPACKING = 0x10;
const INCOMPAT_FRAGMENTS = 0x20; // == DEDUPE
const INCOMPAT_XATTR_PREFIXES = 0x40;
const INCOMPAT_48BIT = 0x80;
const INCOMPAT_METABOX = 0x100;
const INCOMPAT_SUPPORTED =
  INCOMPAT_LZ4_0PADDING | INCOMPAT_BIG_PCLUSTER | INCOMPAT_ZTAILPACKING | INCOMPAT_FRAGMENTS;

// z map header advise bits
const ADVISE_COMPACTED_2B = 0x1;
const ADVISE_BIG_PCLUSTER_1 = 0x2;
const ADVISE_BIG_PCLUSTER_2 = 0x4;
const ADVISE_INLINE_PCLUSTER = 0x8;
const ADVISE_INTERLACED_PCLUSTER = 0x10;
const ADVISE_FRAGMENT_PCLUSTER = 0x20;

// lcluster types
const LCT_PLAIN = 0;
const LCT_HEAD1 = 1;
const LCT_NONHEAD = 2;
const LCT_HEAD2 = 3;

const LI_D0_CBLKCNT = 1 << 11;

const MODE_FORMAT_MASK = 0xf000;
const MODE_REG = 0x8000;
const MODE_DIR = 0x4000;
const MODE_LNK = 0xa000;

const DIRENT_SIZE = 12;
const DIRENT_FT_REG = 1;
const DIRENT_FT_DIR = 2;
const DIRENT_FT_LNK = 7;

const NULL_ADDR = 0xffffffff; // 48-bit -1 hole marker

/** Parsed superblock fields used by the reader. */
interface ErofsSuperblock {
  blockSize: number;
  blkSzBits: number;
  metaBase: number;
  rootNid: number;
  packedNid: number;
}

/** One inode as returned by the reader's `inode()`. */
interface ErofsInode {
  nid: number;
  iloc: number;
  inodeIsize: number;
  xattrIsize: number;
  mode: number;
  size: number;
  dataLayout: number;
  startblkOrBlocks: number;
}

/** One directory entry; `kind` is derived from the dirent file_type. */
interface ErofsDirEntry {
  name: string;
  nid: number;
  kind: string;
}

/** Parsed z map header of a compressed inode. */
interface ZInfo {
  advise: number;
  lclusterBits: number;
  fragmentOff: number;
  idataSize: number;
  wholePacked: boolean;
  ebase: number;
  compact: boolean;
  totalIdx: number;
  tailExtentHeadLcn: number;
}

/** One logical cluster record of the z map. */
interface Lcluster {
  lcn: number;
  ltype: number;
  clusterOfs: number;
  delta0: number;
  delta1: number;
  compressedBlks: number | null;
  pblk: number | null;
  nextPackOff: number;
}

/** Result of one z_erofs_map_blocks_fo call. */
interface MapResult {
  mapped: boolean;
  meta: boolean;
  fragment: boolean;
  mLa: number;
  mPa: number;
  mPlen: number;
  llen: number;
  headType: number;
  algFmt: number;
  tailLcn: number;
  nextPackOff: number;
}

/** `{ map, head }` pair returned by `mapBlocksFo`. */
interface MapBlocksResult {
  map: MapResult;
  head: Lcluster;
}

/** Image is not EROFS at all; caller should fall back to tools. */
class NotErofsImageError extends Error {
  constructor(message = "not an erofs image") {
    super(message);
    this.name = "NotErofsImageError";
  }
}

/** EROFS layout this reader deliberately does not parse; caller should fall back to tools. */
class UnsupportedErofsFeatureError extends Error {
  constructor(what: string) {
    super(`unsupported image feature: ${what}`);
    this.name = "UnsupportedErofsFeatureError";
  }
}

/** Structurally broken image; never falls back, the image is corrupt. */
class MalformedErofsImageError extends Error {
  constructor(why: string) {
    super(`malformed image: ${why}`);
    this.name = "MalformedErofsImageError";
  }
}

/** Node kind derived from the dirent file_type, unknown values default to file. */
function direntKind(fileType: number): string | null {
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

class ErofsImage {
  packedCache: Buffer | null = null;
  packedReading = false;
  declare fd: number;
  declare sb: ErofsSuperblock;

  constructor(fd: number, sb: ErofsSuperblock) {
    this.fd = fd;
    this.sb = sb;
  }

  static open(imagePath: string): ErofsImage {
    const fd = openSync(imagePath, "r");
    try {
      return new ErofsImage(fd, readSuperblock(fd));
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  close(): void {
    closeSync(this.fd);
  }

  listDir(innerPath: string): ErofsDirEntry[] {
    const nid = this.resolveNid(innerPath, 0);
    const inode = this.inode(nid);
    if ((inode.mode & MODE_FORMAT_MASK) !== MODE_DIR) {
      throw new MalformedErofsImageError(`${innerPath} is not a directory`);
    }
    return this.listDirEntriesOfInode(inode);
  }

  readFile(innerPath: string): Buffer {
    return this.readFileInner(innerPath, 0);
  }

  /**
   * Walk the tree from `/` and extract regular files for which
   * `shouldExtract(relativePath)` holds into `outDir`, preserving inner
   * paths. Symlinks/devices/sockets are skipped. Returns the extracted
   * relative paths.
   */
  extractTo(outDir: string, shouldExtract: (relativePath: string) => boolean): string[] {
    const extracted: string[] = [];
    const visited = new Set<number>();
    this.walkForExtract(this.sb.rootNid, "", 0, outDir, shouldExtract, visited, extracted);
    return extracted;
  }

  // ── low-level IO ────────────────────────────────────────────────────────

  readAt(position: number, length: number): Buffer {
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const read = readSync(this.fd, buffer, total, length - total, position + total);
      if (read <= 0) {
        throw new MalformedErofsImageError(`unexpected EOF at ${position + total}`);
      }
      total += read;
    }
    return buffer;
  }

  // ── inodes ──────────────────────────────────────────────────────────────

  inode(nid: number): ErofsInode {
    if (nid > 0x3fffffff) {
      throw new MalformedErofsImageError(`implausible nid ${nid}`);
    }
    const iloc = this.sb.metaBase + nid * 32;
    const head = this.readAt(iloc, 32);
    const ifmt = head.readUInt16LE(0);
    const version = ifmt & 1;
    const dataLayout = (ifmt >>> 1) & 7;
    // On-disk inode (v1.7/6.6 layout): compact 32B with u32 i_size@8,
    // extended 64B with u64 i_size@8; i_u @16 in BOTH — compressed
    // total blocks, flat startblk, or chunk info depending on layout.
    const inodeIsize = version === 0 ? 32 : 64;
    const size =
      version === 0
        ? head.readUInt32LE(8)
        : head.readUInt32LE(8) + head.readUInt32LE(12) * 2 ** 32;
    const startblkOrBlocks = head.readUInt32LE(16);
    const xattrIcount = head.readUInt16LE(2);
    const xattrIsize = xattrIcount === 0 ? 0 : 12 + 4 * (xattrIcount - 1);
    const mode = head.readUInt16LE(4);
    return { nid, iloc, inodeIsize, xattrIsize, mode, size, dataLayout, startblkOrBlocks };
  }

  // ── directories ─────────────────────────────────────────────────────────

  listDirEntriesOfInode(dir: ErofsInode): ErofsDirEntry[] {
    if ((dir.mode & MODE_FORMAT_MASK) !== MODE_DIR) {
      throw new MalformedErofsImageError(`nid ${dir.nid} is not a directory`);
    }
    const entries: ErofsDirEntry[] = [];
    const bs = this.sb.blockSize;
    // FLAT_INLINE dirs keep full blocks on disk and the final partial block
    // inline right after the inode + xattrs (erofs dir.c: the inline tail
    // covers `size - nblk * bs` bytes).
    const inlineTail = dir.dataLayout === DL_FLAT_INLINE;
    const nblk = inlineTail ? Math.floor(dir.size / bs) : Math.ceil(dir.size / bs);
    let pos = 0;
    while (pos < dir.size) {
      const lblock = Math.floor(pos / bs);
      let data;
      let maxsize;
      if (lblock < nblk) {
        const len = Math.min(dir.size - pos, bs);
        data = this.readAt(dir.startblkOrBlocks * bs + lblock * bs, len);
        maxsize = len;
      } else {
        const ipos = dir.iloc + dir.inodeIsize + dir.xattrIsize;
        const len = dir.size - pos;
        data = this.readAt(ipos, len);
        maxsize = len;
      }
      const nameoff0 = data.readUInt16LE(8);
      if (nameoff0 === 0 || nameoff0 > maxsize || nameoff0 % DIRENT_SIZE !== 0) {
        throw new MalformedErofsImageError(
          `bogus dirent block in nid ${dir.nid} (nameoff0=${nameoff0})`,
        );
      }
      const count = nameoff0 / DIRENT_SIZE;
      for (let i = 0; i < count; i += 1) {
        const at = i * DIRENT_SIZE;
        const nid = Number(data.readBigUInt64LE(at));
        const nameoff = data.readUInt16LE(at + 8);
        if (nameoff < DIRENT_SIZE || nameoff >= maxsize) {
          throw new MalformedErofsImageError(`bogus dirent nameoff ${nameoff} in nid ${dir.nid}`);
        }
        // kernel: last dirent name = strnlen(name, maxsize - nameoff)
        let nameBytes;
        if (i + 1 < count) {
          const next = data.readUInt16LE(at + DIRENT_SIZE + 8);
          if (next < nameoff || next > maxsize) {
            throw new MalformedErofsImageError(`bogus dirent name span in nid ${dir.nid}`);
          }
          nameBytes = data.subarray(nameoff, next);
        } else {
          const slice = data.subarray(nameoff, maxsize);
          const nul = slice.indexOf(0);
          nameBytes = nul === -1 ? slice : slice.subarray(0, nul);
        }
        if (nameBytes.length === 0) continue;
        entries.push({
          name: nameBytes.toString("utf8"),
          nid,
          kind: direntKind(data[at + 10]) ?? "file",
        });
      }
      pos += maxsize;
    }
    return entries;
  }

  resolveNid(innerPath: string, depth: number): number {
    if (depth > MAX_SYMLINK_DEPTH) {
      throw new MalformedErofsImageError("symlink chain too deep");
    }
    const segments = innerPath.split("/").filter((s) => s !== "" && s !== ".");
    let nid = this.sb.rootNid;
    for (let i = 0; i < segments.length; i += 1) {
      const entry = this.listDirEntriesOfInode(this.inode(nid)).find(
        (candidate) => candidate.name === segments[i],
      );
      if (!entry) {
        throw new MalformedErofsImageError(`no such entry: ${innerPath}`);
      }
      if (entry.kind === "symlink") {
        const link = this.readSymlink(this.inode(entry.nid));
        const basePath = link.startsWith("/") ? "" : segments.slice(0, i).join("/");
        const remaining = segments.slice(i + 1).join("/");
        const combined = [basePath, link, remaining].filter(Boolean).join("/");
        return this.resolveNid(combined, depth + 1);
      }
      nid = entry.nid;
    }
    return nid;
  }

  // ── symlinks & flat files ───────────────────────────────────────────────

  readSymlink(inode: ErofsInode): string {
    return this.readFlat(inode).toString("utf8");
  }

  /** Flat datalayouts (0 plain, 2 inline tail). Holes stay zero. */
  readFlat(inode: ErofsInode): Buffer {
    const bs = this.sb.blockSize;
    const size = inode.size;
    const out = Buffer.alloc(size);
    const isHole = inode.dataLayout === DL_FLAT_PLAIN && inode.startblkOrBlocks === NULL_ADDR;
    if (isHole || size === 0) {
      return out;
    }
    const blocks = Math.ceil(size / bs);
    const fullLen = inode.dataLayout === DL_FLAT_INLINE ? (blocks - 1) * bs : size;
    if (fullLen > 0) {
      this.readAt(inode.startblkOrBlocks * bs, fullLen).copy(out, 0);
    }
    if (inode.dataLayout === DL_FLAT_INLINE && size > fullLen) {
      // Tail bytes live inline right after the inode + xattrs.
      const pos = inode.iloc + inode.inodeIsize + inode.xattrIsize;
      this.readAt(pos, size - fullLen).copy(out, fullLen);
    }
    return out;
  }

  // ── compressed files ────────────────────────────────────────────────────

  /** Parse the z map header; runs the FINDTAIL pass for fragment /
   * ztailpacked inodes (kernel `z_erofs_fill_inode_lazy`). */
  loadZInfo(inode: ErofsInode): ZInfo {
    const hdrPos = Math.ceil((inode.iloc + inode.inodeIsize + inode.xattrIsize) / 8) * 8;
    const h = this.readAt(hdrPos, 8);
    const ebase = hdrPos + 8;
    const base: ZInfo = {
      advise: 0,
      lclusterBits: this.sb.blkSzBits,
      fragmentOff: 0,
      idataSize: 0,
      wholePacked: false,
      ebase,
      compact: inode.dataLayout === DL_COMPRESSED_COMPACT,
      totalIdx: 0,
      tailExtentHeadLcn: Infinity,
    };
    if ((h[7] & 0x80) !== 0) {
      // Whole file packed into the packed inode.
      const rawOffset = h.readBigUInt64LE(0);
      return {
        ...base,
        advise: ADVISE_FRAGMENT_PCLUSTER,
        wholePacked: true,
        fragmentOff: Number(rawOffset ^ (1n << 63n)),
        tailExtentHeadLcn: 0,
      };
    }
    const advise = h.readUInt16LE(4);
    const lclusterBits = this.sb.blkSzBits + (h[7] & 7);
    const lclusterSize = 2 ** lclusterBits;
    // totalIdx = erofs_iblks() = ceil(i_size / logical cluster size).
    const totalIdx = Math.ceil(inode.size / lclusterSize);
    for (const fmt of [h[6] & 15, (h[6] >>> 4) & 15]) {
      if (fmt !== 0) {
        throw new UnsupportedErofsFeatureError(
          `compression algorithm ${fmt} (only LZ4 is supported)`,
        );
      }
    }
    const fragmentOff = (advise & ADVISE_FRAGMENT_PCLUSTER) !== 0 ? h.readUInt32LE(0) : 0;
    const idataSize = (advise & ADVISE_INLINE_PCLUSTER) !== 0 ? h.readUInt16LE(2) : 0;
    const z = { ...base, advise, lclusterBits, fragmentOff, idataSize, totalIdx };
    if (inode.size > 0 && ((advise & ADVISE_FRAGMENT_PCLUSTER) !== 0 || idataSize > 0)) {
      // FINDTAIL: map the last byte once to locate the EOF tail extent.
      const { map } = this.mapBlocksFo(inode, z, inode.size - 1, true);
      z.tailExtentHeadLcn = map.tailLcn;
      if (idataSize > 0) {
        // ztailpacked inline data sits at the last index-pack position.
        z.fragmentOff = map.nextPackOff;
      }
    }
    return z;
  }

  /** Port of kernel `z_erofs_load_compact_lcluster`. */
  loadLcluster(inode: ErofsInode, z: ZInfo, lcn: number, lookahead: boolean): Lcluster {
    if (!z.compact) {
      return this.loadFullLcluster(z, lcn);
    }
    if (lcn >= z.totalIdx || z.lclusterBits > 14) {
      throw new MalformedErofsImageError(`bad lcluster index ${lcn}`);
    }
    const bigPcluster = (z.advise & ADVISE_BIG_PCLUSTER_1) !== 0;
    const compacted4bInitial = ((32 - (z.ebase % 32)) / 4) & 7;
    let compacted2b = 0;
    if ((z.advise & ADVISE_COMPACTED_2B) !== 0 && compacted4bInitial < z.totalIdx) {
      compacted2b = Math.floor((z.totalIdx - compacted4bInitial) / 16) * 16;
    }
    let pos = z.ebase;
    let index = lcn;
    const origLcn = lcn; // out.lcn must keep the ORIGINAL logical number
    let shift = 2; // 4-byte units
    if (lcn >= compacted4bInitial) {
      pos += compacted4bInitial * 4;
      index -= compacted4bInitial;
      if (index < compacted2b) {
        shift = 1;
      } else {
        pos += compacted2b * 2;
        index -= compacted2b;
      }
    }
    pos += index * 2 ** shift;
    const vcnt = shift === 2 ? 2 : 16;
    const packsize = shift === 2 ? 8 : 32;
    if (shift === 1 && z.lclusterBits > 12) {
      throw new MalformedErofsImageError("lclusterbits > 12 with 2B packs");
    }
    const packStart = pos - (pos % packsize);
    const bytesIn = pos - packStart;
    const i0 = bytesIn >>> shift;
    // pack + trailing u32 base blkaddr
    const raw = this.readAt(packStart, packsize + 4);
    const lobits = z.lclusterBits;
    const encodebits = ((packsize - 4) * 8) / vcnt;

    const decode = (idx: number): [number, number] => {
      const bitpos = encodebits * idx;
      const byte = Math.floor(bitpos / 8);
      const v = raw.readUInt32LE(byte) >>> (bitpos % 8);
      return [v & ((1 << lobits) - 1), (v >>> lobits) & 3];
    };

    const [lo, ltype] = decode(i0);
    const nextPackOff = packStart + packsize;
    if (ltype === LCT_NONHEAD) {
      const out: Lcluster = {
        lcn: origLcn,
        ltype,
        clusterOfs: 1 << Math.min(z.lclusterBits, 14),
        delta0: 0,
        delta1: 0,
        compressedBlks: null,
        pblk: null,
        nextPackOff,
      };
      if (lookahead) {
        out.delta1 = compactedLaDistance(decode, vcnt, i0);
      }
      if ((lo & LI_D0_CBLKCNT) !== 0) {
        if (!bigPcluster) {
          throw new MalformedErofsImageError("CBLKCNT without big pcluster");
        }
        out.compressedBlks = lo & ~LI_D0_CBLKCNT;
        out.delta0 = 1;
      } else if (i0 + 1 !== vcnt) {
        out.delta0 = lo;
      } else {
        // Last lcluster of the pack: lo holds delta[1]; recover delta[0]
        // from the previous index.
        const [loPrev, tPrev] = decode(i0 - 1);
        let recovered;
        if (tPrev !== LCT_NONHEAD) {
          recovered = 0;
        } else if ((loPrev & LI_D0_CBLKCNT) !== 0) {
          recovered = 1;
        } else {
          recovered = loPrev;
        }
        out.delta0 = recovered + 1;
      }
      return out;
    }
    // HEAD / PLAIN: count preceding heads in this pack for pblk.
    let nblk;
    if (!bigPcluster) {
      nblk = 1;
      let i = i0;
      while (i > 0) {
        i -= 1;
        const [lo2, t2] = decode(i);
        if (t2 === LCT_NONHEAD) {
          i -= lo2;
        }
        if (i >= 0) {
          nblk += 1;
        }
      }
    } else {
      nblk = 0;
      let i = i0;
      while (i > 0) {
        i -= 1;
        const [lo2, t2] = decode(i);
        if (t2 === LCT_NONHEAD) {
          if ((lo2 & LI_D0_CBLKCNT) !== 0) {
            i -= 1;
            nblk += lo2 & ~LI_D0_CBLKCNT;
            continue;
          }
          if (lo2 <= 1) {
            throw new MalformedErofsImageError("big pcluster d0 <= 1");
          }
          i -= lo2 - 2;
          continue;
        }
        nblk += 1;
      }
    }
    return {
      lcn: origLcn,
      ltype,
      clusterOfs: lo,
      delta0: 0,
      delta1: 0,
      compressedBlks: null,
      pblk: raw.readUInt32LE(packsize - 4) + nblk,
      nextPackOff,
    };
  }

  /** Kernel `z_erofs_load_full_lcluster`: COMPRESSED_FULL inodes keep
   * plain 8-byte index records at Z_EROFS_FULL_INDEX_ALIGN(...) = ebase+8. */
  loadFullLcluster(z: ZInfo, lcn: number): Lcluster {
    if (lcn >= z.totalIdx) {
      throw new MalformedErofsImageError(`bad lcluster index ${lcn}`);
    }
    const pos = z.ebase + 8 + lcn * 8;
    const raw = this.readAt(pos, 8);
    const advise = raw.readUInt16LE(0);
    const ltype = advise & 3;
    const nextPackOff = pos + 8;
    if (ltype === LCT_NONHEAD) {
      const d0 = raw.readUInt16LE(4);
      const delta1 = raw.readUInt16LE(6);
      let delta0;
      let compressedBlks;
      if ((d0 & LI_D0_CBLKCNT) !== 0) {
        if ((z.advise & (ADVISE_BIG_PCLUSTER_1 | ADVISE_BIG_PCLUSTER_2)) === 0) {
          throw new MalformedErofsImageError("CBLKCNT without big pcluster");
        }
        delta0 = 1;
        compressedBlks = d0 & ~LI_D0_CBLKCNT;
      } else {
        delta0 = d0;
        compressedBlks = null;
      }
      return {
        lcn,
        ltype,
        clusterOfs: 1 << Math.min(z.lclusterBits, 14),
        delta0,
        delta1,
        compressedBlks,
        pblk: null,
        nextPackOff,
      };
    }
    const clusterOfs = raw.readUInt16LE(2);
    if (clusterOfs >= 2 ** z.lclusterBits) {
      throw new MalformedErofsImageError(`bad clusterofs ${clusterOfs}`);
    }
    return {
      lcn,
      ltype,
      clusterOfs,
      delta0: 0,
      delta1: 0,
      compressedBlks: null,
      pblk: raw.readUInt32LE(4),
      nextPackOff,
    };
  }

  /** Kernel `z_erofs_extent_lookback` — returns (head lcluster, headtype, m_la). */
  extentLookback(inode: ErofsInode, z: ZInfo, m: Lcluster, lookback: number): [Lcluster, number, number] {
    let cur = m;
    let dist = lookback;
    while (cur.lcn >= dist && dist !== 0) {
      const lcn = cur.lcn - dist;
      cur = this.loadLcluster(inode, z, lcn, false);
      if (cur.ltype === LCT_NONHEAD) {
        dist = cur.delta0;
        continue;
      }
      const headtype = cur.ltype;
      const mLa = lcn * 2 ** z.lclusterBits + cur.clusterOfs;
      return [cur, headtype, mLa];
    }
    throw new MalformedErofsImageError(
      `bogus lookback distance ${dist} @ lcn ${cur.lcn}`,
    );
  }

  /** Kernel `z_erofs_get_extent_compressedlen` — returns m_plen in BYTES. */
  extentCompressedlen(inode: ErofsInode, z: ZInfo, head: Lcluster, headtype: number): number {
    const lclusterSize = 2 ** z.lclusterBits;
    const bigpcl1 = (z.advise & ADVISE_BIG_PCLUSTER_1) !== 0;
    const bigpcl2 = (z.advise & ADVISE_BIG_PCLUSTER_2) !== 0;
    // PLAIN, or a HEAD type without its big-pcluster advise bit: the
    // pcluster spans exactly one logical cluster.
    if (
      headtype === LCT_PLAIN ||
      (headtype === LCT_HEAD1 && !bigpcl1) ||
      (headtype === LCT_HEAD2 && !bigpcl2)
    ) {
      return lclusterSize;
    }
    if (head.compressedBlks !== null) {
      return head.compressedBlks * this.sb.blockSize;
    }
    const lcn2 = head.lcn + 1;
    if (lcn2 * lclusterSize >= inode.size) {
      return lclusterSize;
    }
    const next = this.loadLcluster(inode, z, lcn2, false);
    if (next.ltype !== LCT_NONHEAD) {
      // Next lcluster is already a new head: one-lcluster pcluster.
      return lclusterSize;
    }
    if (next.delta0 !== 1 || next.compressedBlks === null) {
      throw new MalformedErofsImageError("bogus CBLKCNT");
    }
    return next.compressedBlks * this.sb.blockSize;
  }

  /** Kernel `z_erofs_get_extent_decompressedlen` for a head extent. */
  extentDecompressedlen(inode: ErofsInode, z: ZInfo, head: Lcluster, mLa: number): number {
    const lclusterSize = 2 ** z.lclusterBits;
    let lcn = head.lcn;
    const headlcnExt = Math.floor(mLa / lclusterSize);
    // kernel reads m->clusterofs from the record the walk STOPS at
    // (the next head lcluster), not from the extent's own head.
    let stopClusterofs = 0;
    for (;;) {
      if (lcn * lclusterSize >= inode.size) {
        return inode.size - mLa;
      }
      const m = this.loadLcluster(inode, z, lcn, true);
      stopClusterofs = m.clusterOfs;
      if (m.ltype === LCT_NONHEAD) {
        // pre-1.0 mkfs workaround for delta[1] == 0
        const d1 = m.delta1 === 0 ? 1 : m.delta1;
        lcn += d1;
      } else {
        if (lcn !== headlcnExt) {
          break;
        }
        lcn += 1;
      }
    }
    return lcn * lclusterSize + stopClusterofs - mLa;
  }

  /** Kernel `z_erofs_map_blocks_fo` (read path). `findTail` runs the
   * FINDTAIL pass (records the tail head lcn in `map.tailLcn` and the last
   * index-pack position in `map.nextPackOff`). */
  mapBlocksFo(
    inode: ErofsInode,
    z: ZInfo,
    la: number,
    findTail: boolean,
  ): MapBlocksResult {
    const lcb = z.lclusterBits;
    const lclusterSize = 2 ** lcb;
    const fragment = (z.advise & ADVISE_FRAGMENT_PCLUSTER) !== 0;
    const ztail = z.idataSize > 0;
    const ofs = findTail ? inode.size - 1 : la;
    const map = emptyMapResult();
    let head = placeholderLcl();

    if (fragment && !findTail && z.tailExtentHeadLcn === 0) {
      // Whole file is a fragment of the packed inode.
      map.mapped = true;
      map.fragment = true;
      map.mLa = 0;
      map.mPa = z.fragmentOff;
      map.mPlen = 0;
      map.llen = inode.size;
      map.headType = LCT_HEAD1;
      map.algFmt = 0;
      map.tailLcn = 0;
      map.nextPackOff = 0;
      return { map, head };
    }

    const initialLcn = Math.floor(ofs / lclusterSize);
    const endoff = ofs % lclusterSize;
    let cur = this.loadLcluster(inode, z, initialLcn, false);
    map.nextPackOff = cur.nextPackOff;

    let end = (cur.lcn + 1) * lclusterSize;
    let headtype;
    let mLa;
    if (cur.ltype !== LCT_NONHEAD && endoff >= cur.clusterOfs) {
      headtype = cur.ltype;
      mLa = cur.lcn * lclusterSize + cur.clusterOfs;
      if (ztail && end > inode.size) {
        end = inode.size;
      }
    } else {
      const delta0 = cur.ltype === LCT_NONHEAD ? cur.delta0 : 1;
      const [headLcl, ht, la2] = this.extentLookback(inode, z, cur, Math.max(delta0, 1));
      cur = headLcl;
      headtype = ht;
      mLa = la2;
      if (ztail && end > inode.size) {
        end = inode.size;
      }
    }
    map.llen = Math.max(end - mLa, 0);
    map.mLa = mLa;
    map.headType = headtype;
    map.tailLcn = cur.lcn;
    head = cur;

    if (findTail) {
      return { map, head }; // caller reads map.tailLcn / map.nextPackOff
    }
    if (ztail && cur.lcn === z.tailExtentHeadLcn) {
      map.meta = true;
      map.mapped = true;
      map.mPa = z.fragmentOff;
      map.mPlen = z.idataSize;
      map.algFmt = 0;
      return { map, head };
    }
    if (fragment && cur.lcn === z.tailExtentHeadLcn) {
      map.fragment = true;
      map.mapped = true;
      map.mPa = z.fragmentOff;
      map.algFmt = 0;
      return { map, head };
    }
    if (cur.pblk === null) {
      throw new MalformedErofsImageError("head lcluster without blkaddr");
    }
    map.mapped = true;
    map.mPa = cur.pblk * this.sb.blockSize;
    map.mPlen = this.extentCompressedlen(inode, z, cur, headtype);
    if (map.mPlen === 0) {
      map.mapped = false;
    }
    if (headtype === LCT_PLAIN) {
      map.algFmt = (z.advise & ADVISE_INTERLACED_PCLUSTER) !== 0 ? 0xfe : 0xff; // SHIFTED raw
    } else if (headtype === LCT_HEAD2) {
      map.algFmt = 1; // validated at header parse (only LZ4 = 0 admitted)
    } else {
      map.algFmt = 0;
    }
    return { map, head };
  }

  readCompressed(inode: ErofsInode): Buffer {
    const z = this.loadZInfo(inode);
    const size = inode.size;
    const out = Buffer.alloc(size);
    if (size === 0) {
      return out;
    }
    if (z.wholePacked) {
      const packed = this.packedBytes();
      const start = z.fragmentOff;
      const end = start + size;
      if (end > packed.length) {
        throw new MalformedErofsImageError("fragment beyond packed inode");
      }
      packed.copy(out, 0, start, end);
      return out;
    }
    let la = 0;
    let guard = 0;
    while (la < size) {
      guard += 1;
      if (guard > 1_000_000) {
        throw new MalformedErofsImageError("compressed extent walk diverged");
      }
      const { map, head } = this.mapBlocksFo(inode, z, la, false);
      if (map.fragment) {
        const packed = this.packedBytes();
        // Fragment extents run to EOF; source offset in the packed file is
        // fragmentOff + (extent-relative position).
        const src = map.mPa + (la - map.mLa);
        if (src > packed.length) {
          throw new MalformedErofsImageError("fragment beyond packed inode");
        }
        const copy = Math.min(size - la, packed.length - src);
        packed.copy(out, la, src, src + copy);
        la += Math.max(copy, 1);
        continue;
      }
      if (map.meta) {
        // ztailpacked inline compressed tail: runs to EOF.
        const input = stripLeadingZeros(this.readAt(map.mPa, map.mPlen));
        lz4Decode(input, out.subarray(map.mLa));
        la = size;
        continue;
      }
      // Regular extent; decompressed length spans to the next head.
      const llen = Math.min(
        this.extentDecompressedlen(inode, z, head, map.mLa),
        size - map.mLa,
      );
      if (!map.mapped) {
        la = map.mLa + llen; // hole: zeros
        continue;
      }
      const dst = out.subarray(map.mLa, map.mLa + llen);
      const input = this.readAt(map.mPa, map.mPlen);
      const cofs = head.clusterOfs; // offset of mLa in the pcluster
      if (map.algFmt === 0xff) {
        // SHIFTED: literal from pcluster start, output <= input.
        if (llen > input.length) {
          throw new MalformedErofsImageError("shifted extent shorter than data");
        }
        input.copy(dst, 0, 0, llen);
      } else if (map.algFmt === 0xfe) {
        // INTERLACED: identity copy at the same offsets — the extent window
        // starts at its clusterofs inside the plain pcluster
        // (z_erofs_transform_plain).
        if (cofs + llen > input.length) {
          throw new MalformedErofsImageError("interlaced extent shorter than data");
        }
        input.copy(dst, 0, cofs, cofs + llen);
      } else {
        lz4Decode(stripLeadingZeros(input), dst);
      }
      la = map.mLa + llen;
    }
    return out;
  }

  readInodeData(inode: ErofsInode): Buffer {
    switch (inode.dataLayout) {
      case DL_FLAT_PLAIN:
      case DL_FLAT_INLINE:
        return this.readFlat(inode);
      case DL_COMPRESSED_COMPACT:
      case DL_COMPRESSED_FULL:
        return this.readCompressed(inode);
      case DL_CHUNK_BASED:
        throw new UnsupportedErofsFeatureError("chunk-based inodes");
      default:
        throw new MalformedErofsImageError(`datalayout ${inode.dataLayout}`);
    }
  }

  /** Content of the packed (fragment) inode, cached. */
  packedBytes(): Buffer {
    if (this.packedCache) {
      return this.packedCache;
    }
    if (this.packedReading) {
      throw new MalformedErofsImageError("packed inode contains fragments");
    }
    if (this.sb.packedNid === 0) {
      throw new MalformedErofsImageError("image has fragments but no packed inode");
    }
    this.packedReading = true;
    try {
      const packedInode = this.inode(this.sb.packedNid);
      switch (packedInode.dataLayout) {
        case DL_FLAT_PLAIN:
        case DL_FLAT_INLINE:
        case DL_COMPRESSED_COMPACT:
          this.packedCache = this.readInodeData(packedInode);
          return this.packedCache;
        default:
          throw new MalformedErofsImageError(
            `unexpected packed inode datalayout ${packedInode.dataLayout}`,
          );
      }
    } finally {
      this.packedReading = false;
    }
  }

  // ── path API ────────────────────────────────────────────────────────────

  readFileInner(innerPath: string, depth: number): Buffer {
    if (depth > MAX_SYMLINK_DEPTH) {
      throw new MalformedErofsImageError("symlink chain too deep");
    }
    const nid = this.resolveNid(innerPath, 0);
    const inode = this.inode(nid);
    if ((inode.mode & MODE_FORMAT_MASK) === MODE_LNK) {
      const target = this.resolveLink(innerPath, this.readSymlink(inode));
      return this.readFileInner(target, depth + 1);
    }
    if ((inode.mode & MODE_FORMAT_MASK) !== MODE_REG) {
      throw new MalformedErofsImageError(`${innerPath} is not a regular file`);
    }
    return this.readInodeData(inode);
  }

  resolveLink(fromPath: string, target: string): string {
    if (target.startsWith("/")) {
      return target.replace(/^\/+/, "");
    }
    const slash = fromPath.lastIndexOf("/");
    const base = slash === -1 ? "" : fromPath.slice(0, slash);
    return `${base}/${target}`.replace(/^\/+/, "");
  }

  walkForExtract(
    dirNid: number,
    prefix: string,
    depth: number,
    outDir: string,
    shouldExtract: (relativePath: string) => boolean,
    visited: Set<number>,
    extracted: string[],
  ): void {
    if (depth > 32 || visited.has(dirNid)) {
      return;
    }
    visited.add(dirNid);
    const dir = this.inode(dirNid);
    for (const entry of this.listDirEntriesOfInode(dir)) {
      if (entry.name === "." || entry.name === "..") {
        continue;
      }
      if (entry.name.includes("/") || entry.name.includes("\\")) {
        throw new MalformedErofsImageError(
          `entry name ${JSON.stringify(entry.name)} contains a path separator`,
        );
      }
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.kind === "dir") {
        this.walkForExtract(entry.nid, relative, depth + 1, outDir, shouldExtract, visited, extracted);
        continue;
      }
      if (entry.kind === "file") {
        if (!shouldExtract(relative)) {
          continue;
        }
        const inode = this.inode(entry.nid);
        if ((inode.mode & MODE_FORMAT_MASK) !== MODE_REG) {
          continue;
        }
        const data = this.readInodeData(inode);
        const target = path.join(outDir, ...relative.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, data);
        extracted.push(relative);
        continue;
      }
      // devices/sockets/symlinks skipped
    }
  }
}

function placeholderLcl(): Lcluster {
  return {
    lcn: 0,
    ltype: 0,
    clusterOfs: 0,
    delta0: 0,
    delta1: 0,
    compressedBlks: null,
    pblk: null,
    nextPackOff: 0,
  };
}

function emptyMapResult(): MapResult {
  return {
    mapped: false,
    meta: false,
    fragment: false,
    mLa: 0,
    mPa: 0,
    mPlen: 0,
    llen: 0,
    headType: 0,
    algFmt: 0,
    tailLcn: 0,
    nextPackOff: 0,
  };
}

/** Kernel `get_compacted_la_distance`. */
function compactedLaDistance(
  decode: (idx: number) => [number, number],
  vcnt: number,
  i0: number,
): number {
  let d1 = 0;
  let i = i0;
  let lo = 0;
  for (;;) {
    const [l, t] = decode(i);
    lo = l;
    if (t !== LCT_NONHEAD) {
      return d1;
    }
    d1 += 1;
    i += 1;
    if (i >= vcnt) {
      break;
    }
  }
  if ((lo & LI_D0_CBLKCNT) === 0 && lo > 0) {
    d1 += lo - 1;
  }
  return d1;
}

/** Kernel `z_erofs_fixup_insize`: skip leading zero padding of the first
 * compressed block. A valid LZ4 stream never starts with a zero token.
 * Exported for tests. */
function stripLeadingZeros(input: Buffer): Buffer {
  let start = 0;
  while (start < input.length && input[start] === 0) {
    start += 1;
  }
  return input.subarray(start);
}

/** Self-contained LZ4 block decode (kernel `LZ4_decompress_safe` semantics:
 * stop once `out` is full; trailing input ignored). Exported for tests. */
function lz4Decode(input: Buffer, out: Buffer): void {
  const bad = (why: string) =>
    new MalformedErofsImageError(`lz4: ${why}`);
  let ip = 0;
  let op = 0;
  while (op < out.length) {
    if (ip >= input.length) {
      throw bad("input exhausted");
    }
    const token = input[ip];
    ip += 1;
    let litLen = token >>> 4;
    if (litLen === 15) {
      for (;;) {
        if (ip >= input.length) {
          throw bad("literal length overrun");
        }
        const b = input[ip];
        ip += 1;
        litLen += b;
        if (b !== 255) {
          break;
        }
      }
    }
    if (ip + litLen > input.length || op + litLen > out.length) {
      throw bad("literal overrun");
    }
    input.copy(out, op, ip, ip + litLen);
    ip += litLen;
    op += litLen;
    if (op === out.length) {
      break; // stream may end right after the literals
    }
    if (ip + 2 > input.length) {
      throw bad("truncated match offset");
    }
    const offset = input.readUInt16LE(ip);
    ip += 2;
    if (offset === 0 || offset > op) {
      throw bad("bad match offset");
    }
    let matchLen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      for (;;) {
        if (ip >= input.length) {
          throw bad("match length overrun");
        }
        const b = input[ip];
        ip += 1;
        matchLen += b;
        if (b !== 255) {
          break;
        }
      }
    }
    if (op + matchLen > out.length) {
      throw bad("match overrun");
    }
    let src = op - offset;
    // byte-by-byte forward copy: LZ4 overlapping matches (RLE) must not be
    // turned into a memmove-style copy.
    for (let i = 0; i < matchLen; i += 1) {
      out[op] = out[src];
      op += 1;
      src += 1;
    }
  }
}

/** Superblock read that maps a short read to NotErofsImage (kernel-style
 * `read_exact_or_not_image`). */
function readSuperblock(fd: number): ErofsSuperblock {
  const sb = Buffer.alloc(128);
  let total = 0;
  while (total < sb.length) {
    const read = readSync(fd, sb, total, sb.length - total, SUPERBLOCK_OFFSET + total);
    if (read <= 0) {
      throw new NotErofsImageError();
    }
    total += read;
  }
  if (sb.readUInt32LE(0) !== EROFS_MAGIC) {
    throw new NotErofsImageError();
  }
  const blkSzBits = sb[12];
  if (blkSzBits < 9 || blkSzBits > 16) {
    throw new MalformedErofsImageError(`invalid blkszbits ${blkSzBits}`);
  }
  const blockSize = 2 ** blkSzBits;
  const featureIncompat = sb.readUInt32LE(80);
  const rejections: Array<[number, string]> = [
    [INCOMPAT_CHUNKED_FILE, "chunked files"],
    [INCOMPAT_COMPR_HEAD2_OR_DEVICE, "device table / compr-head2"],
    [INCOMPAT_XATTR_PREFIXES, "xattr prefixes"],
    [INCOMPAT_48BIT, "48-bit block addresses"],
    [INCOMPAT_METABOX, "metabox"],
  ];
  for (const [bit, what] of rejections) {
    if ((featureIncompat & bit) !== 0) {
      throw new UnsupportedErofsFeatureError(what);
    }
  }
  const unknown = featureIncompat & ~INCOMPAT_SUPPORTED;
  if (unknown !== 0) {
    throw new UnsupportedErofsFeatureError(`unknown incompat feature bits 0x${unknown.toString(16)}`);
  }
  const metaBlkaddr = sb.readUInt32LE(40);
  // meta_blkaddr == 0 is valid: apexer-style images put the inode table
  // right after the 128-byte superblock inside block 0 (iloc = nid * 32
  // starts at byte 1152).
  return {
    blockSize,
    blkSzBits,
    metaBase: metaBlkaddr * blockSize,
    rootNid: sb.readUInt16LE(14),
    packedNid: Number(sb.readBigUInt64LE(96)),
  };
}

export type { ErofsSuperblock, ErofsInode, ErofsDirEntry, ErofsImage };

module.exports = {
  NotErofsImageError,
  UnsupportedErofsFeatureError,
  MalformedErofsImageError,
  ErofsImage,
  stripLeadingZeros,
  lz4Decode,
};

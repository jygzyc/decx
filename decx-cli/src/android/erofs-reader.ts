/**
 * Minimal read-only EROFS image reader for APEX payload images.
 *
 * Parses the filesystem natively (superblock → inodes → dirents → data
 * mapping) so payload extraction needs no external tools (erofs-utils/WSL).
 * Only the read paths used by APEX payloads are implemented:
 *
 *  - inode layouts: compact (32B) and extended (64B)
 *  - datalayouts: FLAT_PLAIN, FLAT_INLINE (tail-packed inline data),
 *    CHUNK_BASED (with hole support) and both compressed layouts
 *    (COMPRESSED_COMPACT with 4B/2B packed indexes, COMPRESSED_FULL)
 *  - compression: LZ4 (hand-rolled block decoder), DEFLATE via node:zlib
 *    (standard library), uncompressed pclusters (shifted/interlaced)
 *  - big pclusters, zero-padding fixup, ztailpacking, fragments/dedupe
 *    (shared tails in the packed inode)
 *
 * Unsupported features (LZMA/ZSTD, extra devices, 48-bit inodes, metabox,
 * xattr prefixes) raise {@link UnsupportedImageFeatureError} so callers can
 * report a precise error instead of silently misreading.
 *
 * Ported from the reference implementations in Linux v6.6 (fs/erofs/zmap.c,
 * fs/erofs/data.c, fs/erofs/decompressor.c) and the on-disk format in
 * fs/erofs/erofs_fs.h (BUILD_BUG_ON-verified struct layouts).
 */
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from "fs";
import * as path from "path";
import { inflateRawSync } from "zlib";

const EROFS_SUPER_MAGIC_V1 = 0xe0f5e1e2;
const SUPERBLOCK_OFFSET = 1024;
const INODE_SLOT_BITS = 5; // 32-byte slots; extended inodes take 2 slots

// feature_incompat bits
const INCOMPAT_LZ4_0PADDING = 0x00000001;
const INCOMPAT_COMPR_CFGS = 0x00000002; // == BIG_PCLUSTER
const INCOMPAT_BIG_PCLUSTER = 0x00000002;
const INCOMPAT_CHUNKED_FILE = 0x00000004;
const INCOMPAT_COMPR_HEAD2 = 0x00000008; // == DEVICE_TABLE (extra_devices gates)
const INCOMPAT_ZTAILPACKING = 0x00000010;
const INCOMPAT_FRAGMENTS = 0x00000020; // == DEDUPE
const INCOMPAT_SUPPORTED =
  INCOMPAT_LZ4_0PADDING |
  INCOMPAT_COMPR_CFGS |
  INCOMPAT_BIG_PCLUSTER |
  INCOMPAT_CHUNKED_FILE |
  INCOMPAT_COMPR_HEAD2 |
  INCOMPAT_ZTAILPACKING |
  INCOMPAT_FRAGMENTS;

// inode datalayouts
const LAYOUT_FLAT_PLAIN = 0;
const LAYOUT_COMPRESSED_FULL = 1;
const LAYOUT_FLAT_INLINE = 2;
const LAYOUT_COMPRESSED_COMPACT = 3;
const LAYOUT_CHUNK_BASED = 4;

// i_format bits
const I_VERSION_MASK = 0x01;
const I_DATALAYOUT_MASK = 0x07;

// z_advise bits (per-inode)
const ADVISE_COMPACTED_2B = 0x0001;
const ADVISE_BIG_PCLUSTER_1 = 0x0002;
const ADVISE_BIG_PCLUSTER_2 = 0x0004;
const ADVISE_INLINE_PCLUSTER = 0x0008; // ztailpacking
const ADVISE_INTERLACED = 0x0010;
const ADVISE_FRAGMENT = 0x0020;

// compression algorithms (h_algorithmtype nibbles)
const COMPR_LZ4 = 0;
const COMPR_LZMA = 1;
const COMPR_DEFLATE = 2;
const COMPR_ZSTD = 3;

// lcluster index types
const LCLUSTER_PLAIN = 0;
const LCLUSTER_HEAD1 = 1;
const LCLUSTER_NONHEAD = 2;
const LCLUSTER_HEAD2 = 3;

// NONHEAD delta[0] bit flag: delta stores the compressed block count
const LI_D0_CBLKCNT = 1 << 11;

// chunk formats
const CHUNK_FORMAT_BLKBITS_MASK = 0x001f;
const CHUNK_FORMAT_INDEXES = 0x0020;
const CHUNK_FORMAT_48BIT = 0x0040;
const CHUNK_NULL_ADDR = 0xffffffff;

const MODE_FMT_MASK = 0xf000;
const MODE_REG = 0x8000;
const MODE_DIR = 0x4000;
const MODE_LNK = 0xa000;

const DIRENT_SIZE = 12; // struct erofs_dirent { nid u64; nameoff u16; file_type u8; reserved u8 }
const DIRENT_FT_REG = 1;
const DIRENT_FT_DIR = 2;
const DIRENT_FT_LNK = 7;

const MAP_HEADER_SIZE = 8; // struct z_erofs_map_header is 8 bytes (BUILD_BUG_ON-verified)
// kernel: Z_EROFS_FULL_INDEX_ALIGN(end) = ALIGN(end, 8) + map_header + 8
const FULL_INDEX_EXTRA = 8;
const MAX_BLOCKSIZE = 1 << 22;

/** Image is a filesystem this module cannot parse. */
export class UnsupportedImageFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedImageFeatureError";
  }
}

/** File is not an EROFS image (bad magic). */
export class NotErofsImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotErofsImageError";
  }
}

export interface ErofsDirEntry {
  name: string;
  nid: number;
  kind: "file" | "dir" | "symlink";
}

interface SuperBlock {
  blkszbits: number;
  rootNid: number;
  meta_blkaddr: number;
  packedNid: number;
  has0Padding: boolean;
}

interface InodeInfo {
  nid: number;
  mode: number;
  size: number;
  datalayout: number;
  iloc: number; // absolute byte offset of the on-disk inode
  isize: number; // 32 or 64
  xattrSize: number;
  startblk: number; // flat inodes: first data block (or CHUNK_NULL_ADDR)
  blocks: number; // compressed inodes: total lcluster count
  chunkFormat: number; // chunk-based inodes
}

interface MapHeader {
  wholeFileFragment: boolean;
  fragmentOff: number; // packed-inode offset of the (tail) fragment
  idataSize: number; // ztailpacking encoded size
  advise: number;
  algorithmtype: [number, number];
  lclusterbits: number;
}

interface IndexEntry {
  type: number; // LCLUSTER_*
  clusterofs: number;
  delta0: number;
  delta1: number;
  compressedblks: number;
  pblk: number;
  nextpackoff: number;
}

interface Extent {
  /** logical start offset of this extent in the decompressed file */
  la: number;
  /** decompressed length */
  llen: number;
  /** absolute byte offset of encoded data in the image */
  pa: number;
  /** encoded length */
  plen: number;
  /** COMPR_* algorithm for encoded extents, -1 for plain pclusters */
  algorithm: number;
  plainShifted: boolean; // plain lcluster layout (vs interlaced)
  isTailpack: boolean;
  isFragment: boolean;
  headLcn: number;
}

interface FragmentState {
  tailExtentHeadLcn: number;
  idataOff: number; // ztailpacking inline data offset
  fragmentOff: number; // 64-bit offset in the packed inode
}

/** LZ4 block decompression with known output size ("safe partial" semantics:
 * stop as soon as `dstLen` bytes are produced; trailing input is ignored —
 * zero-padded clusters leave slack bytes that are never read). */
function lz4Decompress(src: Buffer, srcStart: number, srcEnd: number, dstLen: number): Buffer {
  const dst = Buffer.alloc(dstLen);
  let s = srcStart;
  let d = 0;
  const bad = (why: string) => new UnsupportedImageFeatureError(`lz4: ${why}`);

  while (d < dstLen) {
    if (s >= srcEnd) throw bad("truncated cluster input");
    const token = src[s++];
    let litLen = token >> 4;
    if (litLen === 15) {
      for (;;) {
        if (s >= srcEnd) throw bad("truncated literal length");
        const extra = src[s++];
        litLen += extra;
        if (extra !== 255) break;
      }
    }
    if (s + litLen > srcEnd || d + litLen > dstLen) throw bad("literal run out of bounds");
    src.copy(dst, d, s, s + litLen);
    s += litLen;
    d += litLen;
    if (d === dstLen) break; // final literal run of the block

    if (s + 2 > srcEnd) throw bad("truncated match offset");
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0 || offset > d) throw bad("invalid match offset");

    let matchLen = (token & 0xf) + 4;
    if ((token & 0xf) === 15) {
      for (;;) {
        if (s >= srcEnd) throw bad("truncated match length");
        const extra = src[s++];
        matchLen += extra;
        if (extra !== 255) break;
      }
    }
    const remaining = dstLen - d;
    if (matchLen > remaining) throw bad("match overruns output");
    const p = d - offset;
    if (offset >= matchLen) {
      dst.copy(dst, d, p, p + matchLen); // non-overlapping: bulk copy
    } else {
      for (let k = 0; k < matchLen; k++) dst[d + k] = dst[p + k]; // RLE-style overlap
    }
    d += matchLen;
  }
  return dst;
}

export class ErofsImage {
  private readonly fd: number;
  private readonly sb: SuperBlock;
  private readonly inodeCache = new Map<number, InodeInfo>();
  private packedData: Buffer | null = null;

  private constructor(fd: number, sb: SuperBlock) {
    this.fd = fd;
    this.sb = sb;
  }

  static open(imagePath: string): ErofsImage {
    const fd = openSync(imagePath, "r");
    try {
      const head = Buffer.alloc(SUPERBLOCK_OFFSET + 128);
      let total = 0;
      while (total < head.length) {
        const read = readSync(fd, head, total, head.length - total, total);
        if (read <= 0) throw new NotErofsImageError("Image too small for an EROFS superblock");
        total += read;
      }
      const sbView = head.subarray(SUPERBLOCK_OFFSET);
      if (sbView.readUInt32LE(0) !== EROFS_SUPER_MAGIC_V1) {
        throw new NotErofsImageError("Bad EROFS superblock magic");
      }

      const featureIncompat = sbView.readUInt32LE(80);
      const unsupported = featureIncompat & ~INCOMPAT_SUPPORTED;
      if (unsupported) {
        throw new UnsupportedImageFeatureError(
          `EROFS feature_incompat 0x${unsupported.toString(16)} is not supported`,
        );
      }

      const blkszbits = sbView.readUInt8(12);
      if (blkszbits < 9 || 1 << blkszbits > MAX_BLOCKSIZE) {
        throw new UnsupportedImageFeatureError(`Unsupported EROFS block size 2^${blkszbits}`);
      }
      if (sbView.readUInt16LE(86) > 0) {
        throw new UnsupportedImageFeatureError("EROFS multi-device images are not supported");
      }
      const dirblkbits = sbView.readUInt8(90);
      if (dirblkbits !== 0 && dirblkbits !== blkszbits) {
        throw new UnsupportedImageFeatureError(
          `EROFS dirblkbits (${dirblkbits}) != blkszbits (${blkszbits})`,
        );
      }

      return new ErofsImage(fd, {
        blkszbits,
        rootNid: sbView.readUInt16LE(14),
        meta_blkaddr: sbView.readUInt32LE(40),
        packedNid: Number(sbView.readBigUInt64LE(96)),
        has0Padding: (featureIncompat & INCOMPAT_LZ4_0PADDING) !== 0,
      });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  close(): void {
    closeSync(this.fd);
  }

  private get blockSize(): number {
    return 1 << this.sb.blkszbits;
  }

  private readAt(position: number, length: number): Buffer {
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const read = readSync(this.fd, buffer, total, length - total, position + total);
      if (read <= 0) throw new UnsupportedImageFeatureError(`Unexpected EOF at ${position + total}`);
      total += read;
    }
    return buffer;
  }

  // ── inodes ────────────────────────────────────────────────────────────────

  private inode(nid: number): InodeInfo {
    const cached = this.inodeCache.get(nid);
    if (cached) return cached;

    const iloc = (this.sb.meta_blkaddr << this.sb.blkszbits) + (nid << INODE_SLOT_BITS);
    const raw = this.readAt(iloc, 64);
    const ifmt = raw.readUInt16LE(0);
    const version = ifmt & I_VERSION_MASK;
    const datalayout = (ifmt >> 1) & I_DATALAYOUT_MASK;
    const isize = version === 0 ? 32 : 64;
    if (datalayout >= 5) {
      throw new UnsupportedImageFeatureError(`Inode ${nid} has reserved datalayout ${datalayout}`);
    }

    const xattrIcount = raw.readUInt16LE(2);
    // both erofs_inode_compact and erofs_inode_extended store the i_u union at offset 16
    const iu = raw.readUInt32LE(16);
    const info: InodeInfo = {
      nid,
      mode: raw.readUInt16LE(4),
      size: version === 0 ? raw.readUInt32LE(8) : Number(raw.readBigUInt64LE(8)),
      datalayout,
      iloc,
      isize,
      xattrSize: xattrIcount ? 12 + 4 * (xattrIcount - 1) : 0,
      startblk: 0,
      blocks: 0,
      chunkFormat: 0,
    };

    if (datalayout === LAYOUT_FLAT_PLAIN || datalayout === LAYOUT_FLAT_INLINE) {
      info.startblk = iu;
    } else if (datalayout === LAYOUT_COMPRESSED_FULL || datalayout === LAYOUT_COMPRESSED_COMPACT) {
      info.blocks = iu;
    } else {
      info.chunkFormat = iu & 0xffff;
    }

    this.inodeCache.set(nid, info);
    return info;
  }

  private inodeKind(info: InodeInfo): "file" | "dir" | "symlink" | "other" {
    switch (info.mode & MODE_FMT_MASK) {
      case MODE_REG:
        return "file";
      case MODE_DIR:
        return "dir";
      case MODE_LNK:
        return "symlink";
      default:
        return "other";
    }
  }

  // ── directories ───────────────────────────────────────────────────────────

  private listDirEntriesOfInode(info: InodeInfo): ErofsDirEntry[] {
    const dirblk = this.blockSize;
    const data = this.readFileData(info);
    const entries: ErofsDirEntry[] = [];

    for (let base = 0; base + DIRENT_SIZE <= data.length; base += dirblk) {
      const end = Math.min(base + dirblk, data.length);
      const nameoff0 = data.readUInt16LE(base + 8);
      if (nameoff0 < DIRENT_SIZE || base + nameoff0 > end || nameoff0 % DIRENT_SIZE !== 0) {
        throw new UnsupportedImageFeatureError(`Corrupt directory block at ${base}`);
      }
      const count = nameoff0 / DIRENT_SIZE;
      for (let i = 0; i < count; i++) {
        const off = base + i * DIRENT_SIZE;
        const nid = Number(data.readBigUInt64LE(off));
        if (nid === 0) continue;
        const nameoff = data.readUInt16LE(off + 8);
        const fileType = data.readUInt8(off + 10);
        const nameStart = base + nameoff;
        const nameEnd =
          i + 1 < count ? base + data.readUInt16LE(base + (i + 1) * DIRENT_SIZE + 8) : end;
        if (nameStart < base + nameoff0 || nameStart >= end || nameEnd < nameStart || nameEnd > end) {
          throw new UnsupportedImageFeatureError(`Corrupt dirent name offsets at ${off}`);
        }
        let name = data.subarray(nameStart, nameEnd).toString("utf8");
        // the last name of a block may be followed by zero padding
        const nul = name.indexOf("\u0000");
        if (nul >= 0) name = name.slice(0, nul);
        if (!name || name === "." || name === "..") continue;
        entries.push({ name, nid, kind: direntKind(fileType) });
      }
    }
    return entries;
  }

  // ── flat / chunked data ───────────────────────────────────────────────────

  private readFlatOrChunked(info: InodeInfo): Buffer {
    const size = info.size;
    if (size === 0) return Buffer.alloc(0);
    const bs = this.blockSize;

    if (info.datalayout === LAYOUT_CHUNK_BASED) {
      if (info.chunkFormat & CHUNK_FORMAT_48BIT) {
        throw new UnsupportedImageFeatureError("48-bit chunk indexes are not supported");
      }
      const unit = info.chunkFormat & CHUNK_FORMAT_INDEXES ? 8 : 4;
      const chunkbits = this.sb.blkszbits + (info.chunkFormat & CHUNK_FORMAT_BLKBITS_MASK);
      const chunkSize = 1 << chunkbits;
      const lutStart = Math.ceil((info.iloc + info.isize + info.xattrSize) / unit) * unit;
      const chunkCount = Math.ceil(size / chunkSize);
      const lut = this.readAt(lutStart, chunkCount * unit);
      const out = Buffer.alloc(size);
      for (let i = 0; i < chunkCount; i++) {
        let addr: number;
        let deviceId = 0;
        if (unit === 4) {
          addr = lut.readUInt32LE(i * 4);
        } else {
          addr = lut.readUInt32LE(i * 8 + 4);
          deviceId = lut.readUInt16LE(i * 8 + 2);
        }
        if (addr === CHUNK_NULL_ADDR) continue; // hole: leave zeros
        if (deviceId !== 0) {
          throw new UnsupportedImageFeatureError("Chunked file on an extra device");
        }
        const start = i * chunkSize;
        this.readAt(addr * bs, Math.min(chunkSize, size - start)).copy(out, start);
      }
      return out;
    }

    const tailInline = info.datalayout === LAYOUT_FLAT_INLINE;
    const dataBlks = Math.ceil(size / bs) - (tailInline ? 1 : 0);
    const out = Buffer.alloc(size);
    const headLen = Math.min(size, dataBlks * bs);

    if (headLen > 0) {
      if (info.startblk === CHUNK_NULL_ADDR) return out; // unmapped: zeros
      this.readAt(info.startblk * bs, headLen).copy(out, 0);
    }
    if (tailInline && headLen < size) {
      const inlineStart = info.iloc + info.isize + info.xattrSize;
      const tailLen = size - headLen;
      if ((inlineStart % bs) + tailLen > bs) {
        throw new UnsupportedImageFeatureError("Inline tail crosses a block boundary");
      }
      this.readAt(inlineStart, tailLen).copy(out, headLen);
    }
    return out;
  }

  // ── compressed data ───────────────────────────────────────────────────────

  private mapHeaderPos(info: InodeInfo): number {
    return Math.ceil((info.iloc + info.isize + info.xattrSize) / 8) * 8;
  }

  private readMapHeader(info: InodeInfo): MapHeader {
    const raw = this.readAt(this.mapHeaderPos(info), MAP_HEADER_SIZE);
    // bit 7 of h_clusterbits marks a whole-file fragment inode; the rest of
    // the first 8 bytes is the 64-bit packed-inode offset
    const head64 = raw.readBigUInt64LE(0);
    if ((raw.readUInt8(7) & 0x80) !== 0) {
      return {
        wholeFileFragment: true,
        fragmentOff: Number(head64 ^ (1n << 63n)),
        idataSize: 0,
        advise: ADVISE_FRAGMENT,
        algorithmtype: [COMPR_LZ4, COMPR_LZ4],
        lclusterbits: this.sb.blkszbits,
      };
    }
    const advise = raw.readUInt16LE(4);
    if (info.datalayout === LAYOUT_COMPRESSED_FULL && (advise & ADVISE_COMPACTED_2B) !== 0) {
      // Z_EROFS_ADVISE_EXTENTS shares bit 0 with COMPACTED_2B and redefines the
      // index area as encoded-extent records (48-bit images, erofs-utils 1.9+)
      throw new UnsupportedImageFeatureError(
        "encoded-extents (48-bit EROFS) images are not supported",
      );
    }
    return {
      wholeFileFragment: false,
      fragmentOff: raw.readUInt32LE(0),
      idataSize: raw.readUInt16LE(2), // h_idata_size (ztailpacking encoded size)
      advise,
      algorithmtype: [raw.readUInt8(6) & 15, raw.readUInt8(6) >> 4],
      lclusterbits: this.sb.blkszbits + (raw.readUInt8(7) & 7),
    };
  }

  /** Load one lcluster index entry (compact packed or full 8-byte form). */
  private loadIndex(info: InodeInfo, hdr: MapHeader, lcn: number, lookahead: boolean): IndexEntry {
    const end = info.iloc + info.isize + info.xattrSize;
    const totalidx = Math.ceil(info.size / (1 << hdr.lclusterbits));
    if (lcn >= totalidx) throw new UnsupportedImageFeatureError(`lcluster index ${lcn} out of range`);

    if (info.datalayout === LAYOUT_COMPRESSED_FULL) {
      const pos = Math.ceil(end / 8) * 8 + MAP_HEADER_SIZE + FULL_INDEX_EXTRA + lcn * 8;
      const raw = this.readAt(pos, 8);
      const type = raw.readUInt16LE(0) & 3;
      const entry: IndexEntry = {
        type,
        clusterofs: 0,
        delta0: 0,
        delta1: 0,
        compressedblks: 0,
        pblk: 0,
        nextpackoff: pos + 8,
      };
      if (type === LCLUSTER_NONHEAD) {
        entry.clusterofs = 1 << hdr.lclusterbits;
        entry.delta0 = raw.readUInt16LE(4);
        if (entry.delta0 & LI_D0_CBLKCNT) {
          if (!(hdr.advise & (ADVISE_BIG_PCLUSTER_1 | ADVISE_BIG_PCLUSTER_2))) {
            throw new UnsupportedImageFeatureError("CBLKCNT without big pcluster advise");
          }
          entry.compressedblks = entry.delta0 & ~LI_D0_CBLKCNT;
          entry.delta0 = 1;
        }
        entry.delta1 = raw.readUInt16LE(6);
      } else {
        entry.clusterofs = raw.readUInt16LE(2);
        entry.pblk = raw.readUInt32LE(4);
      }
      return entry;
    }

    // COMPRESSED_COMPACT: 4-byte / 2-byte variable-packed indexes
    const ebase = MAP_HEADER_SIZE + Math.ceil(end / 8) * 8;
    const c4iRaw = (32 - (ebase % 32)) / 4;
    const c4i = c4iRaw === 8 ? 0 : c4iRaw;
    const c2b =
      hdr.advise & ADVISE_COMPACTED_2B && c4i < totalidx
        ? Math.floor((totalidx - c4i) / 16) * 16
        : 0;

    let pos = ebase;
    let lcnRel = lcn;
    let shift: number;
    if (lcnRel < c4i) {
      pos += lcnRel * 4;
      shift = 2;
    } else {
      pos += c4i * 4;
      lcnRel -= c4i;
      if (lcnRel < c2b) {
        pos += lcnRel * 2;
        shift = 1;
      } else {
        pos += c2b * 2 + (lcnRel - c2b) * 4;
        shift = 2;
      }
    }

    const lcb = hdr.lclusterbits;
    const vcnt = shift === 2 ? 2 : 16;
    if (shift === 2 && lcb > 14) {
      throw new UnsupportedImageFeatureError(`4-byte indexes with ${lcb}-bit lclusters unsupported`);
    }
    if (shift === 1 && lcb !== 12) {
      throw new UnsupportedImageFeatureError("2-byte indexes require 12-bit lclusters");
    }
    const encodebits = ((vcnt << shift) - 4) * 8 / vcnt;
    const lomask = (1 << lcb) - 1;

    // NOTE: pack alignment is WITHIN a filesystem block (kernel does
    // round_down(erofs_blkoff(pos), vcnt<<shift) into the block buffer);
    // packs never cross block boundaries.
    const packBytes = vcnt << shift;
    const eofs = pos & (this.blockSize - 1);
    const packBaseOff = eofs - (eofs % packBytes);
    const packStart = (pos & ~(this.blockSize - 1)) + packBaseOff;
    const pack = this.readAt(packStart, packBytes);
    const i = (eofs - packBaseOff) >> shift;

    const decode = (slot: number): { lo: number; type: number } => {
      const bitpos = encodebits * slot;
      const v = pack.readUInt32LE(bitpos >> 3) >>> (bitpos & 7);
      return { lo: v & lomask, type: (v >> lcb) & 3 };
    };

    const entry: IndexEntry = {
      type: 0,
      clusterofs: 0,
      delta0: 0,
      delta1: 0,
      compressedblks: 0,
      pblk: 0,
      nextpackoff: packStart + packBytes,
    };

    const bigPcluster1 = (hdr.advise & ADVISE_BIG_PCLUSTER_1) !== 0;
    const { lo, type } = decode(i);
    entry.type = type;

    if (type === LCLUSTER_NONHEAD) {
      entry.clusterofs = 1 << lcb;

      if (lookahead) {
        // kernel get_compacted_la_distance: walk forward to the next HEAD
        let d1 = 0;
        let slot = i;
        let cur = decode(slot);
        while (cur.type === LCLUSTER_NONHEAD) {
          d1++;
          if (++slot >= vcnt) {
            if (!(cur.lo & LI_D0_CBLKCNT)) d1 += cur.lo - 1;
            break;
          }
          cur = decode(slot);
        }
        entry.delta1 = d1;
      }

      if (lo & LI_D0_CBLKCNT) {
        if (!bigPcluster1) throw new UnsupportedImageFeatureError("CBLKCNT without big pcluster advise");
        entry.compressedblks = lo & ~LI_D0_CBLKCNT;
        entry.delta0 = 1;
        return entry;
      }
      if (i + 1 !== vcnt) {
        entry.delta0 = lo;
        return entry;
      }
      // the last slot of a pack stores delta[1]; recover delta[0] from slot i-1
      const prev = decode(i - 1);
      const prevLo = prev.type === LCLUSTER_NONHEAD ? (prev.lo & LI_D0_CBLKCNT ? 1 : prev.lo) : 0;
      entry.delta0 = prevLo + 1;
      return entry;
    }

    entry.clusterofs = lo;

    // walk back through the pack: pblk = pack tail u32 + blocks since pack start
    let nblk: number;
    if (!bigPcluster1) {
      nblk = 1;
      let slot = i;
      while (slot > 0) {
        slot--;
        const cur = decode(slot);
        if (cur.type === LCLUSTER_NONHEAD) slot -= cur.lo;
        if (slot >= 0) nblk++;
      }
    } else {
      nblk = 0;
      let slot = i;
      while (slot > 0) {
        slot--;
        const cur = decode(slot);
        if (cur.type === LCLUSTER_NONHEAD) {
          if (cur.lo & LI_D0_CBLKCNT) {
            slot--;
            nblk += cur.lo & ~LI_D0_CBLKCNT;
            continue;
          }
          if (cur.lo <= 1) throw new UnsupportedImageFeatureError("bogus big-pcluster delta");
          slot -= cur.lo - 2;
          continue;
        }
        nblk++;
      }
    }
    entry.pblk = pack.readUInt32LE(packBytes - 4) + nblk;
    return entry;
  }

  /** Follow NONHEAD deltas back to the extent's HEAD lcluster. */
  /** Kernel z_erofs_extent_lookback: walk back to the owning HEAD entry and
   * return it together with its lcluster number (kernel m.lcn). */
  private extentLookback(
    info: InodeInfo,
    hdr: MapHeader,
    lcn: number,
    distance: number,
  ): { entry: IndexEntry; headLcn: number } {
    let current = lcn;
    let lookback = distance;
    while (current >= lookback) {
      const target = current - lookback;
      const entry = this.loadIndex(info, hdr, target, false);
      if (entry.type === LCLUSTER_NONHEAD) {
        if (entry.delta0 === 0) throw new UnsupportedImageFeatureError("bogus lookback distance 0");
        lookback = entry.delta0;
        current = target;
        continue;
      }
      return { entry, headLcn: target };
    }
    throw new UnsupportedImageFeatureError(`bogus lookback at lcluster ${lcn}`);
  }

  /** Canonical extent decompressed length (kernel z_erofs_get_extent_decompressedlen). */
  private extentDecompressedLen(info: InodeInfo, hdr: MapHeader, headLcn: number, la: number): number {
    let lcn = headLcn;
    for (;;) {
      if (lcn << hdr.lclusterbits >= info.size) return info.size - la;
      const entry = this.loadIndex(info, hdr, lcn, true);
      if (entry.type === LCLUSTER_NONHEAD) {
        if (entry.delta1 === 0) entry.delta1 = 1; // pre-1.0 mkfs workaround (kernel does the same)
      } else if (lcn !== headLcn) {
        return ((lcn << hdr.lclusterbits) + entry.clusterofs) - la;
      } else {
        entry.delta1 = 1; // the head itself: next stop is lcn + 1
      }
      lcn += entry.delta1;
    }
  }

  /** Map one extent covering file offset `la` (kernel z_erofs_do_map_blocks). */
  private mapExtent(
    info: InodeInfo,
    hdr: MapHeader,
    la: number,
    frag: FragmentState | undefined,
  ): Extent {
    const lcb = hdr.lclusterbits;
    const lcsize = 1 << lcb;
    const initialLcn = la >> lcb;
    const endoff = la & (lcsize - 1);

    let m = this.loadIndex(info, hdr, initialLcn, false);
    let headEntry: IndexEntry;
    let headLcn: number;
    if (m.type === LCLUSTER_NONHEAD) {
      ({ entry: headEntry, headLcn } = this.extentLookback(info, hdr, initialLcn, m.delta0));
    } else if (endoff < m.clusterofs) {
      // our offset sits before this HEAD's data: the extent ends at its
      // clusterofs and belongs to the previous head (kernel sets delta[0]=1)
      ({ entry: headEntry, headLcn } = this.extentLookback(info, hdr, initialLcn, 1));
    } else {
      headEntry = m;
      headLcn = initialLcn;
    }

    const extentLa = (headLcn << lcb) | headEntry.clusterofs;
    const extent: Extent = {
      la: extentLa,
      llen: 0,
      pa: 0,
      plen: 0,
      algorithm: -1,
      plainShifted: true,
      isTailpack: false,
      isFragment: false,
      headLcn,
    };

    if (hdr.advise & ADVISE_FRAGMENT && frag && headLcn === frag.tailExtentHeadLcn) {
      extent.isFragment = true;
      extent.llen = info.size - extentLa;
      return extent;
    }

    if (hdr.advise & ADVISE_INLINE_PCLUSTER && frag && headLcn === frag.tailExtentHeadLcn) {
      extent.isTailpack = true;
      extent.llen = this.extentDecompressedLen(info, hdr, headLcn, extentLa);
      extent.pa = frag.idataOff;
      extent.plen = hdr.idataSize;
      extent.algorithm = headEntry.type === LCLUSTER_HEAD2 ? hdr.algorithmtype[1] : hdr.algorithmtype[0];
      return extent;
    }

    extent.pa = headEntry.pblk << this.sb.blkszbits;
    extent.llen = this.extentDecompressedLen(info, hdr, headLcn, extentLa);

    // kernel z_erofs_get_extent_compressedlen
    const bigForHead =
      headEntry.type === LCLUSTER_HEAD1
        ? (hdr.advise & ADVISE_BIG_PCLUSTER_1) !== 0
        : (hdr.advise & ADVISE_BIG_PCLUSTER_2) !== 0;
    const eofPcluster = ((headLcn + 1) << lcb) >= info.size;
    if (!bigForHead || eofPcluster) {
      extent.plen = this.blockSize;
    } else {
      const next = this.loadIndex(info, hdr, headLcn + 1, false);
      if (next.type !== LCLUSTER_NONHEAD || !next.compressedblks) {
        extent.plen = this.blockSize;
      } else {
        extent.plen = next.compressedblks << this.sb.blkszbits;
      }
    }

    if (headEntry.type === LCLUSTER_PLAIN) {
      extent.algorithm = -1;
      extent.plainShifted = (hdr.advise & ADVISE_INTERLACED) === 0;
      if (extent.llen > extent.plen) throw new UnsupportedImageFeatureError("plain extent exceeds block");
    } else if (headEntry.type === LCLUSTER_HEAD2) {
      extent.algorithm = hdr.algorithmtype[1];
    } else {
      extent.algorithm = hdr.algorithmtype[0];
    }
    return extent;
  }

  /** FINDTAIL pass at size-1: locate the tail extent head and inline data offset
   * (kernel z_erofs_map_blocks with EROFS_GET_BLOCKS_FINDTAIL). */
  private findTail(info: InodeInfo, hdr: MapHeader): FragmentState {
    const lcb = hdr.lclusterbits;
    const initialLcn = (info.size - 1) >> lcb;
    const endoff = (info.size - 1) & ((1 << lcb) - 1);
    const m = this.loadIndex(info, hdr, initialLcn, false);

    let headEntry: IndexEntry;
    let headLcn: number;
    if (m.type === LCLUSTER_NONHEAD) {
      ({ entry: headEntry, headLcn } = this.extentLookback(info, hdr, initialLcn, m.delta0));
    } else if (endoff < m.clusterofs) {
      // the final index entry (PLAIN/HEAD with clusterofs > EOF offset) makes
      // readers look back one lcluster to the real tail extent head
      ({ entry: headEntry, headLcn } = this.extentLookback(info, hdr, initialLcn, 1));
    } else {
      headEntry = m;
      headLcn = initialLcn;
    }
    // kernel: for non-compact indexes the fragment offset is 64 bits, with the
    // high 32 bits stored in the tail index entry's blkaddr field
    const fragmentOff =
      info.datalayout === LAYOUT_COMPRESSED_FULL
        ? (hdr.fragmentOff | 0) + headEntry.pblk * 0x100000000
        : hdr.fragmentOff | 0;
    return { tailExtentHeadLcn: headLcn, idataOff: m.nextpackoff, fragmentOff };
  }

  private decompressCluster(algorithm: number, input: Buffer, outLen: number, label: string): Buffer {
    switch (algorithm) {
      case COMPR_LZ4: {
        // INCOMPAT_LZ4_0PADDING: legacy mkfs zero-pads the HEAD of each
        // compressed cluster up to a 4-byte boundary; kernel z_erofs_fixup_insize
        // skips leading zeros (memchr_inv) before decoding.
        let start = 0;
        if (this.sb.has0Padding) {
          while (start < input.length && input[start] === 0) start++;
          if (start === input.length) {
            throw new UnsupportedImageFeatureError(`lz4: all-zero cluster input (${label})`);
          }
        }
        return lz4Decompress(input, start, input.length, outLen);
      }
      case COMPR_DEFLATE: {
        try {
          // deflate pclusters are padded with leading zero bytes (kernel
          // z_erofs_fixup_insize strips the same margin before inflating)
          let start = 0;
          while (start < input.length && input[start] === 0) start++;
          if (start >= input.length) throw new Error("all-zero deflate extent");
          const out = inflateRawSync(input.subarray(start));
          if (out.length < outLen) throw new Error(`short output ${out.length} < ${outLen}`);
          return out.subarray(0, outLen);
        } catch (error) {
          throw new UnsupportedImageFeatureError(`deflate: failed to decompress ${label}: ${String(error)}`);
        }
      }
      case COMPR_LZMA:
        throw new UnsupportedImageFeatureError("LZMA-compressed EROFS images are not supported");
      case COMPR_ZSTD:
        throw new UnsupportedImageFeatureError("ZSTD-compressed EROFS images are not supported");
      default:
        throw new UnsupportedImageFeatureError(`Unknown compression algorithm ${algorithm}`);
    }
  }

  /** Decompress the packed inode once; fragments are slices of its stream. */
  private packedStream(): Buffer {
    if (this.packedData) return this.packedData;
    if (!this.sb.packedNid) {
      throw new UnsupportedImageFeatureError("Fragment data but no packed inode in superblock");
    }
    this.packedData = this.readFileData(this.inode(this.sb.packedNid));
    return this.packedData;
  }

  private readPackedSlice(fragmentOff: number, length: number): Buffer {
    const packed = this.packedStream();
    if (fragmentOff + length > packed.length) {
      throw new UnsupportedImageFeatureError("Fragment offset outside packed inode data");
    }
    return Buffer.from(packed.subarray(fragmentOff, fragmentOff + length));
  }

  /** Read the full decompressed content of any file inode. */
  private readFileData(info: InodeInfo): Buffer {
    if (info.size === 0) return Buffer.alloc(0);

    if (
      info.datalayout === LAYOUT_FLAT_PLAIN ||
      info.datalayout === LAYOUT_FLAT_INLINE ||
      info.datalayout === LAYOUT_CHUNK_BASED
    ) {
      return this.readFlatOrChunked(info);
    }

    const hdr = this.readMapHeader(info);
    if (hdr.wholeFileFragment) {
      return this.readPackedSlice(hdr.fragmentOff, info.size);
    }

    let frag: FragmentState | undefined;
    if (hdr.advise & (ADVISE_FRAGMENT | ADVISE_INLINE_PCLUSTER)) {
      frag = this.findTail(info, hdr);
    }

    const out = Buffer.alloc(info.size);
    let la = 0;
    while (la < info.size) {
      const extent = this.mapExtent(info, hdr, la, frag);
      if (extent.llen <= 0 || extent.la + extent.llen > info.size) {
        throw new UnsupportedImageFeatureError(`Bad extent bounds (nid ${info.nid})`);
      }
      let data: Buffer;
      if (extent.isFragment) {
        data = this.readPackedSlice(frag!.fragmentOff, extent.llen);
      } else if (extent.isTailpack) {
        data = this.decompressCluster(extent.algorithm, this.readAt(extent.pa, extent.plen), extent.llen, `nid ${info.nid}`);
      } else if (extent.algorithm === -1) {
        // plain (uncompressed) pcluster: shifted or interlaced layout
        const raw = this.readAt(extent.pa, extent.plen);
        if (extent.plainShifted) {
          data = raw.subarray(0, extent.llen);
        } else {
          // interlaced: each filesystem block is rotated so that the extent's
          // data starts at (fileOffset & blockSize-1) within the block
          // (mkfs write_uncompressed_block rotates by clusterofs)
          const bs = this.blockSize;
          const parts: Buffer[] = [];
          for (let b = 0; b < extent.plen; b += bs) {
            const rot = (extent.la + b) & (bs - 1);
            const blk = raw.subarray(b, b + bs);
            parts.push(Buffer.concat([blk.subarray(rot), blk.subarray(0, rot)]));
          }
          data = Buffer.concat(parts).subarray(0, extent.llen);
        }
      } else {
        data = this.decompressCluster(extent.algorithm, this.readAt(extent.pa, extent.plen), extent.llen, `nid ${info.nid}`);
      }
      if (data.length < extent.llen) {
        throw new UnsupportedImageFeatureError(`Short decompressed extent (nid ${info.nid})`);
      }
      data.copy(out, extent.la, 0, extent.llen);
      la = extent.la + extent.llen;
    }
    return out;
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Resolve an inner path (following symlinks, max depth 10) to a nid. */
  private resolveNid(innerPath: string, depth = 0): number {
    if (depth > 10) throw new UnsupportedImageFeatureError("Symlink chain too deep");
    const segments = innerPath.split("/").filter((segment) => segment && segment !== ".");
    let nid = this.sb.rootNid;
    for (let i = 0; i < segments.length; i += 1) {
      const entry = this.listDirEntriesOfInode(this.inode(nid)).find((candidate) => candidate.name === segments[i]);
      if (!entry) throw new UnsupportedImageFeatureError(`No such entry: ${innerPath}`);
      const info = this.inode(entry.nid);
      if (this.inodeKind(info) === "symlink") {
        const target = this.readSymlinkTarget(info);
        const basePath = target.startsWith("/") ? "" : segments.slice(0, i).join("/");
        const remaining = segments.slice(i + 1).join("/");
        const combined = [basePath, target.replace(/^\/+/, ""), remaining].filter(Boolean).join("/");
        return this.resolveNid(combined, depth + 1);
      }
      nid = entry.nid;
    }
    return nid;
  }

  private readSymlinkTarget(info: InodeInfo): string {
    const raw = this.readFileData(info);
    const nul = raw.indexOf(0);
    return (nul >= 0 ? raw.subarray(0, nul) : raw).toString("utf8");
  }

  /** Directory entries of an inner directory path (symlinks followed). */
  listDir(innerPath: string): ErofsDirEntry[] {
    const nid = this.resolveNid(innerPath);
    const info = this.inode(nid);
    if (this.inodeKind(info) !== "dir") {
      throw new UnsupportedImageFeatureError(`${innerPath} is not a directory`);
    }
    return this.listDirEntriesOfInode(info);
  }

  /** Content of a regular file at an inner path (symlinks followed). */
  readFile(innerPath: string): Buffer {
    const nid = this.resolveNid(innerPath);
    const info = this.inode(nid);
    if (this.inodeKind(info) !== "file") {
      throw new UnsupportedImageFeatureError(`${innerPath} is not a regular file`);
    }
    return this.readFileData(info);
  }

  /**
   * `shouldExtract` into outDir, preserving inner paths. Returns the
   * extracted relative paths. Mirrors Ext4Image.extractTo.
   */
  extractTo(outDir: string, shouldExtract: (relativePath: string) => boolean): string[] {
    const extracted: string[] = [];
    const visitedDirs = new Set<number>();
    const walk = (nid: number, prefix: string, depth: number): void => {
      if (depth > 32 || visitedDirs.has(nid)) return;
      visitedDirs.add(nid);
      for (const entry of this.listDirEntriesOfInode(this.inode(nid))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const child = this.inode(entry.nid);
        const kind = this.inodeKind(child);
        if (kind === "dir") {
          walk(entry.nid, relative, depth + 1);
          continue;
        }
        if (kind !== "file") continue; // symlinks, devices: skip
        if (!shouldExtract(relative)) continue;
        const target = path.join(outDir, ...relative.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, this.readFileData(child));
        extracted.push(relative);
      }
    };
    walk(this.sb.rootNid, "", 0);
    return extracted;
  }
}

function direntKind(fileType: number): ErofsDirEntry["kind"] {
  switch (fileType) {
    case DIRENT_FT_REG:
      return "file";
    case DIRENT_FT_DIR:
      return "dir";
    case DIRENT_FT_LNK:
      return "symlink";
    default:
      return "file";
  }
}

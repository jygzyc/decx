//! Minimal read-only EROFS image reader for APEX payload images.
//!
//! Pure-std implementation of the EROFS on-disk format (kernel
//! `fs/erofs/erofs_fs.h`; decoding logic ported from `fs/erofs/zmap.c`,
//! `dir.c`, `data.c`, `decompressor.c`): superblock -> inode
//! (compact/extended) -> dirent walk -> file reads, covering exactly the
//! layouts `apexer`/`mkfs.erofs` produce for APEX payloads:
//!
//! - datalayout 0 (flat plain), 2 (flat inline tail), 3 (compressed compact
//!   indexes) with LZ4 compression, big pclusters, `fragments` + dedupe
//!   (packed inode) and `ztailpacking` (inline compressed tails);
//! - PLAIN lclusters inside compressed inodes (SHIFTED raw storage).
//!
//! Multi-device / metabox / 48-bit / chunked / LZMA-deflate-zstd / interlaced
//! layouts are not produced for APEX payloads and return
//! [`ErofsError::Unsupported`]; extraction is native only and never shells
//! out to external tools.
//!
//! LZ4 pclusters are self-contained LZ4 blocks (the kernel decodes each
//! pcluster with a single `LZ4_decompress_safe` call, no dictionary), so a
//! plain block decoder is sufficient.

use std::cell::RefCell;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::rc::Rc;

const EROFS_MAGIC: [u8; 4] = [0xe2, 0xe1, 0xf5, 0xe0];
const SUPERBLOCK_OFFSET: u64 = 1024;
const MAX_SYMLINK_DEPTH: u32 = 10;

// i_format datalayouts
const DL_FLAT_PLAIN: u8 = 0;
const DL_COMPRESSED_FULL: u8 = 1;
const DL_FLAT_INLINE: u8 = 2;
const DL_COMPRESSED_COMPACT: u8 = 3;
const DL_CHUNK_BASED: u8 = 4;

// superblock feature_incompat bits
const INCOMPAT_LZ4_0PADDING: u32 = 0x1;
const INCOMPAT_BIG_PCLUSTER: u32 = 0x2; // == COMPR_CFGS
const INCOMPAT_CHUNKED_FILE: u32 = 0x4;
const INCOMPAT_COMPR_HEAD2_OR_DEVICE: u32 = 0x8;
const INCOMPAT_ZTAILPACKING: u32 = 0x10;
const INCOMPAT_FRAGMENTS: u32 = 0x20; // == DEDUPE
const INCOMPAT_XATTR_PREFIXES: u32 = 0x40;
const INCOMPAT_48BIT: u32 = 0x80;
const INCOMPAT_METABOX: u32 = 0x100;
const INCOMPAT_SUPPORTED: u32 =
    INCOMPAT_LZ4_0PADDING | INCOMPAT_BIG_PCLUSTER | INCOMPAT_ZTAILPACKING | INCOMPAT_FRAGMENTS;

// z map header advise bits
const ADVISE_COMPACTED_2B: u16 = 0x1;
const ADVISE_BIG_PCLUSTER_1: u16 = 0x2;
const ADVISE_BIG_PCLUSTER_2: u16 = 0x4;
const ADVISE_INLINE_PCLUSTER: u16 = 0x8;
const ADVISE_INTERLACED_PCLUSTER: u16 = 0x10;
const ADVISE_FRAGMENT_PCLUSTER: u16 = 0x20;

// lcluster types
const LCT_PLAIN: u8 = 0;
const LCT_HEAD1: u8 = 1;
const LCT_NONHEAD: u8 = 2;
const LCT_HEAD2: u8 = 3;

const LI_D0_CBLKCNT: u32 = 1 << 11;

const MODE_FMT_MASK: u16 = 0xf000;
const MODE_REG: u16 = 0x8000;
const MODE_DIR: u16 = 0x4000;
const MODE_LNK: u16 = 0xa000;

const DIRENT_SIZE: usize = 12;
const DIRENT_FT_REG: u8 = 1;
const DIRENT_FT_DIR: u8 = 2;
const DIRENT_FT_LNK: u8 = 7;

const NULL_ADDR: u64 = u32::MAX as u64; // 48-bit -1 hole marker

/// Error taxonomy mirroring [`crate::android_sdk::ext4::Ext4Error`].
#[derive(Debug)]
pub enum ErofsError {
    NotErofsImage,
    Unsupported(String),
    Io(String),
    BadImage(String),
}

impl std::fmt::Display for ErofsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ErofsError::NotErofsImage => write!(f, "not an erofs image"),
            ErofsError::Unsupported(what) => write!(f, "unsupported image feature: {what}"),
            ErofsError::Io(err) => write!(f, "io error: {err}"),
            ErofsError::BadImage(why) => write!(f, "malformed image: {why}"),
        }
    }
}

impl std::error::Error for ErofsError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErofsNodeKind {
    File,
    Dir,
    Symlink,
}

#[derive(Debug)]
pub struct ErofsDirEntry {
    pub name: String,
    pub nid: u64,
    pub kind: ErofsNodeKind,
}

struct Super {
    block_size: u64,
    blkszbits: u8,
    meta_base: u64, // meta_blkaddr * block_size
    root_nid: u64,
    // dirblk_size (sb[90]) is parsed for validation only; directory blocks
    // are walked via inode sizes, so it is not retained on the struct.
    packed_nid: u64,
}

struct Inode {
    nid: u64,
    iloc: u64,
    inode_isize: usize,
    xattr_isize: usize,
    mode: u16,
    size: u64,
    datalayout: u8,
    /// FLAT_*: start block; COMPRESSED compact: total lcluster index count.
    startblk_or_blocks: u64,
}

/// Parsed z_erofs_map_header + FINDTAIL results of one compressed inode.
struct ZInfo {
    advise: u16,
    lclusterbits: u32,
    fragmentoff: u64,
    idata_size: usize,
    /// Highest map-header bit: the whole file lives in the packed inode at
    /// `fragmentoff` (as an offset into the packed file's data).
    whole_packed: bool,
    /// Byte offset of the compact lcluster indexes (map header end).
    ebase: u64,
    /// false => COMPRESSED_FULL (8-byte legacy index records at ebase+8).
    compact: bool,
    totalidx: u64,
    /// Head lcn of the EOF tail extent (u64::MAX = none / not computed).
    tailextent_headlcn: u64,
}

/// One decoded lcluster index (kernel `z_erofs_maprecorder` subset).
#[derive(Clone)]
struct Lcl {
    lcn: u64,
    ltype: u8,
    clusterofs: u16,
    delta0: u32,
    delta1: u32,
    compressedblks: Option<u32>,
    pblk: Option<u64>,
    nextpackoff: u64,
}

/// Port of kernel `struct z_erofs_map_blocks` + head record.
#[derive(Default, Clone)]
struct MapResult {
    /// false => hole (zeros)
    mapped: bool,
    meta: bool,     // ztailpacking: m_pa is an absolute image offset
    fragment: bool, // packed-inode fragment
    m_la: u64,
    m_pa: u64,
    m_plen: u64,
    llen: u64,
    headtype: u8,
    algfmt: u8, // 0=lz4, 0xff=SHIFTED raw, 0xfe=INTERLACED (rejected later)
    tail_lcn: u64,
    nextpackoff: u64,
}

pub struct ErofsImage {
    file: fs::File,
    sb: Super,
    packed_cache: RefCell<Option<Rc<Vec<u8>>>>,
    packed_reading: RefCell<bool>,
}

impl ErofsImage {
    pub fn open(path: &str) -> Result<ErofsImage, ErofsError> {
        let mut file = fs::File::open(path).map_err(|e| ErofsError::Io(e.to_string()))?;
        let mut sb = vec![0u8; 128];
        file.seek(SeekFrom::Start(SUPERBLOCK_OFFSET))
            .map_err(|e| ErofsError::Io(e.to_string()))?;
        read_exact_or_not_image(&mut file, &mut sb)?;
        if sb[0..4] != EROFS_MAGIC {
            return Err(ErofsError::NotErofsImage);
        }
        let blkszbits = sb[12];
        if !(9..=16).contains(&blkszbits) {
            return Err(ErofsError::BadImage(format!(
                "invalid blkszbits {blkszbits}"
            )));
        }
        let block_size = 1u64 << blkszbits;
        let feature_incompat = u32le(&sb, 80);
        for (bit, what) in [
            (INCOMPAT_CHUNKED_FILE, "chunked files"),
            (INCOMPAT_COMPR_HEAD2_OR_DEVICE, "device table / compr-head2"),
            (INCOMPAT_XATTR_PREFIXES, "xattr prefixes"),
            (INCOMPAT_48BIT, "48-bit block addresses"),
            (INCOMPAT_METABOX, "metabox"),
        ] {
            if feature_incompat & bit != 0 {
                return Err(ErofsError::Unsupported(what.to_string()));
            }
        }
        let unknown = feature_incompat & !INCOMPAT_SUPPORTED;
        if unknown != 0 {
            return Err(ErofsError::Unsupported(format!(
                "unknown incompat feature bits 0x{unknown:x}"
            )));
        }
        let meta_blkaddr = u32le(&sb, 40) as u64;
        // meta_blkaddr == 0 is valid: apexer-style images put the inode
        // table right after the 128-byte superblock inside block 0
        // (iloc = nid * 32 starts at byte 1152).
        Ok(ErofsImage {
            file,
            sb: Super {
                block_size,
                blkszbits,
                meta_base: meta_blkaddr * block_size,
                root_nid: u16le(&sb, 14) as u64,
                packed_nid: u64le(&sb, 96),
            },
            packed_cache: RefCell::new(None),
            packed_reading: RefCell::new(false),
        })
    }

    pub fn close(self) {}

    pub fn list_dir(&self, inner_path: &str) -> Result<Vec<ErofsDirEntry>, ErofsError> {
        let nid = self.resolve_nid(inner_path, 0)?;
        let inode = self.inode(nid)?;
        if inode.mode & MODE_FMT_MASK != MODE_DIR {
            return Err(ErofsError::BadImage(format!(
                "{inner_path} is not a directory"
            )));
        }
        self.list_dir_entries_of_inode(&inode)
    }

    pub fn read_file(&self, inner_path: &str) -> Result<Vec<u8>, ErofsError> {
        self.read_file_inner(inner_path, 0)
    }

    /// Walk the tree from `/` and extract regular files for which
    /// `filter(relative_path)` holds into `dir`, preserving inner paths.
    pub fn extract_to(&self, dir: &str, filter: &dyn Fn(&str) -> bool) -> Result<(), ErofsError> {
        let mut visited: HashSet<u64> = HashSet::new();
        self.walk_for_extract(self.sb.root_nid, "", 0, dir, filter, &mut visited)
    }

    // 鈹€鈹€ low-level IO 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    fn read_at(&self, pos: u64, len: usize) -> Result<Vec<u8>, ErofsError> {
        let mut buf = vec![0u8; len];
        let mut file = &self.file;
        file.seek(SeekFrom::Start(pos))
            .map_err(|e| ErofsError::Io(e.to_string()))?;
        let mut total = 0usize;
        while total < len {
            let n = file
                .read(&mut buf[total..])
                .map_err(|e| ErofsError::Io(e.to_string()))?;
            if n == 0 {
                return Err(ErofsError::BadImage(format!(
                    "unexpected EOF at {}",
                    pos + total as u64
                )));
            }
            total += n;
        }
        Ok(buf)
    }

    // 鈹€鈹€ inodes 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    fn inode(&self, nid: u64) -> Result<Inode, ErofsError> {
        if nid > (u32::MAX >> 2) as u64 {
            return Err(ErofsError::BadImage(format!("implausible nid {nid}")));
        }
        let iloc = self.sb.meta_base + nid * 32;
        let head = self.read_at(iloc, 32)?;
        let ifmt = u16le(&head, 0);
        let version = ifmt & 1;
        let datalayout = ((ifmt >> 1) & 7) as u8;
        // On-disk inode (v1.7/6.6 layout): compact 32B with u32 i_size@8,
        // extended 64B with u64 i_size@8; i_u @16 in BOTH 鈥攃ompressed
        // total blocks, flat startblk, or chunk info depending on layout.
        let (inode_isize, size, i_u): (usize, u64, u64) = if version == 0 {
            (32, u32le(&head, 8) as u64, u32le(&head, 16) as u64)
        } else {
            (64, u64le(&head, 8), u32le(&head, 16) as u64)
        };
        let xattr_icount = u16le(&head, 2);
        let xattr_isize = if xattr_icount == 0 {
            0
        } else {
            12 + 4 * (xattr_icount as usize - 1)
        };
        let mode = u16le(&head, 4);
        Ok(Inode {
            nid,
            iloc,
            inode_isize,
            xattr_isize,
            mode,
            size,
            datalayout,
            startblk_or_blocks: i_u,
        })
    }

    // 鈹€鈹€ directories 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    fn list_dir_entries_of_inode(&self, dir: &Inode) -> Result<Vec<ErofsDirEntry>, ErofsError> {
        if dir.mode & MODE_FMT_MASK != MODE_DIR {
            return Err(ErofsError::BadImage(format!(
                "nid {} is not a directory",
                dir.nid
            )));
        }
        let mut entries = Vec::new();
        let bs = self.sb.block_size;
        // FLAT_INLINE dirs keep full blocks on disk and the final partial
        // block inline right after the inode + xattrs (erofs dir.c: the
        // inline tail covers `size - nblk * bs` bytes).
        let inline_tail = dir.datalayout == DL_FLAT_INLINE;
        let nblk = if inline_tail {
            dir.size / bs
        } else {
            dir.size.div_ceil(bs)
        };
        let mut pos = 0u64;
        while pos < dir.size {
            let lblock = pos / bs;
            let (data, maxsize): (Vec<u8>, usize) = if lblock < nblk {
                let len = (dir.size - pos).min(bs) as usize;
                (
                    self.read_at(dir.startblk_or_blocks * bs + lblock * bs, len)?,
                    len,
                )
            } else {
                let ipos = dir.iloc + dir.inode_isize as u64 + dir.xattr_isize as u64;
                let len = (dir.size - pos) as usize;
                (self.read_at(ipos, len)?, len)
            };
            if data.len() < DIRENT_SIZE {
                return Err(ErofsError::BadImage(format!(
                    "dirent block in nid {} is {} bytes, below the {DIRENT_SIZE} byte dirent size",
                    dir.nid,
                    data.len()
                )));
            }
            let nameoff0 = u16le(&data, 8) as usize;
            if nameoff0 == 0 || nameoff0 > maxsize || !nameoff0.is_multiple_of(DIRENT_SIZE) {
                return Err(ErofsError::BadImage(format!(
                    "bogus dirent block in nid {} (nameoff0={nameoff0})",
                    dir.nid
                )));
            }
            let count = nameoff0 / DIRENT_SIZE;
            for i in 0..count {
                let at = i * DIRENT_SIZE;
                let nid = u64le(&data, at);
                let nameoff = u16le(&data, at + 8) as usize;
                if nameoff < DIRENT_SIZE || nameoff >= maxsize {
                    return Err(ErofsError::BadImage(format!(
                        "bogus dirent nameoff {nameoff} in nid {}",
                        dir.nid
                    )));
                }
                // kernel: last dirent name = strnlen(name, maxsize - nameoff)
                let name = if i + 1 < count {
                    let next = u16le(&data, at + DIRENT_SIZE + 8) as usize;
                    if next < nameoff || next > maxsize {
                        return Err(ErofsError::BadImage(format!(
                            "bogus dirent name span in nid {}",
                            dir.nid
                        )));
                    }
                    &data[nameoff..next]
                } else {
                    let slice = &data[nameoff..maxsize];
                    match slice.iter().position(|&b| b == 0) {
                        Some(nul) => &slice[..nul],
                        None => slice,
                    }
                };
                if name.is_empty() {
                    continue;
                }
                entries.push(ErofsDirEntry {
                    name: String::from_utf8_lossy(name).into_owned(),
                    nid,
                    kind: dirent_kind(data[at + 10]).unwrap_or(ErofsNodeKind::File),
                });
            }
            pos += maxsize as u64;
        }
        Ok(entries)
    }

    fn resolve_nid(&self, inner_path: &str, depth: u32) -> Result<u64, ErofsError> {
        if depth > MAX_SYMLINK_DEPTH {
            return Err(ErofsError::BadImage("symlink chain too deep".into()));
        }
        let segments: Vec<&str> = inner_path
            .split('/')
            .filter(|s| !s.is_empty() && *s != ".")
            .collect();
        let mut nid = self.sb.root_nid;
        for i in 0..segments.len() {
            let entry = self
                .list_dir_entries_of_inode(&self.inode(nid)?)?
                .into_iter()
                .find(|candidate| candidate.name == segments[i]);
            let Some(entry) = entry else {
                return Err(ErofsError::BadImage(format!("no such entry: {inner_path}")));
            };
            if entry.kind == ErofsNodeKind::Symlink {
                let link = self.read_symlink(&self.inode(entry.nid)?)?;
                let base_path = if link.starts_with('/') {
                    String::new()
                } else {
                    segments[..i].join("/")
                };
                let remaining = segments[i + 1..].join("/");
                let combined = [base_path, link, remaining]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<String>>()
                    .join("/");
                return self.resolve_nid(&combined, depth + 1);
            }
            nid = entry.nid;
        }
        Ok(nid)
    }

    // 鈹€鈹€ symlinks & flat files 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    fn read_symlink(&self, inode: &Inode) -> Result<String, ErofsError> {
        let data = self.read_flat(inode)?;
        Ok(String::from_utf8_lossy(&data).into_owned())
    }

    /// Flat datalayouts (0 plain, 2 inline tail). Holes stay zero.
    fn read_flat(&self, inode: &Inode) -> Result<Vec<u8>, ErofsError> {
        let bs = self.sb.block_size;
        let size = inode.size;
        let mut out = alloc_zeroed(size, "flat file")?;
        let is_hole = inode.datalayout == DL_FLAT_PLAIN && inode.startblk_or_blocks == NULL_ADDR;
        if is_hole || size == 0 {
            return Ok(out);
        }
        let blocks = size.div_ceil(bs);
        let full_len = if inode.datalayout == DL_FLAT_INLINE {
            (blocks - 1) * bs
        } else {
            size
        };
        if full_len > 0 {
            let chunk = self.read_at(inode.startblk_or_blocks * bs, full_len as usize)?;
            out[..full_len as usize].copy_from_slice(&chunk);
        }
        if inode.datalayout == DL_FLAT_INLINE && size > full_len {
            // Tail bytes live inline right after the inode + xattrs.
            let pos = inode.iloc + inode.inode_isize as u64 + inode.xattr_isize as u64;
            let tail = self.read_at(pos, (size - full_len) as usize)?;
            out[full_len as usize..].copy_from_slice(&tail);
        }
        Ok(out)
    }

    // 鈹€鈹€ compressed files 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    /// Parse the z map header; runs the FINDTAIL pass for fragment /
    /// ztailpacked inodes (kernel `z_erofs_fill_inode_lazy`).
    fn load_zinfo(&self, inode: &Inode) -> Result<ZInfo, ErofsError> {
        let hdr_pos = inode.iloc + inode.inode_isize as u64 + inode.xattr_isize as u64;
        let hdr_pos = hdr_pos.div_ceil(8) * 8; // ALIGN(pos, 8)
        let h = self.read_at(hdr_pos, 8)?;
        let ebase = hdr_pos + 8;
        let base = ZInfo {
            advise: 0,
            lclusterbits: self.sb.blkszbits as u32,
            fragmentoff: 0,
            idata_size: 0,
            whole_packed: false,
            ebase,
            compact: inode.datalayout == DL_COMPRESSED_COMPACT,
            totalidx: 0,
            tailextent_headlcn: u64::MAX,
        };
        if h[7] & 0x80 != 0 {
            // Whole file packed into the packed inode.
            return Ok(ZInfo {
                advise: ADVISE_FRAGMENT_PCLUSTER,
                fragmentoff: u64le(&h, 0) ^ (1u64 << 63),
                tailextent_headlcn: 0,
                ..base
            });
        }
        let advise = u16le(&h, 4);
        let lclusterbits = self.sb.blkszbits as u32 + (h[7] & 7) as u32;
        // totalidx = erofs_iblks() = ceil(i_size / logical cluster size).
        let totalidx = inode.size.div_ceil(1u64 << lclusterbits);
        for fmt in [h[6] & 15, (h[6] >> 4) & 15] {
            if fmt != 0 {
                return Err(ErofsError::Unsupported(format!(
                    "compression algorithm {fmt} (only LZ4 is supported)"
                )));
            }
        }
        let fragmentoff = if advise & ADVISE_FRAGMENT_PCLUSTER != 0 {
            u32le(&h, 0) as u64
        } else {
            0
        };
        let idata_size = if advise & ADVISE_INLINE_PCLUSTER != 0 {
            u16le(&h, 2) as usize
        } else {
            0
        };
        let mut z = ZInfo {
            advise,
            lclusterbits,
            fragmentoff,
            idata_size,
            totalidx,
            ..base
        };
        if inode.size > 0 && (advise & ADVISE_FRAGMENT_PCLUSTER != 0 || idata_size > 0) {
            // FINDTAIL: map the last byte once to locate the EOF tail extent.
            let mut m = MapResult::default();
            let mut head = placeholder_lcl();
            self.map_blocks_fo(inode, &z, inode.size - 1, true, &mut m, &mut head)?;
            z.tailextent_headlcn = m.tail_lcn;
            if idata_size > 0 {
                // ztailpacked inline data sits at the last index-pack position.
                z.fragmentoff = m.nextpackoff;
            }
        }
        Ok(z)
    }

    /// Port of kernel `z_erofs_load_compact_lcluster`.
    fn load_lcluster(
        &self,
        inode: &Inode,
        z: &ZInfo,
        lcn: u64,
        lookahead: bool,
    ) -> Result<Lcl, ErofsError> {
        let _ = inode;
        if !z.compact {
            return self.load_full_lcluster(z, lcn);
        }
        if lcn >= z.totalidx || z.lclusterbits > 14 {
            return Err(ErofsError::BadImage(format!("bad lcluster index {lcn}")));
        }
        let big_pcluster = z.advise & ADVISE_BIG_PCLUSTER_1 != 0;
        let compacted_4b_initial = ((32 - (z.ebase % 32)) / 4) & 7;
        let mut compacted_2b = 0u64;
        if z.advise & ADVISE_COMPACTED_2B != 0 && compacted_4b_initial < z.totalidx {
            compacted_2b = (z.totalidx - compacted_4b_initial) / 16 * 16;
        }
        let mut pos = z.ebase;
        let mut lcn = lcn;
        let orig_lcn = lcn; // Lcl.lcn must keep the ORIGINAL logical number
        let mut shift = 2u64; // 4-byte units
        if lcn >= compacted_4b_initial {
            pos += compacted_4b_initial * 4;
            lcn -= compacted_4b_initial;
            if lcn < compacted_2b {
                shift = 1;
            } else {
                pos += compacted_2b * 2;
                lcn -= compacted_2b;
            }
        }
        pos += lcn << shift;
        let (vcnt, packsize) = if shift == 2 {
            (2usize, 8usize)
        } else {
            if z.lclusterbits > 12 {
                return Err(ErofsError::BadImage(
                    "lclusterbits > 12 with 2B packs".into(),
                ));
            }
            (16usize, 32usize)
        };
        let pack_start = pos - pos % packsize as u64;
        let bytes_in = (pos - pack_start) as usize;
        let i0 = (bytes_in >> shift) as i64;
        // pack + trailing u32 base blkaddr
        let raw = self.read_at(pack_start, packsize + 4)?;
        let lobits = z.lclusterbits;
        let encodebits = ((packsize - 4) * 8 / vcnt) as u32;

        let decode = |idx: i64| -> (u32, u8) {
            let bitpos = encodebits as i64 * idx;
            let byte = (bitpos as usize) / 8;
            let v = u32le(&raw, byte) >> ((bitpos % 8) as u32 & 7);
            (v & ((1u32 << lobits) - 1), ((v >> lobits) & 3) as u8)
        };

        let (lo, ltype) = decode(i0);
        let nextpackoff = pack_start + packsize as u64;
        if ltype == LCT_NONHEAD {
            let mut out = Lcl {
                lcn: orig_lcn,
                ltype,
                clusterofs: 1u16 << z.lclusterbits.min(14),
                delta0: 0,
                delta1: 0,
                compressedblks: None,
                pblk: None,
                nextpackoff,
            };
            if lookahead {
                out.delta1 = compacted_la_distance(&decode, vcnt, i0);
            }
            if lo & LI_D0_CBLKCNT != 0 {
                if !big_pcluster {
                    return Err(ErofsError::BadImage("CBLKCNT without big pcluster".into()));
                }
                out.compressedblks = Some(lo & !LI_D0_CBLKCNT);
                out.delta0 = 1;
            } else if i0 + 1 != vcnt as i64 {
                out.delta0 = lo;
            } else {
                // Last lcluster of the pack: lo holds delta[1]; recover
                // delta[0] from the previous index.
                let (lo_prev, t_prev) = decode(i0 - 1);
                let recovered = if t_prev != LCT_NONHEAD {
                    0
                } else if lo_prev & LI_D0_CBLKCNT != 0 {
                    1
                } else {
                    lo_prev
                };
                out.delta0 = recovered + 1;
            }
            return Ok(out);
        }
        // HEAD / PLAIN: count preceding heads in this pack for pblk.
        let nblk: i64 = if !big_pcluster {
            let mut nblk = 1i64;
            let mut i = i0;
            while i > 0 {
                i -= 1;
                let (lo2, t2) = decode(i);
                if t2 == LCT_NONHEAD {
                    i -= lo2 as i64;
                }
                if i >= 0 {
                    nblk += 1;
                }
            }
            nblk
        } else {
            let mut nblk = 0i64;
            let mut i = i0;
            while i > 0 {
                i -= 1;
                let (lo2, t2) = decode(i);
                if t2 == LCT_NONHEAD {
                    if lo2 & LI_D0_CBLKCNT != 0 {
                        i -= 1;
                        nblk += (lo2 & !LI_D0_CBLKCNT) as i64;
                        continue;
                    }
                    if lo2 <= 1 {
                        return Err(ErofsError::BadImage("big pcluster d0 <= 1".into()));
                    }
                    i -= lo2 as i64 - 2;
                    continue;
                }
                nblk += 1;
            }
            nblk
        };
        Ok(Lcl {
            lcn: orig_lcn,
            ltype,
            clusterofs: lo as u16,
            delta0: 0,
            delta1: 0,
            compressedblks: None,
            pblk: Some(u32le(&raw, packsize - 4) as u64 + nblk as u64),
            nextpackoff,
        })
    }

    /// Kernel `z_erofs_load_full_lcluster`: COMPRESSED_FULL inodes keep
    /// plain 8-byte index records at Z_EROFS_FULL_INDEX_ALIGN(...) = ebase+8.
    fn load_full_lcluster(&self, z: &ZInfo, lcn: u64) -> Result<Lcl, ErofsError> {
        if lcn >= z.totalidx {
            return Err(ErofsError::BadImage(format!("bad lcluster index {lcn}")));
        }
        let pos = z.ebase + 8 + lcn * 8;
        let raw = self.read_at(pos, 8)?;
        let advise = u16le(&raw, 0);
        let ltype = (advise & 3) as u8;
        let nextpackoff = pos + 8;
        if ltype == LCT_NONHEAD {
            let d0 = u16le(&raw, 4) as u32;
            let delta1 = u16le(&raw, 6) as u32;
            let (delta0, compressedblks) = if d0 & LI_D0_CBLKCNT != 0 {
                if z.advise & (ADVISE_BIG_PCLUSTER_1 | ADVISE_BIG_PCLUSTER_2) == 0 {
                    return Err(ErofsError::BadImage("CBLKCNT without big pcluster".into()));
                }
                (1, Some(d0 & !LI_D0_CBLKCNT))
            } else {
                (d0, None)
            };
            return Ok(Lcl {
                lcn,
                ltype,
                clusterofs: 1u16 << z.lclusterbits.min(14),
                delta0,
                delta1,
                compressedblks,
                pblk: None,
                nextpackoff,
            });
        }
        let clusterofs = u16le(&raw, 2);
        if clusterofs as u64 >= 1u64 << z.lclusterbits {
            return Err(ErofsError::BadImage(format!("bad clusterofs {clusterofs}")));
        }
        Ok(Lcl {
            lcn,
            ltype,
            clusterofs,
            delta0: 0,
            delta1: 0,
            compressedblks: None,
            pblk: Some(u32le(&raw, 4) as u64),
            nextpackoff,
        })
    }

    /// Kernel `z_erofs_extent_lookback` 鈥攔eturns (head Lcl, headtype, m_la).
    fn extent_lookback(
        &self,
        inode: &Inode,
        z: &ZInfo,
        mut m: Lcl,
        mut lookback: u32,
    ) -> Result<(Lcl, u8, u64), ErofsError> {
        while m.lcn >= lookback as u64 && lookback != 0 {
            let lcn = m.lcn - lookback as u64;
            m = self.load_lcluster(inode, z, lcn, false)?;
            if m.ltype == LCT_NONHEAD {
                lookback = m.delta0;
                continue;
            }
            let headtype = m.ltype;
            let m_la = (lcn << z.lclusterbits) | m.clusterofs as u64;
            return Ok((m, headtype, m_la));
        }
        Err(ErofsError::BadImage(format!(
            "bogus lookback distance {lookback} @ lcn {}",
            m.lcn
        )))
    }

    /// Kernel `z_erofs_get_extent_compressedlen` 鈥攔eturns m_plen in BYTES.
    fn extent_compressedlen(
        &self,
        inode: &Inode,
        z: &ZInfo,
        head: &Lcl,
        headtype: u8,
    ) -> Result<u64, ErofsError> {
        let bigpcl1 = z.advise & ADVISE_BIG_PCLUSTER_1 != 0;
        let bigpcl2 = z.advise & ADVISE_BIG_PCLUSTER_2 != 0;
        // PLAIN, or a HEAD type without its big-pcluster advise bit: the
        // pcluster spans exactly one logical cluster.
        if headtype == LCT_PLAIN
            || (headtype == LCT_HEAD1 && !bigpcl1)
            || (headtype == LCT_HEAD2 && !bigpcl2)
        {
            return Ok(1u64 << z.lclusterbits);
        }
        if let Some(b) = head.compressedblks {
            return Ok(b as u64 * self.sb.block_size);
        }
        let lcn2 = head.lcn + 1;
        if (lcn2 << z.lclusterbits) >= inode.size {
            return Ok(1u64 << z.lclusterbits);
        }
        let next = self.load_lcluster(inode, z, lcn2, false)?;
        if next.ltype != LCT_NONHEAD {
            // Next lcluster is already a new head: one-lcluster pcluster.
            return Ok(1u64 << z.lclusterbits);
        }
        let Some(compressed_blocks) = next.compressedblks else {
            return Err(ErofsError::BadImage("bogus CBLKCNT".into()));
        };
        if next.delta0 != 1 {
            return Err(ErofsError::BadImage("bogus CBLKCNT".into()));
        }
        Ok(u64::from(compressed_blocks) * self.sb.block_size)
    }

    /// Kernel `z_erofs_get_extent_decompressedlen` for a head extent.
    fn extent_decompressedlen(
        &self,
        inode: &Inode,
        z: &ZInfo,
        head: &Lcl,
        m_la: u64,
    ) -> Result<u64, ErofsError> {
        let mut lcn = head.lcn;
        let headlcn_ext = m_la >> z.lclusterbits;
        // kernel reads m->clusterofs from the record the walk STOPS at
        // (the next head lcluster), not from the extent's own head.
        let mut stop_clusterofs;
        loop {
            if (lcn << z.lclusterbits) >= inode.size {
                return Ok(inode.size - m_la);
            }
            let m = self.load_lcluster(inode, z, lcn, true)?;
            stop_clusterofs = m.clusterofs as u64;
            if m.ltype == LCT_NONHEAD {
                // pre-1.0 mkfs workaround for delta[1] == 0
                let d1 = if m.delta1 == 0 { 1 } else { m.delta1 as u64 };
                lcn += d1;
            } else {
                if lcn != headlcn_ext {
                    break;
                }
                lcn += 1;
            }
        }
        Ok((lcn << z.lclusterbits) + stop_clusterofs - m_la)
    }

    /// Kernel `z_erofs_map_blocks_fo` (read path). `find_tail` runs the
    /// FINDTAIL pass (records the tail head lcn in `m.tail_lcn` and the last
    /// index-pack position in `m.nextpackoff`).
    fn map_blocks_fo(
        &self,
        inode: &Inode,
        z: &ZInfo,
        la: u64,
        find_tail: bool,
        m: &mut MapResult,
        head_out: &mut Lcl,
    ) -> Result<(), ErofsError> {
        let lcb = z.lclusterbits;
        let lcsz = 1u64 << lcb;
        let fragment = z.advise & ADVISE_FRAGMENT_PCLUSTER != 0;
        let ztail = z.idata_size > 0;
        let ofs = if find_tail { inode.size - 1 } else { la };

        if fragment && !find_tail && z.tailextent_headlcn == 0 {
            // Whole file is a fragment of the packed inode.
            *m = MapResult {
                mapped: true,
                meta: false,
                fragment: true,
                m_la: 0,
                m_pa: z.fragmentoff,
                m_plen: 0,
                llen: inode.size,
                headtype: LCT_HEAD1,
                algfmt: 0,
                tail_lcn: 0,
                nextpackoff: 0,
            };
            return Ok(());
        }

        let initial_lcn = ofs >> lcb;
        let endoff = (ofs & (lcsz - 1)) as u32;
        let mut cur = self.load_lcluster(inode, z, initial_lcn, false)?;
        m.nextpackoff = cur.nextpackoff;

        let mut end = (cur.lcn + 1) << lcb;
        let headtype: u8;
        let m_la: u64;
        if cur.ltype != LCT_NONHEAD && endoff >= cur.clusterofs as u32 {
            headtype = cur.ltype;
            m_la = (cur.lcn << lcb) | cur.clusterofs as u64;
            if ztail && end > inode.size {
                end = inode.size;
            }
        } else {
            let delta0 = if cur.ltype == LCT_NONHEAD {
                cur.delta0
            } else {
                1
            };
            let (head, ht, la2) = self.extent_lookback(inode, z, cur, delta0.max(1))?;
            cur = head;
            headtype = ht;
            m_la = la2;
            if ztail && end > inode.size {
                end = inode.size;
            }
        }
        m.llen = end.saturating_sub(m_la);
        m.m_la = m_la;
        m.headtype = headtype;
        m.tail_lcn = cur.lcn;
        *head_out = cur.clone();

        if find_tail {
            return Ok(()); // caller reads m.tail_lcn / m.nextpackoff
        }
        if ztail && cur.lcn == z.tailextent_headlcn {
            m.meta = true;
            m.mapped = true;
            m.m_pa = z.fragmentoff;
            m.m_plen = z.idata_size as u64;
            m.algfmt = 0;
            return Ok(());
        }
        if fragment && cur.lcn == z.tailextent_headlcn {
            m.fragment = true;
            m.mapped = true;
            m.m_pa = z.fragmentoff;
            m.algfmt = 0;
            return Ok(());
        }
        let Some(pblk) = cur.pblk else {
            return Err(ErofsError::BadImage("head lcluster without blkaddr".into()));
        };
        m.mapped = true;
        m.m_pa = pblk * self.sb.block_size;
        m.m_plen = self.extent_compressedlen(inode, z, &cur, headtype)?;
        if m.m_plen == 0 {
            m.mapped = false;
        }
        m.algfmt = if headtype == LCT_PLAIN {
            if z.advise & ADVISE_INTERLACED_PCLUSTER != 0 {
                0xfe
            } else {
                0xff // SHIFTED raw
            }
        } else if headtype == LCT_HEAD2 {
            1u8 // validated at header parse (only LZ4 = 0 admitted)
        } else {
            0
        };
        Ok(())
    }

    fn read_compressed(&self, inode: &Inode) -> Result<Vec<u8>, ErofsError> {
        let z = self.load_zinfo(inode)?;
        let size = inode.size;
        let mut out = alloc_zeroed(size, "compressed file")?;
        if size == 0 {
            return Ok(out);
        }
        if z.whole_packed {
            let packed = self.packed_bytes()?;
            let start = z.fragmentoff as usize;
            let end = start + size as usize;
            if end > packed.len() {
                return Err(ErofsError::BadImage("fragment beyond packed inode".into()));
            }
            out.copy_from_slice(&packed[start..end]);
            return Ok(out);
        }
        let mut la = 0u64;
        let mut guard = 0usize;
        while la < size {
            guard += 1;
            if guard > 1_000_000 {
                return Err(ErofsError::BadImage(
                    "compressed extent walk diverged".into(),
                ));
            }
            let mut map = MapResult::default();
            let mut head = placeholder_lcl();
            self.map_blocks_fo(inode, &z, la, false, &mut map, &mut head)?;
            if map.fragment {
                let packed = self.packed_bytes()?;
                // Fragment extents run to EOF; source offset in the packed
                // file is fragmentoff + (extent-relative position).
                let src = (map.m_pa + (la - map.m_la)) as usize;
                if src > packed.len() {
                    return Err(ErofsError::BadImage("fragment beyond packed inode".into()));
                }
                let copy = (size - la).min((packed.len() - src) as u64);
                out[la as usize..(la + copy) as usize]
                    .copy_from_slice(&packed[src..src + copy as usize]);
                la += copy.max(1);
                continue;
            }
            if map.meta {
                // ztailpacked inline compressed tail: runs to EOF.
                let input = self.read_at(map.m_pa, map.m_plen as usize)?;
                let input = strip_leading_zeros(&input);
                lz4_decode(input, &mut out[map.m_la as usize..])?;
                la = size;
                continue;
            }
            // Regular extent; decompressed length spans to the next head.
            let llen = self
                .extent_decompressedlen(inode, &z, &head, map.m_la)?
                .min(size - map.m_la);
            if !map.mapped {
                la = map.m_la + llen; // hole: zeros
                continue;
            }
            let dst = &mut out[map.m_la as usize..(map.m_la + llen) as usize];
            let input = self.read_at(map.m_pa, map.m_plen as usize)?;
            let cofs = head.clusterofs as usize; // offset of m_la in the pcluster
            match map.algfmt {
                0xff => {
                    // SHIFTED: literal from pcluster start, output <= input.
                    if llen as usize > input.len() {
                        return Err(ErofsError::BadImage(
                            "shifted extent shorter than data".into(),
                        ));
                    }
                    dst.copy_from_slice(&input[..llen as usize]);
                }
                0xfe => {
                    // INTERLACED: identity copy at the same offsets 鈥?the
                    // extent window starts at its clusterofs inside the
                    // plain pcluster (z_erofs_transform_plain).
                    if cofs + llen as usize > input.len() {
                        return Err(ErofsError::BadImage(
                            "interlaced extent shorter than data".into(),
                        ));
                    }
                    dst.copy_from_slice(&input[cofs..cofs + llen as usize]);
                }
                _ => {
                    let input = strip_leading_zeros(&input);
                    lz4_decode(input, dst)?;
                }
            }
            la = map.m_la + llen;
        }
        Ok(out)
    }

    fn read_inode_data(&self, inode: &Inode) -> Result<Vec<u8>, ErofsError> {
        match inode.datalayout {
            DL_FLAT_PLAIN | DL_FLAT_INLINE => self.read_flat(inode),
            DL_COMPRESSED_COMPACT | DL_COMPRESSED_FULL => self.read_compressed(inode),
            DL_CHUNK_BASED => Err(ErofsError::Unsupported("chunk-based inodes".into())),
            other => Err(ErofsError::BadImage(format!("datalayout {other}"))),
        }
    }

    /// Content of the packed (fragment) inode, cached.
    fn packed_bytes(&self) -> Result<Rc<Vec<u8>>, ErofsError> {
        if let Some(cached) = self.packed_cache.borrow().as_ref() {
            return Ok(Rc::clone(cached));
        }
        if *self.packed_reading.borrow() {
            return Err(ErofsError::BadImage(
                "packed inode contains fragments".into(),
            ));
        }
        if self.sb.packed_nid == 0 {
            return Err(ErofsError::BadImage(
                "image has fragments but no packed inode".into(),
            ));
        }
        *self.packed_reading.borrow_mut() = true;
        let result = (|| {
            let packed_inode = self.inode(self.sb.packed_nid)?;
            match packed_inode.datalayout {
                DL_FLAT_PLAIN | DL_FLAT_INLINE | DL_COMPRESSED_COMPACT => {
                    self.read_inode_data(&packed_inode)
                }
                other => Err(ErofsError::BadImage(format!(
                    "unexpected packed inode datalayout {other}"
                ))),
            }
        })();
        *self.packed_reading.borrow_mut() = false;
        let data = Rc::new(result?);
        *self.packed_cache.borrow_mut() = Some(Rc::clone(&data));
        Ok(data)
    }

    // 鈹€鈹€ path API 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    fn read_file_inner(&self, inner_path: &str, depth: u32) -> Result<Vec<u8>, ErofsError> {
        if depth > MAX_SYMLINK_DEPTH {
            return Err(ErofsError::BadImage("symlink chain too deep".into()));
        }
        let nid = self.resolve_nid(inner_path, 0)?;
        let inode = self.inode(nid)?;
        if inode.mode & MODE_FMT_MASK == MODE_LNK {
            let target = self.resolve_link(inner_path, &self.read_symlink(&inode)?, 0)?;
            return self.read_file_inner(&target, depth + 1);
        }
        if inode.mode & MODE_FMT_MASK != MODE_REG {
            return Err(ErofsError::BadImage(format!(
                "{inner_path} is not a regular file"
            )));
        }
        self.read_inode_data(&inode)
    }

    fn resolve_link(
        &self,
        from_path: &str,
        target: &str,
        depth: u32,
    ) -> Result<String, ErofsError> {
        if depth > MAX_SYMLINK_DEPTH {
            return Err(ErofsError::BadImage("symlink chain too deep".into()));
        }
        if target.starts_with('/') {
            return Ok(target.trim_start_matches('/').to_string());
        }
        let base = match from_path.rfind('/') {
            Some(idx) => &from_path[..idx],
            None => "",
        };
        Ok(format!("{base}/{target}")
            .trim_start_matches('/')
            .to_string())
    }

    fn walk_for_extract(
        &self,
        dir_nid: u64,
        prefix: &str,
        depth: u32,
        out_dir: &str,
        filter: &dyn Fn(&str) -> bool,
        visited: &mut HashSet<u64>,
    ) -> Result<(), ErofsError> {
        if depth > 32 || visited.contains(&dir_nid) {
            return Ok(());
        }
        visited.insert(dir_nid);
        let dir = self.inode(dir_nid)?;
        for entry in self.list_dir_entries_of_inode(&dir)? {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            if entry.name.contains('/')
                || entry.name.contains('\\')
                || crate::layout::is_drive_relative_name(&entry.name)
            {
                return Err(ErofsError::BadImage(format!(
                    "entry name {:?} is not a safe path segment",
                    entry.name
                )));
            }
            let relative = if prefix.is_empty() {
                entry.name.clone()
            } else {
                format!("{prefix}/{}", entry.name)
            };
            match entry.kind {
                ErofsNodeKind::Dir => {
                    self.walk_for_extract(
                        entry.nid,
                        &relative,
                        depth + 1,
                        out_dir,
                        filter,
                        visited,
                    )?;
                }
                ErofsNodeKind::File => {
                    if !filter(&relative) {
                        continue;
                    }
                    let inode = self.inode(entry.nid)?;
                    if inode.mode & MODE_FMT_MASK != MODE_REG {
                        continue;
                    }
                    let data = self.read_inode_data(&inode)?;
                    let mut target = PathBuf::from(out_dir);
                    for segment in relative.split('/') {
                        target.push(segment);
                    }
                    if let Some(parent) = target.parent() {
                        if !parent.as_os_str().is_empty() {
                            fs::create_dir_all(parent)
                                .map_err(|e| ErofsError::Io(e.to_string()))?;
                        }
                    }
                    fs::write(&target, &data).map_err(|e| ErofsError::Io(e.to_string()))?;
                }
                ErofsNodeKind::Symlink => {} // devices/sockets/symlinks skipped
            }
        }
        Ok(())
    }
}

fn placeholder_lcl() -> Lcl {
    Lcl {
        lcn: 0,
        ltype: 0,
        clusterofs: 0,
        delta0: 0,
        delta1: 0,
        compressedblks: None,
        pblk: None,
        nextpackoff: 0,
    }
}

/// Kernel `get_compacted_la_distance`.
fn compacted_la_distance(decode: &dyn Fn(i64) -> (u32, u8), vcnt: usize, i0: i64) -> u32 {
    let mut d1 = 0u32;
    let mut i = i0;
    let mut lo;
    loop {
        let (l, t) = decode(i);
        lo = l;
        if t != LCT_NONHEAD {
            return d1;
        }
        d1 += 1;
        i += 1;
        if i >= vcnt as i64 {
            break;
        }
    }
    if lo & LI_D0_CBLKCNT == 0 && lo > 0 {
        d1 += lo - 1;
    }
    d1
}

fn dirent_kind(file_type: u8) -> Option<ErofsNodeKind> {
    match file_type {
        DIRENT_FT_REG => Some(ErofsNodeKind::File),
        DIRENT_FT_DIR => Some(ErofsNodeKind::Dir),
        DIRENT_FT_LNK => Some(ErofsNodeKind::Symlink),
        _ => None,
    }
}

fn read_exact_or_not_image(file: &mut fs::File, buf: &mut [u8]) -> Result<(), ErofsError> {
    let mut total = 0usize;
    while total < buf.len() {
        match file.read(&mut buf[total..]) {
            Ok(0) => return Err(ErofsError::NotErofsImage),
            Ok(n) => total += n,
            Err(e) => return Err(ErofsError::Io(e.to_string())),
        }
    }
    Ok(())
}

/// Kernel `z_erofs_fixup_insize`: skip leading zero padding of the first
/// compressed block. A valid LZ4 stream never starts with a zero token.
fn strip_leading_zeros(input: &[u8]) -> &[u8] {
    let start = input.iter().position(|&b| b != 0).unwrap_or(input.len());
    &input[start..]
}

/// Self-contained LZ4 block decode (kernel `LZ4_decompress_safe` semantics:
/// stop once `out` is full; trailing input ignored).
///
/// This stays hand-written on purpose: EROFS hands us a block-aligned
/// pcluster (`extent_compressedlen`) whose tail after the stream is padding,
/// while `lz4_flex` only stops when the **input** is exhausted and rejects
/// the padding (`OffsetZero`), and it has no consumed-length API. `liblz4`
/// bindings would need a C toolchain and break the pure-Rust
/// aarch64-pc-windows-msvc cross build. If `lz4_flex` ever grows a
/// "stop when the output buffer is full" entry point, this can be dropped.
fn lz4_decode(input: &[u8], out: &mut [u8]) -> Result<(), ErofsError> {
    let bad = |why: &str| ErofsError::BadImage(format!("lz4: {why}"));
    let mut ip = 0usize;
    let mut op = 0usize;
    while op < out.len() {
        if ip >= input.len() {
            return Err(bad("input exhausted"));
        }
        let token = input[ip];
        ip += 1;
        let mut lit_len = (token >> 4) as usize;
        if lit_len == 15 {
            loop {
                if ip >= input.len() {
                    return Err(bad("literal length overrun"));
                }
                let b = input[ip];
                ip += 1;
                lit_len += b as usize;
                if b != 255 {
                    break;
                }
            }
        }
        if ip + lit_len > input.len() || op + lit_len > out.len() {
            return Err(bad("literal overrun"));
        }
        out[op..op + lit_len].copy_from_slice(&input[ip..ip + lit_len]);
        ip += lit_len;
        op += lit_len;
        if op == out.len() {
            break; // stream may end right after the literals
        }
        if ip + 2 > input.len() {
            return Err(bad("truncated match offset"));
        }
        let offset = u16le(input, ip) as usize;
        ip += 2;
        if offset == 0 || offset > op {
            return Err(bad("bad match offset"));
        }
        let mut match_len = (token & 0x0f) as usize + 4;
        if token & 0x0f == 15 {
            loop {
                if ip >= input.len() {
                    return Err(bad("match length overrun"));
                }
                let b = input[ip];
                ip += 1;
                match_len += b as usize;
                if b != 255 {
                    break;
                }
            }
        }
        if op + match_len > out.len() {
            return Err(bad("match overrun"));
        }
        let mut src = op - offset;
        // byte-by-byte forward copy: LZ4 overlapping matches (RLE) must not be
        // turned into a memmove-style copy_within.
        #[allow(clippy::explicit_counter_loop)]
        for _ in 0..match_len {
            out[op] = out[src];
            op += 1;
            src += 1;
        }
    }
    Ok(())
}

/// Inodes claiming more data than this are malformed images (the same cap the
/// ext4 reader inherited from the TS port's `Buffer.alloc` limit).
const MAX_INODE_BYTES: u64 = u32::MAX as u64;

/// Zeroed buffer of `size` bytes: rejects implausible inode sizes and reports
/// an unallocatable request as a bad image instead of aborting the process.
fn alloc_zeroed(size: u64, what: &str) -> Result<Vec<u8>, ErofsError> {
    if size > MAX_INODE_BYTES {
        return Err(ErofsError::BadImage(format!(
            "{what} claims {size} bytes, above the {MAX_INODE_BYTES} byte cap"
        )));
    }
    let mut out = Vec::new();
    out.try_reserve_exact(size as usize)
        .map_err(|_| ErofsError::BadImage(format!("cannot allocate {size} bytes for {what}")))?;
    out.resize(size as usize, 0);
    Ok(out)
}

fn u16le(buf: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([buf[off], buf[off + 1]])
}

fn u32le(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

fn u64le(buf: &[u8], off: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&buf[off..off + 8]);
    u64::from_le_bytes(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// Real EROFS image generated with `mkfs.erofs -zlz4hc -E fragments`
    /// over a deterministic apex-payload-like tree:
    ///   apex_manifest.pb      "fixed manifest payload bytes" (28 B)
    ///   javalib/module.jar    3000 x "payload line %04d lorem ipsum dolor
    ///                         sit amet consectetur\n" (57 B each, 171000 B)
    ///   javalib/random.bin    150000 B incompressible (SHIFTED pclusters)
    ///   priv-app/shim/tiny.txt "tiny"
    ///   priv-app/shim/dup{1,2}.bin  3000 zero bytes (fragment dedupe)
    ///   etc/permissions/etc-permissions.xml
    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("apex_payload_erofs.img")
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("decx-erofs-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn collect_relative_files(root: &Path) -> Vec<String> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                let rel = if prefix.is_empty() {
                    name
                } else {
                    format!("{prefix}/{name}")
                };
                if path.is_dir() {
                    walk(&path, &rel, out);
                } else {
                    out.push(rel);
                }
            }
        }
        let mut out = Vec::new();
        walk(root, "", &mut out);
        out.sort();
        out
    }

    #[test]
    fn rejects_non_erofs_images() {
        let dir = temp_dir("not-erofs");
        let bogus = dir.join("bogus.img");
        fs::write(&bogus, vec![0u8; 4096]).unwrap();
        assert!(matches!(
            ErofsImage::open(bogus.to_str().unwrap()),
            Err(ErofsError::NotErofsImage)
        ));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_the_root_directory() {
        let image = ErofsImage::open(fixture().to_str().unwrap()).unwrap();
        let names: Vec<String> = image
            .list_dir("/")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .filter(|n| n != "." && n != "..")
            .collect();
        assert_eq!(
            names,
            vec!["apex_manifest.pb", "etc", "javalib", "priv-app"]
        );
        image.close();
    }

    #[test]
    fn reads_small_and_large_files() {
        let image = ErofsImage::open(fixture().to_str().unwrap()).unwrap();
        let tiny = image.read_file("/priv-app/shim/tiny.txt").unwrap();
        assert_eq!(tiny, b"tiny");
        let manifest = image.read_file("/apex_manifest.pb").unwrap();
        assert_eq!(manifest.len(), 28);
        let jar = image.read_file("/javalib/module.jar").unwrap();
        assert_eq!(jar.len(), 171000);
        let lines: Vec<&[u8]> = jar.split(|b| *b == b'\n').collect();
        assert_eq!(lines.len(), 3001); // 3000 lines + trailing empty split
        assert!(lines[0].starts_with(b"payload line "));
        let dup1 = image.read_file("/priv-app/shim/dup1.bin").unwrap();
        let dup2 = image.read_file("/priv-app/shim/dup2.bin").unwrap();
        assert_eq!(dup1.len(), 3000);
        assert_eq!(dup1, dup2);
        assert!(dup1.iter().all(|b| *b == 0));
        let random = image.read_file("/javalib/random.bin").unwrap();
        assert_eq!(random.len(), 150000);
        assert!(random.iter().any(|b| *b != 0));
        image.close();
    }

    #[test]
    fn extracts_tree_with_filter() {
        let root = temp_dir("extract");
        let image = ErofsImage::open(fixture().to_str().unwrap()).unwrap();
        image
            .extract_to(root.to_str().unwrap(), &|rel| {
                rel.ends_with(".jar") || rel.ends_with(".bin")
            })
            .unwrap();
        image.close();
        assert_eq!(
            collect_relative_files(&root),
            vec![
                "javalib/module.jar",
                "javalib/random.bin",
                "priv-app/shim/dup1.bin",
                "priv-app/shim/dup2.bin",
            ]
        );
        assert_eq!(
            fs::read(root.join("javalib/module.jar")).unwrap().len(),
            171000
        );
        let dup1 = fs::read(root.join("priv-app/shim/dup1.bin")).unwrap();
        let dup2 = fs::read(root.join("priv-app/shim/dup2.bin")).unwrap();
        assert_eq!(dup1, dup2);
        fs::remove_dir_all(&root).unwrap();
    }

    /// Dev-machine cross-validation against mkfs.erofs/fsck.erofs reference
    /// trees: set DECX_EROFS_FIXTURES=<dir with *.img + ref/<name>/ trees>.
    #[test]
    fn cross_validates_against_fsck_references() {
        let Ok(dir) = std::env::var("DECX_EROFS_FIXTURES") else {
            return;
        };
        let dir = PathBuf::from(dir);
        let mut checked = 0usize;
        for img in fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "img"))
        {
            let name = img
                .path()
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let reference = dir.join("ref").join(&name);
            if !reference.is_dir() {
                continue;
            }
            let out = temp_dir(&format!("xval-{name}"));
            let image = ErofsImage::open(img.path().to_str().unwrap())
                .unwrap_or_else(|e| panic!("{name}: open failed: {e:?}"));
            image.extract_to(out.to_str().unwrap(), &|_| true).unwrap();
            image.close();
            let mut expected = Vec::new();
            let mut stack = vec![reference.clone()];
            while let Some(d) = stack.pop() {
                for e in fs::read_dir(&d).unwrap().flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        stack.push(p);
                    } else {
                        expected.push(
                            p.strip_prefix(&reference)
                                .unwrap()
                                .to_string_lossy()
                                .replace('\\', "/"),
                        );
                    }
                }
            }
            expected.sort();
            let got = collect_relative_files(&out);
            assert_eq!(got, expected, "{name}: file lists differ");
            for rel in &expected {
                let a = fs::read(reference.join(rel)).unwrap();
                let b = fs::read(out.join(rel)).unwrap();
                assert_eq!(a, b, "{name}/{rel}: bytes differ");
            }
            fs::remove_dir_all(&out).unwrap();
            checked += 1;
        }
        assert!(checked > 0, "no fixtures found under {dir:?}");
    }

    #[test]
    fn lz4_roundtrip_basics() {
        // literals + non-overlapping match (match len 4, offset 1)
        let input = [0x60u8, b'a', b'b', b'c', b'd', b'e', b'f', 1, 0];
        let mut out = vec![0u8; 10];
        lz4_decode(&input, &mut out).unwrap();
        assert_eq!(&out, b"abcdefffff");

        // overlapping match (RLE): 2 literals, match len 4, offset 1
        let input = [0x20u8, b'x', b'y', 1, 0];
        let mut out = vec![0u8; 6];
        lz4_decode(&input, &mut out).unwrap();
        assert_eq!(&out, b"xyyyyy");

        // long literals with length continuation (15 + 100)
        let mut input = vec![0xf0u8, 100u8];
        input.extend(std::iter::repeat_n(b'L', 115));
        let mut out = vec![0u8; 115];
        lz4_decode(&input, &mut out).unwrap();
        assert!(out.iter().all(|&b| b == b'L'));

        // leading zero padding is stripped
        let mut input = vec![0u8, 0u8];
        input.extend_from_slice(&[0x10, b'z', 1, 0]);
        let mut out = vec![0u8; 5];
        lz4_decode(strip_leading_zeros(&input), &mut out).unwrap();
        assert_eq!(&out, b"zzzzz");
    }
}

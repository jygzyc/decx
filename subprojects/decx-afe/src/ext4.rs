//! Minimal read-only ext4 image reader for APEX payload images.
//!
//! Pure-std port of the TypeScript CLI's `src/android/ext4-reader.ts`.
//! Parses the filesystem natively (superblock -> group descriptors ->
//! inodes -> extent trees -> directory entries) so payload extraction needs
//! no external tools. Only the read paths used by APEX
//! payloads are implemented; unsupported layouts return
//! [`Ext4Error::UnsupportedFeature`] so callers can fall back to the
//! external-tool pipeline, exactly like the TS `UnsupportedImageFeatureError`.
//! [`Ext4Error::NotExt4Image`] (TS `NotExt4ImageError`) marks images that are
//! not ext4 at all — the processor falls back to external tools on exactly
//! these two variants.

#![allow(dead_code)]
// Consumed by the APEX/framework processor once that port lands; until then
// nothing in the binary reaches this module, which would trip dead_code in
// this bin-only crate.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

const EXT4_MAGIC: u16 = 0xef53;
const EXTENT_MAGIC: u16 = 0xf30a;
const ROOT_INODE: u64 = 2;
const SUPERBLOCK_OFFSET: u64 = 1024;
const MAX_SYMLINK_DEPTH: u32 = 10;

const INODE_MODE_FMT_MASK: u16 = 0xf000;
const MODE_REG: u16 = 0x8000;
const MODE_DIR: u16 = 0x4000;
const MODE_LNK: u16 = 0xa000;

const FLAG_EXTENTS: u32 = 0x80000;
const FLAG_INLINE_DATA: u32 = 0x1000_0000;
const FLAG_ENCRYPT: u32 = 0x800;

const DIRENT_MIN: usize = 8;
const DIRENT_FT_REG: u8 = 1;
const DIRENT_FT_DIR: u8 = 2;
const DIRENT_FT_LNK: u8 = 7;

/// Inherited from the TS port (Node's `Buffer.alloc` cap): inodes claiming
/// more data than this are malformed images, not fallback-worthy layouts.
const MAX_INODE_BYTES: u64 = u32::MAX as u64;

/// Error taxonomy mirroring the TS module: `NotExt4Image` and
/// `UnsupportedFeature` tell the processor to fall back to external tools.
#[derive(Debug)]
pub enum Ext4Error {
    NotExt4Image,
    UnsupportedFeature(String),
    Io(String),
    BadImage(String),
}

impl std::fmt::Display for Ext4Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Ext4Error::NotExt4Image => write!(f, "not an ext4 image"),
            Ext4Error::UnsupportedFeature(what) => {
                write!(f, "unsupported image feature: {what}")
            }
            Ext4Error::Io(err) => write!(f, "io error: {err}"),
            Ext4Error::BadImage(why) => write!(f, "malformed image: {why}"),
        }
    }
}

impl std::error::Error for Ext4Error {}

/// Node kind of a directory entry (from the dirent file_type, or the inode
/// mode where the TS reader uses `inodeKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ext4NodeKind {
    File,
    Dir,
    Symlink,
}

/// One parsed directory entry.
#[derive(Debug)]
pub struct Ext4DirEntry {
    pub name: String,
    pub inode: u64,
    pub kind: Ext4NodeKind,
}

struct Extent {
    logical_block: u64,
    physical_block: u64,
    block_count: u64,
    unwritten: bool,
}

struct Geometry {
    block_size: u64,
    inodes_per_group: u64,
    inode_size: u64,
    group_desc_offset: u64,
    group_desc_size: u64,
}

struct InodeInfo {
    mode: u16,
    size: u64,
    flags: u32,
    raw: Vec<u8>, // full inode bytes (fast-symlink targets live in i_block)
}

/// Open ext4 payload image. Mirrors `Ext4Image.open` of the TS module: any
/// superblock read shortfall or magic mismatch is [`Ext4Error::NotExt4Image`].
pub struct Ext4Image {
    file: fs::File,
    geometry: Geometry,
}

impl Ext4Image {
    pub fn open(path: &str) -> Result<Ext4Image, Ext4Error> {
        let mut file = fs::File::open(path).map_err(|e| Ext4Error::Io(e.to_string()))?;
        let geometry = read_geometry(&mut file)?;
        Ok(Ext4Image { file, geometry })
    }

    /// Closes the underlying file (it also closes on drop).
    pub fn close(self) {}

    /// Directory entries of one directory inode (TS `listDir`).
    pub fn list_dir(&self, inner_path: &str) -> Result<Vec<Ext4DirEntry>, Ext4Error> {
        let dir_ino = self.resolve_inode(inner_path, 0)?;
        let inode = self.inode(dir_ino)?;
        if inode.mode & INODE_MODE_FMT_MASK != MODE_DIR {
            return Err(Ext4Error::UnsupportedFeature(format!(
                "{inner_path} is not a directory"
            )));
        }
        self.list_dir_entries_of_inode(dir_ino)
    }

    /// Raw content of a regular file at `inner_path`, following symlinks
    /// (TS `readFile`).
    pub fn read_file(&self, inner_path: &str) -> Result<Vec<u8>, Ext4Error> {
        self.read_file_inner(inner_path, 0)
    }

    /// Walk the whole tree starting at `/` and extract regular files for
    /// which `filter(relative_path)` holds into `dir`, preserving inner
    /// paths (separators normalized to the host OS). Skips `lost+found`.
    /// Devices, sockets, and fifos are skipped like in the TS walk.
    pub fn extract_to(&self, dir: &str, filter: &dyn Fn(&str) -> bool) -> Result<(), Ext4Error> {
        let mut visited: HashSet<u64> = HashSet::new();
        self.walk_for_extract(ROOT_INODE, "", 0, dir, filter, &mut visited)
    }

    fn read_at(&self, pos: u64, len: usize) -> Result<Vec<u8>, Ext4Error> {
        let mut buf = vec![0u8; len];
        let mut file = &self.file;
        file.seek(SeekFrom::Start(pos))
            .map_err(|e| Ext4Error::Io(e.to_string()))?;
        let mut total = 0usize;
        while total < len {
            let n = file
                .read(&mut buf[total..])
                .map_err(|e| Ext4Error::Io(e.to_string()))?;
            if n == 0 {
                return Err(Ext4Error::UnsupportedFeature(format!(
                    "Unexpected EOF at {}",
                    pos + total as u64
                )));
            }
            total += n;
        }
        Ok(buf)
    }

    fn read_block(&self, block: u64) -> Result<Vec<u8>, Ext4Error> {
        let size = self.geometry.block_size as usize;
        self.read_at(block * self.geometry.block_size, size)
    }

    fn inode(&self, ino: u64) -> Result<InodeInfo, Ext4Error> {
        if ino == 0 {
            return Err(Ext4Error::UnsupportedFeature(
                "Lookup of inode 0".to_string(),
            ));
        }
        let Geometry {
            block_size,
            inodes_per_group,
            inode_size,
            group_desc_offset,
            group_desc_size,
        } = &self.geometry;
        let group = (ino - 1) / inodes_per_group;
        let index = (ino - 1) % inodes_per_group;
        let desc = self.read_at(
            group_desc_offset + group * group_desc_size,
            *group_desc_size as usize,
        )?;
        let table_block = u32le(&desc, 8) as u64
            + if *group_desc_size == 64 {
                u32le(&desc, 40) as u64 * (1u64 << 32)
            } else {
                0
            };
        if table_block == 0 {
            return Err(Ext4Error::UnsupportedFeature(format!(
                "No inode table for group {group}"
            )));
        }

        let inode_offset = table_block * block_size + index * inode_size;
        let raw = self.read_at(inode_offset, *inode_size as usize)?;
        Ok(InodeInfo {
            mode: u16le(&raw, 0),
            size: u32le(&raw, 4) as u64 + u32le(&raw, 108) as u64 * (1u64 << 32),
            flags: u32le(&raw, 32),
            raw,
        })
    }

    fn inode_kind(&self, ino: u64) -> Result<Ext4NodeKind, Ext4Error> {
        let mode = self.inode(ino)?.mode & INODE_MODE_FMT_MASK;
        if mode == MODE_REG {
            return Ok(Ext4NodeKind::File);
        }
        if mode == MODE_DIR {
            return Ok(Ext4NodeKind::Dir);
        }
        if mode == MODE_LNK {
            return Ok(Ext4NodeKind::Symlink);
        }
        Err(Ext4Error::UnsupportedFeature(format!(
            "Inode {ino} has unsupported mode 0x{mode:04x}"
        )))
    }

    /// Collect leaf extents of an inode's extent tree.
    fn extents(&self, inode: &InodeInfo) -> Result<Vec<Extent>, Ext4Error> {
        // i_block area holds the extent tree root.
        let mut result = Vec::new();
        self.walk_extent_header(&inode.raw[40..100], &mut result, 0)?;
        Ok(result)
    }

    fn walk_extent_header(
        &self,
        header: &[u8],
        result: &mut Vec<Extent>,
        depth_guard: u32,
    ) -> Result<(), Ext4Error> {
        if depth_guard > 4 {
            return Err(Ext4Error::UnsupportedFeature(
                "Extent tree too deep".to_string(),
            ));
        }
        if u16le(header, 0) != EXTENT_MAGIC {
            return Err(Ext4Error::UnsupportedFeature(
                "Inode without extent tree (legacy block pointers)".to_string(),
            ));
        }
        let entries = u16le(header, 2) as usize;
        let depth = u16le(header, 6);
        for i in 0..entries {
            let at = 12 + i * 12;
            if at + 12 > header.len() {
                return Err(Ext4Error::BadImage(format!(
                    "extent header claims {entries} entries, overflows {} bytes",
                    header.len()
                )));
            }
            if depth == 0 {
                let len = u16le(header, at + 4);
                result.push(Extent {
                    logical_block: u32le(header, at) as u64,
                    physical_block: u32le(header, at + 8) as u64
                        + u16le(header, at + 6) as u64 * (1u64 << 32),
                    block_count: (len & 0x7fff) as u64,
                    unwritten: (len & 0x8000) != 0,
                });
            } else {
                let child_block =
                    u32le(header, at + 4) as u64 + u16le(header, at + 8) as u64 * (1u64 << 32);
                let child = self.read_block(child_block)?;
                self.walk_extent_header(&child, result, depth_guard + 1)?;
            }
        }
        Ok(())
    }

    /// Full data of a regular file or slow symlink, honoring holes and
    /// unwritten extents (they stay zero like in the TS reader).
    fn read_inode_data(&self, inode: &InodeInfo) -> Result<Vec<u8>, Ext4Error> {
        let block_size = self.geometry.block_size;
        if inode.size > MAX_INODE_BYTES {
            return Err(Ext4Error::BadImage(format!(
                "inode claims {} bytes, above the {} byte cap",
                inode.size, MAX_INODE_BYTES
            )));
        }
        let mut out = vec![0u8; inode.size as usize];
        if inode.size == 0 {
            return Ok(out);
        }
        for extent in self.extents(inode)? {
            let start = extent.logical_block * block_size;
            let end = (start + extent.block_count * block_size).min(inode.size);
            if end <= start || extent.unwritten {
                continue; // holes stay zero
            }
            let chunk = self.read_at(extent.physical_block * block_size, (end - start) as usize)?;
            out[start as usize..end as usize].copy_from_slice(&chunk);
        }
        Ok(out)
    }

    fn read_symlink(&self, inode: &InodeInfo) -> Result<String, Ext4Error> {
        // An extent-based symlink longer than 60 bytes goes through
        // read_inode_data; short symlinks store the target in i_block.
        if inode.size > 60 {
            return Ok(String::from_utf8_lossy(&self.read_inode_data(inode)?).into_owned());
        }
        let end = (40 + inode.size as usize).min(inode.raw.len());
        let inline = &inode.raw[40..end];
        if inline.len() >= 2 && u16le(inline, 0) == EXTENT_MAGIC && inode.flags & FLAG_EXTENTS != 0
        {
            return Ok(String::from_utf8_lossy(&self.read_inode_data(inode)?).into_owned());
        }
        Ok(String::from_utf8_lossy(inline).into_owned())
    }

    fn read_file_inner(&self, inner_path: &str, depth: u32) -> Result<Vec<u8>, Ext4Error> {
        if depth > MAX_SYMLINK_DEPTH {
            return Err(Ext4Error::UnsupportedFeature(
                "Symlink chain too deep".to_string(),
            ));
        }
        let ino = self.resolve_inode(inner_path, 0)?;
        let inode = self.inode(ino)?;
        if inode.mode & INODE_MODE_FMT_MASK == MODE_LNK {
            let target = self.resolve_link(inner_path, &self.read_symlink(&inode)?, 0)?;
            return self.read_file_inner(&target, depth + 1);
        }
        if inode.mode & INODE_MODE_FMT_MASK != MODE_REG {
            return Err(Ext4Error::UnsupportedFeature(format!(
                "{inner_path} is not a regular file"
            )));
        }
        self.check_readable_inode(&inode, inner_path)?;
        self.read_inode_data(&inode)
    }

    fn check_readable_inode(&self, inode: &InodeInfo, label: &str) -> Result<(), Ext4Error> {
        if inode.flags & FLAG_ENCRYPT != 0 {
            return Err(Ext4Error::UnsupportedFeature(format!(
                "{label} is encrypted"
            )));
        }
        if inode.flags & FLAG_INLINE_DATA != 0 {
            return Err(Ext4Error::UnsupportedFeature(format!(
                "{label} uses inline data"
            )));
        }
        if inode.flags & FLAG_EXTENTS == 0 {
            return Err(Ext4Error::UnsupportedFeature(format!(
                "{label} has no extent tree"
            )));
        }
        Ok(())
    }

    fn resolve_link(&self, from_path: &str, target: &str, depth: u32) -> Result<String, Ext4Error> {
        if depth > MAX_SYMLINK_DEPTH {
            return Err(Ext4Error::UnsupportedFeature(
                "Symlink chain too deep".to_string(),
            ));
        }
        if target.starts_with('/') {
            return Ok(normalize_inner_path(target));
        }
        let base = match from_path.rfind('/') {
            Some(idx) => &from_path[..idx],
            None => "",
        };
        Ok(normalize_inner_path(&format!("{base}/{target}")))
    }

    /// Resolve an inner path (following symlinks) to an inode number.
    fn resolve_inode(&self, inner_path: &str, depth: u32) -> Result<u64, Ext4Error> {
        if depth > MAX_SYMLINK_DEPTH {
            return Err(Ext4Error::UnsupportedFeature(
                "Symlink chain too deep".to_string(),
            ));
        }
        let normalized = normalize_inner_path(inner_path);
        let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
        let mut ino = ROOT_INODE;
        for i in 0..segments.len() {
            let entry = self
                .list_dir_entries_of_inode(ino)?
                .into_iter()
                .find(|candidate| candidate.name == segments[i]);
            let Some(entry) = entry else {
                return Err(Ext4Error::UnsupportedFeature(format!(
                    "No such entry: {inner_path}"
                )));
            };
            if entry.kind == Ext4NodeKind::Symlink {
                let link = self.read_symlink(&self.inode(entry.inode)?)?;
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
                return self.resolve_inode(&combined, depth + 1);
            }
            ino = entry.inode;
        }
        Ok(ino)
    }

    fn list_dir_entries_of_inode(&self, ino: u64) -> Result<Vec<Ext4DirEntry>, Ext4Error> {
        let inode = self.inode(ino)?;
        if inode.mode & INODE_MODE_FMT_MASK != MODE_DIR {
            return Err(Ext4Error::UnsupportedFeature(format!(
                "Inode {ino} is not a directory"
            )));
        }
        let block_size = self.geometry.block_size as usize;
        // Ordered set of the directory's data blocks (first-seen order like
        // the TS Set).
        let mut dir_blocks: Vec<u64> = Vec::new();
        for extent in self.extents(&inode)? {
            for i in 0..extent.block_count {
                let block = extent.physical_block + i;
                if !dir_blocks.contains(&block) {
                    dir_blocks.push(block);
                }
            }
        }
        let mut entries = Vec::new();
        for block in dir_blocks {
            let data = self.read_block(block)?;
            let mut offset = 0usize;
            while offset + DIRENT_MIN <= block_size {
                let rec_len = u16le(&data, offset + 4) as usize;
                if rec_len < DIRENT_MIN || offset + rec_len > block_size {
                    break;
                }
                let entry_ino = u32le(&data, offset) as u64;
                let name_len = data[offset + 6] as usize;
                let file_type = data[offset + 7];
                if entry_ino != 0
                    && name_len > 0
                    && offset + DIRENT_MIN + name_len <= offset + rec_len
                {
                    let name = String::from_utf8_lossy(
                        &data[offset + DIRENT_MIN..offset + DIRENT_MIN + name_len],
                    )
                    .into_owned();
                    let kind = dirent_kind(file_type).unwrap_or(Ext4NodeKind::File);
                    entries.push(Ext4DirEntry {
                        name,
                        inode: entry_ino,
                        kind,
                    });
                }
                offset += rec_len;
            }
        }
        Ok(entries)
    }

    fn walk_for_extract(
        &self,
        dir_ino: u64,
        prefix: &str,
        depth: u32,
        out_dir: &str,
        filter: &dyn Fn(&str) -> bool,
        visited: &mut HashSet<u64>,
    ) -> Result<(), Ext4Error> {
        if depth > 32 || visited.contains(&dir_ino) {
            return Ok(());
        }
        visited.insert(dir_ino);
        for entry in self.list_dir_entries_of_inode(dir_ino)? {
            if entry.name == "." || entry.name == ".." || entry.name == "lost+found" {
                continue;
            }
            // Untrusted images: never build host paths from names that
            // could escape the extraction root.
            if entry.name.contains('/') || entry.name.contains('\\') {
                return Err(Ext4Error::BadImage(format!(
                    "entry name {:?} contains a path separator",
                    entry.name
                )));
            }
            let relative = if prefix.is_empty() {
                entry.name.clone()
            } else {
                format!("{prefix}/{}", entry.name)
            };
            let kind = self.inode_kind(entry.inode)?;
            if kind == Ext4NodeKind::Dir {
                self.walk_for_extract(entry.inode, &relative, depth + 1, out_dir, filter, visited)?;
                continue;
            }
            if kind != Ext4NodeKind::File {
                continue; // devices, sockets, fifos: skip
            }
            if !filter(&relative) {
                continue;
            }
            let inode = self.inode(entry.inode)?;
            self.check_readable_inode(&inode, &relative)?;
            let data = self.read_inode_data(&inode)?;
            let mut target = PathBuf::from(out_dir);
            for segment in relative.split('/') {
                target.push(segment);
            }
            if let Some(parent) = target.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent).map_err(|e| Ext4Error::Io(e.to_string()))?;
                }
            }
            fs::write(&target, &data).map_err(|e| Ext4Error::Io(e.to_string()))?;
        }
        Ok(())
    }
}

/// Node kind derived from the dirent file_type, trusted over dirent names.
/// Unknown types degrade to `File` at the call site, like the TS `?? "file"`.
fn dirent_kind(file_type: u8) -> Option<Ext4NodeKind> {
    match file_type {
        DIRENT_FT_REG => Some(Ext4NodeKind::File),
        DIRENT_FT_DIR => Some(Ext4NodeKind::Dir),
        DIRENT_FT_LNK => Some(Ext4NodeKind::Symlink),
        _ => None,
    }
}

fn normalize_inner_path(inner_path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for segment in inner_path.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            out.pop();
            continue;
        }
        out.push(segment);
    }
    out.join("/")
}

fn read_geometry(file: &mut fs::File) -> Result<Geometry, Ext4Error> {
    // Mirrors readGeometry(): a short read here means "not an ext4 image"
    // (NotExt4ImageError in TS), so callers fall back to external tools.
    let mut sb = vec![0u8; 512];
    file.seek(SeekFrom::Start(SUPERBLOCK_OFFSET))
        .map_err(|e| Ext4Error::Io(e.to_string()))?;
    read_full(file, &mut sb).map_err(|_| Ext4Error::NotExt4Image)?;
    if u16le(&sb, 56) != EXT4_MAGIC {
        return Err(Ext4Error::NotExt4Image);
    }
    // 1024 * (1 << s_log_block_size); wrapping mirrors the JS shift on
    // garbage input.
    let block_size = 1024u64.wrapping_shl(u32le(&sb, 24));
    let first_data_block = u32le(&sb, 20) as u64;
    // Field offsets ported as-is from the TS reader (including the u32 read
    // at 40 for s_inodes_per_group and the desc-size read at 256).
    let desc_size_field: u64 = if block_size > 1024 {
        let value = u16le(&sb, 256);
        if value == 0 {
            32
        } else {
            value as u64
        }
    } else {
        32
    };
    let group_desc_size = if desc_size_field == 32 || desc_size_field == 64 {
        desc_size_field
    } else {
        32
    };
    let inodes_per_group = u32le(&sb, 40) as u64;
    if inodes_per_group == 0 {
        return Err(Ext4Error::BadImage("inodes per group is zero".to_string()));
    }
    let inode_size = u16le(&sb, 88) as u64;
    if inode_size < 128 {
        return Err(Ext4Error::BadImage(format!(
            "inode size {inode_size} too small"
        )));
    }
    Ok(Geometry {
        block_size,
        inodes_per_group,
        inode_size,
        group_desc_offset: (first_data_block + 1) * block_size,
        group_desc_size,
    })
}

fn read_full(file: &mut fs::File, buf: &mut [u8]) -> std::io::Result<()> {
    let mut total = 0usize;
    while total < buf.len() {
        match file.read(&mut buf[total..])? {
            0 => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "unexpected eof",
                ))
            }
            n => total += n,
        }
    }
    Ok(())
}

fn u16le(buf: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([buf[off], buf[off + 1]])
}

fn u32le(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::{Path, PathBuf};

    /// Synthesized ext4 payload image (see [`crate::test_support`]); the real
    /// device fixture the TS reader used is not committed.
    fn synthesized_image(tag: &str, files: &[(&str, &[u8])]) -> (PathBuf, PathBuf) {
        let dir = temp_dir(tag);
        let image = dir.join("payload.img");
        fs::write(&image, crate::test_support::build_ext4_image(files)).unwrap();
        (dir, image)
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("decx-ext4-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Relative file paths (with `/` separators) below `root`, sorted.
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
    fn rejects_non_ext4_images() {
        let dir = temp_dir("not-ext4");
        let bogus = dir.join("bogus.img");
        fs::write(&bogus, vec![0u8; 4096]).unwrap();
        assert!(matches!(
            Ext4Image::open(bogus.to_str().unwrap()),
            Err(Ext4Error::NotExt4Image)
        ));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn returns_not_ext4_for_images_without_a_superblock() {
        let dir = temp_dir("unsupported");
        let truncated = dir.join("truncated.img");
        fs::write(&truncated, b"clearly not a filesystem image").unwrap();
        assert!(matches!(
            Ext4Image::open(truncated.to_str().unwrap()),
            Err(Ext4Error::NotExt4Image)
        ));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_the_root_directory() {
        let (dir, path) = synthesized_image("root", &[("apex_manifest.pb", &[0xabu8; 29])]);
        let image = Ext4Image::open(path.to_str().unwrap()).unwrap();
        let mut names: Vec<String> = image
            .list_dir("/")
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        names.sort();
        assert_eq!(names, vec![".", "..", "apex_manifest.pb", "lost+found"]);
        image.close();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_a_small_regular_file() {
        let payload = [0x5au8; 29];
        let (dir, path) = synthesized_image("manifest", &[("apex_manifest.pb", &payload)]);
        let image = Ext4Image::open(path.to_str().unwrap()).unwrap();
        let manifest = image.read_file("/apex_manifest.pb").unwrap();
        assert_eq!(manifest, payload);
        image.close();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolves_nested_versioned_directories() {
        let (dir, path) = synthesized_image(
            "nested-versioned",
            &[("app/CtsShim@MAIN/CtsShim.apk", b"shim")],
        );
        let image = Ext4Image::open(path.to_str().unwrap()).unwrap();
        let names: Vec<String> = image
            .list_dir("/app/CtsShim@MAIN")
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert!(names.iter().any(|name| name == "CtsShim.apk"));
        image.close();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn extracts_only_matching_files_and_skips_lost_found() {
        let (dir, path) = synthesized_image(
            "extract",
            &[
                ("app/CtsShim@MAIN/CtsShim.apk", b"shim"),
                ("priv-app/CtsShimPriv@MAIN/CtsShimPriv.apk", b"priv"),
                ("etc/perm/privapp-permissions.xml", b"<xml/>"),
            ],
        );
        let out = dir.join("out");

        let image = Ext4Image::open(path.to_str().unwrap()).unwrap();
        image
            .extract_to(out.to_str().unwrap(), &|rel| {
                rel.to_lowercase().ends_with(".apk")
            })
            .unwrap();
        image.close();

        let extracted = collect_relative_files(&out);
        assert_eq!(
            extracted,
            vec![
                "app/CtsShim@MAIN/CtsShim.apk",
                "priv-app/CtsShimPriv@MAIN/CtsShimPriv.apk",
            ]
        );
        assert!(out
            .join("app")
            .join("CtsShim@MAIN")
            .join("CtsShim.apk")
            .is_file());
        assert!(!out.join("lost+found").exists());

        // Byte checks: extracted bytes match a direct read of the same path.
        let image = Ext4Image::open(path.to_str().unwrap()).unwrap();
        let direct = image.read_file("/app/CtsShim@MAIN/CtsShim.apk").unwrap();
        assert_eq!(direct, b"shim");
        assert_eq!(
            fs::read(out.join("app").join("CtsShim@MAIN").join("CtsShim.apk")).unwrap(),
            direct
        );
        image.close();

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn normalizes_inner_paths() {
        assert_eq!(normalize_inner_path("/a//b/./c/"), "a/b/c");
        assert_eq!(normalize_inner_path("/a/b/../.."), "");
        assert_eq!(normalize_inner_path("a/b"), "a/b");
        assert_eq!(dirent_kind(1), Some(Ext4NodeKind::File));
        assert_eq!(dirent_kind(2), Some(Ext4NodeKind::Dir));
        assert_eq!(dirent_kind(7), Some(Ext4NodeKind::Symlink));
        assert_eq!(dirent_kind(0), None);
    }
}

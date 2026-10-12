//! Crafted-image robustness: the four shapes below used to abort the process
//! with a panic (capacity overflow / index out of bounds) instead of failing
//! with a structured error. Each test asserts the image is rejected without
//! panicking, so a regression fails here instead of taking the CLI down.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

fn write_temp(name: &str, bytes: &[u8]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("afe_robustness_{}_{}", name, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{name}.img"));
    std::fs::write(&path, bytes).unwrap();
    path
}

fn le16(v: u16) -> [u8; 2] {
    v.to_le_bytes()
}

fn le32(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}

fn le64(v: u64) -> [u8; 8] {
    v.to_le_bytes()
}

/// Minimal EROFS superblock with `blkszbits = 12` and root inode 1.
fn erofs_header() -> Vec<u8> {
    let mut img = vec![0u8; 4096];
    img[1024..1028].copy_from_slice(&[0xe2, 0xe1, 0xf5, 0xe0]);
    img[1024 + 12] = 12; // blkszbits -> 4096
    img[1024 + 14..1024 + 16].copy_from_slice(&1u16.to_le_bytes()); // root_nid
    img
}

#[test]
fn erofs_dir_with_short_inline_tail_is_rejected() {
    // Directory inode with `size = 4`: the inline tail is shorter than a
    // dirent, so the nameoff read used to run off the end of the block.
    let mut img = erofs_header();
    let ino = 32usize;
    let ifmt: u16 = 2 << 1; // version 0, datalayout FLAT_INLINE(2)
    img[ino..ino + 2].copy_from_slice(&ifmt.to_le_bytes());
    img[ino + 2..ino + 4].copy_from_slice(&0u16.to_le_bytes()); // xattr_icount
    img[ino + 4..ino + 6].copy_from_slice(&0x41edu16.to_le_bytes()); // dir mode
    img[ino + 8..ino + 12].copy_from_slice(&4u32.to_le_bytes()); // size = 4

    let path = write_temp("erofs_short_tail", &img);
    let image = afe::erofs::ErofsImage::open(path.to_str().unwrap()).expect("open crafted erofs");
    let result = catch_unwind(AssertUnwindSafe(|| image.list_dir("/")));
    std::fs::remove_dir_all(path.parent().unwrap()).ok();

    let listing = result.expect("crafted erofs must not panic");
    assert!(
        listing.is_err(),
        "expected a bad-image error, got {listing:?}"
    );
}

#[test]
fn ext4_zero_block_size_is_rejected() {
    // s_log_block_size = 54 used to wrap to block_size 0, making every block
    // read empty and the extent walk read out of bounds.
    let mut img = vec![0u8; 1536];
    img[8..12].copy_from_slice(&1u32.to_le_bytes()); // group table block
    let ino = 128usize;
    img[ino..ino + 2].copy_from_slice(&0x4000u16.to_le_bytes()); // dir
    img[ino + 4..ino + 8].copy_from_slice(&0u32.to_le_bytes()); // size
    img[ino + 32..ino + 36].copy_from_slice(&0x80000u32.to_le_bytes()); // EXTENTS
    let hdr = ino + 40;
    img[hdr..hdr + 2].copy_from_slice(&0xf30au16.to_le_bytes()); // magic
    img[hdr + 2..hdr + 4].copy_from_slice(&1u16.to_le_bytes()); // entries
    img[hdr + 4..hdr + 6].copy_from_slice(&4u16.to_le_bytes()); // max
    img[hdr + 6..hdr + 8].copy_from_slice(&1u16.to_le_bytes()); // depth = 1
    img[hdr + 16..hdr + 18].copy_from_slice(&1u16.to_le_bytes()); // ee_len
    img[hdr + 20..hdr + 24].copy_from_slice(&1u32.to_le_bytes()); // ee_start_lo
    let sb = 1024usize;
    img[sb + 56..sb + 58].copy_from_slice(&0xef53u16.to_le_bytes()); // magic
    img[sb + 24..sb + 28].copy_from_slice(&54u32.to_le_bytes()); // s_log_block_size
    img[sb + 40..sb + 44].copy_from_slice(&16u32.to_le_bytes()); // inodes_per_group
    img[sb + 88..sb + 90].copy_from_slice(&128u16.to_le_bytes()); // inode_size

    let path = write_temp("ext4_zero_bs", &img);
    let result = catch_unwind(AssertUnwindSafe(|| {
        afe::ext4::Ext4Image::open(path.to_str().unwrap())
    }));
    std::fs::remove_dir_all(path.parent().unwrap()).ok();

    let opened = result.expect("crafted ext4 must not panic");
    assert!(opened.is_err(), "expected the geometry check to reject it");
}

#[test]
fn zip_lying_uncompressed_size_does_not_panic() {
    // A zip64 extra field claiming `u64::MAX` used to be reserved with
    // `Vec::with_capacity`, aborting with a capacity overflow.
    let name = b"a";
    let mut buf: Vec<u8> = Vec::new();
    buf.extend(b"PK\x03\x04");
    buf.extend(le16(20));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le32(0));
    buf.extend(le32(0));
    buf.extend(le32(0));
    buf.extend(le16(name.len() as u16));
    buf.extend(le16(0));
    buf.extend(name);
    let cd_offset = buf.len() as u32;
    let mut extra: Vec<u8> = Vec::new();
    extra.extend(le16(0x0001));
    extra.extend(le16(24));
    extra.extend(le64(u64::MAX)); // uncompressed_size
    extra.extend(le64(0)); // compressed_size
    extra.extend(le64(0)); // header_start
    buf.extend(b"PK\x01\x02");
    buf.extend(le16(20));
    buf.extend(le16(20));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le32(0)); // crc
    buf.extend(le32(0)); // comp size
    buf.extend(le32(0xFFFF_FFFF)); // uncomp size -> ZIP64 sentinel
    buf.extend(le16(name.len() as u16));
    buf.extend(le16(extra.len() as u16));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le32(0));
    buf.extend(le32(0));
    buf.extend(name);
    buf.extend(&extra);
    let cd_size = buf.len() as u32 - cd_offset;
    buf.extend(b"PK\x05\x06");
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(1));
    buf.extend(le16(1));
    buf.extend(le32(cd_size));
    buf.extend(le32(cd_offset));
    buf.extend(le16(0));

    let archive = afe::zip::ZipArchive::from_bytes("crafted", buf);
    let result = catch_unwind(AssertUnwindSafe(|| archive.read_name("a")));
    let read = result.expect("crafted zip must not panic");
    if let Ok(Some(data)) = read {
        assert!(data.len() < 1024, "unexpected {} byte payload", data.len());
    }
}

#[test]
fn erofs_huge_inode_size_is_rejected() {
    let mut img = erofs_header();
    let ino = 32usize;
    let ifmt: u16 = 1; // version 1 (64-byte inode), datalayout FLAT_PLAIN(0)
    img[ino..ino + 2].copy_from_slice(&ifmt.to_le_bytes());
    img[ino + 4..ino + 6].copy_from_slice(&0x81a4u16.to_le_bytes()); // regular file
    img[ino + 8..ino + 16].copy_from_slice(&u64::MAX.to_le_bytes()); // i_size

    let path = write_temp("erofs_huge_size", &img);
    let image = afe::erofs::ErofsImage::open(path.to_str().unwrap()).expect("open crafted erofs");
    let result = catch_unwind(AssertUnwindSafe(|| image.read_file("/")));
    std::fs::remove_dir_all(path.parent().unwrap()).ok();

    let read = result.expect("crafted erofs must not panic");
    assert!(read.is_err(), "expected the size cap to reject it");
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// Minimal stored (uncompressed) zip with a single entry.
fn make_stored_zip(name: &str, data: &[u8]) -> Vec<u8> {
    let crc = crc32(data);
    let mut buf: Vec<u8> = Vec::new();
    buf.extend(b"PK\x03\x04");
    buf.extend(le16(20));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le32(crc));
    buf.extend(le32(data.len() as u32));
    buf.extend(le32(data.len() as u32));
    buf.extend(le16(name.len() as u16));
    buf.extend(le16(0));
    buf.extend(name.as_bytes());
    buf.extend(data);
    let cd_offset = buf.len() as u32;
    buf.extend(b"PK\x01\x02");
    buf.extend(le16(20));
    buf.extend(le16(20));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le32(crc));
    buf.extend(le32(data.len() as u32));
    buf.extend(le32(data.len() as u32));
    buf.extend(le16(name.len() as u16));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le32(0));
    buf.extend(le32(0));
    buf.extend(name.as_bytes());
    let cd_size = buf.len() as u32 - cd_offset;
    buf.extend(b"PK\x05\x06");
    buf.extend(le16(0));
    buf.extend(le16(0));
    buf.extend(le16(1));
    buf.extend(le16(1));
    buf.extend(le32(cd_size));
    buf.extend(le32(cd_offset));
    buf.extend(le16(0));
    buf
}

#[test]
fn apex_nesting_depth_is_capped() {
    // One level of `original_apex` is real; deep nesting used to recurse until
    // the stack ran out.
    let single = make_stored_zip("original_apex", &make_stored_zip("apex_payload.img", b"x"));
    let path = write_temp("apex_single", &single);
    let dir = path.parent().unwrap().join("single");
    let ok = afe::processor::extract_apex_payload(&path, &dir);
    assert!(ok.is_ok(), "single nesting must still extract: {ok:?}");
    std::fs::remove_dir_all(path.parent().unwrap()).ok();

    let mut payload = make_stored_zip("apex_payload.img", b"x");
    for _ in 0..12 {
        payload = make_stored_zip("original_apex", &payload);
    }
    let path = write_temp("apex_deep", &payload);
    let dir = path.parent().unwrap().join("deep");
    let result = afe::processor::extract_apex_payload(&path, &dir);
    std::fs::remove_dir_all(path.parent().unwrap()).ok();
    let error = result.expect_err("deep nesting must be rejected");
    assert!(
        error.message.contains("nested deeper"),
        "unexpected error: {}",
        error.message
    );
}

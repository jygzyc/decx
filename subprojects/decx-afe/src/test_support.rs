//! Test-only helpers.
//!
//! [`build_ext4_image`] synthesizes a tiny but structurally valid ext4
//! filesystem: a root directory (plus `lost+found`), nested directories, and
//! regular files, so the native reader can be exercised without committing a
//! binary fixture. It builds on the layout of the former TypeScript helper
//! `tests/helpers/ext4-image.ts` but supports `/` in file names and creates
//! the intermediate directory inodes.

use std::path::PathBuf;

const BLOCK_SIZE: usize = 1024;
const FIRST_DATA_BLOCK: u32 = 1;
const INODES_PER_GROUP: u32 = 32;
const INODE_SIZE: u16 = 128;
const INODE_TABLE_BLOCK: usize = 3;
const ROOT_DIR_BLOCK: usize = 7;
const FIRST_DATA_BLOCK_INDEX: usize = 8;

const MODE_DIRECTORY: u16 = 0x4000 | 0o755;
const MODE_REGULAR: u16 = 0x8000 | 0o644;

const EXT4_MAGIC: u16 = 0xef53;
const EXTENT_MAGIC: u16 = 0xf30a;
const FLAG_EXTENTS: u32 = 0x80000;

const DIRENT_FT_REG: u8 = 1;
const DIRENT_FT_DIR: u8 = 2;

fn write_u16(buffer: &mut [u8], offset: usize, value: u16) {
    buffer[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32(buffer: &mut [u8], offset: usize, value: u32) {
    buffer[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

/// One node of the synthesized filesystem tree.
struct Node {
    name: String,
    inode: u32,
    block: usize,
    is_dir: bool,
    content: Vec<u8>,
    children: Vec<Node>,
}

fn directory(name: &str) -> Node {
    Node {
        name: name.to_string(),
        inode: 0,
        block: 0,
        is_dir: true,
        content: Vec::new(),
        children: Vec::new(),
    }
}

fn insert_file(root: &mut Node, path: &str, content: &[u8]) {
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    assert!(!segments.is_empty(), "file path must not be empty");
    let mut current = root;
    for segment in &segments[..segments.len() - 1] {
        if !current.children.iter().any(|child| child.name == *segment) {
            current.children.push(directory(segment));
        }
        current = current
            .children
            .iter_mut()
            .find(|child| child.name == *segment)
            .expect("inserted directory");
    }
    current.children.push(Node {
        name: segments[segments.len() - 1].to_string(),
        inode: 0,
        block: 0,
        is_dir: false,
        content: content.to_vec(),
        children: Vec::new(),
    });
}

fn assign(node: &mut Node, next_inode: &mut u32, next_block: &mut usize) {
    node.inode = *next_inode;
    *next_inode += 1;
    if node.block == 0 {
        if node.name == "/" {
            node.block = ROOT_DIR_BLOCK;
        } else {
            node.block = *next_block;
            *next_block += 1;
        }
    }
    for child in &mut node.children {
        assign(child, next_inode, next_block);
    }
}

fn write_inode(buffer: &mut [u8], node: &Node) {
    let base = INODE_TABLE_BLOCK * BLOCK_SIZE + (node.inode as usize - 1) * INODE_SIZE as usize;
    let mode = if node.is_dir {
        MODE_DIRECTORY
    } else {
        MODE_REGULAR
    };
    let size = if node.is_dir {
        BLOCK_SIZE as u32
    } else {
        node.content.len() as u32
    };
    write_u16(buffer, base, mode);
    write_u32(buffer, base + 4, size);
    write_u32(buffer, base + 32, FLAG_EXTENTS);
    let inode_block = base + 40;
    write_u16(buffer, inode_block, EXTENT_MAGIC);
    write_u16(buffer, inode_block + 2, 1);
    write_u16(buffer, inode_block + 4, 4);
    write_u16(buffer, inode_block + 6, 0);
    write_u32(buffer, inode_block + 12, 0);
    write_u16(buffer, inode_block + 16, 1);
    write_u16(buffer, inode_block + 18, 0);
    write_u32(buffer, inode_block + 20, node.block as u32);
}

fn write_dir_block(buffer: &mut [u8], node: &Node, parent_inode: u32) {
    let base = node.block * BLOCK_SIZE;
    let mut entries: Vec<(u32, u8, String)> = vec![
        (node.inode, DIRENT_FT_DIR, ".".to_string()),
        (parent_inode, DIRENT_FT_DIR, "..".to_string()),
    ];
    for child in &node.children {
        let file_type = if child.is_dir {
            DIRENT_FT_DIR
        } else {
            DIRENT_FT_REG
        };
        entries.push((child.inode, file_type, child.name.clone()));
    }
    let mut offset = 0usize;
    for (index, (inode, file_type, name)) in entries.iter().enumerate() {
        let needed = (8 + name.len()).div_ceil(4) * 4;
        let rec_len = if index == entries.len() - 1 {
            BLOCK_SIZE - offset
        } else {
            needed
        };
        write_u32(buffer, base + offset, *inode);
        write_u16(buffer, base + offset + 4, rec_len as u16);
        buffer[base + offset + 6] = name.len() as u8;
        buffer[base + offset + 7] = *file_type;
        buffer[base + offset + 8..base + offset + 8 + name.len()].copy_from_slice(name.as_bytes());
        offset += rec_len;
    }
}

fn write_tree(buffer: &mut [u8], node: &Node, parent_inode: u32) {
    write_inode(buffer, node);
    if !node.is_dir {
        let base = node.block * BLOCK_SIZE;
        buffer[base..base + node.content.len()].copy_from_slice(&node.content);
        return;
    }
    write_dir_block(buffer, node, parent_inode);
    for child in &node.children {
        write_tree(buffer, child, node.inode);
    }
}

/// Build a structurally valid ext4 image whose root directory holds the
/// given files. `lost+found` is always created like on a real filesystem.
pub fn build_ext4_image(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut root = directory("/");
    root.children.push(directory("lost+found"));
    for (path, content) in files {
        assert!(
            content.len() <= BLOCK_SIZE,
            "test helper supports one block per file"
        );
        insert_file(&mut root, path, content);
    }

    let mut next_inode = 2u32; // inode 1 is the (unused) bad-block inode
    let mut next_block = FIRST_DATA_BLOCK_INDEX;
    assign(&mut root, &mut next_inode, &mut next_block);
    assert!(
        next_inode - 1 <= INODES_PER_GROUP,
        "test helper supports up to {INODES_PER_GROUP} inodes"
    );
    let total_blocks = std::cmp::max(16, next_block);

    let mut buffer = vec![0u8; BLOCK_SIZE * total_blocks];
    let superblock = 1024;
    write_u32(&mut buffer, superblock, INODES_PER_GROUP);
    write_u32(&mut buffer, superblock + 4, total_blocks as u32);
    write_u32(&mut buffer, superblock + 20, FIRST_DATA_BLOCK);
    write_u32(&mut buffer, superblock + 24, 0);
    write_u32(&mut buffer, superblock + 32, total_blocks as u32);
    write_u32(&mut buffer, superblock + 40, INODES_PER_GROUP);
    write_u16(&mut buffer, superblock + 56, EXT4_MAGIC);
    write_u16(&mut buffer, superblock + 88, INODE_SIZE);
    write_u16(&mut buffer, superblock + 256, 32);
    write_u32(&mut buffer, 2 * BLOCK_SIZE + 8, INODE_TABLE_BLOCK as u32);

    write_tree(&mut buffer, &root, root.inode);
    buffer
}

/// Path of the committed EROFS payload fixture.
pub fn erofs_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/apex_payload_erofs.img")
}

/**
 * Synthesized ext4 image used by the APEX integration tests. Mirrors what
 * decx/internal/android/ext4_test.go built in Go: a tiny but structurally
 * valid filesystem with one directory and N regular files, no binary fixture.
 */
export interface Ext4ImageFile {
  name: string;
  content: string;
}

interface Ext4ImageDirEntry {
  inode: number;
  type: number;
  name: string;
}

const BLOCK_SIZE = 1024;
const FIRST_DATA_BLOCK = 1;
const INODES_PER_GROUP = 32;
const INODE_SIZE = 128;
const INODE_TABLE_BLOCK = 3;
const ROOT_INODE = 2;
const FIRST_FILE_INODE = 12;
const ROOT_DIR_BLOCK = 7;
const FIRST_FILE_BLOCK = 8;

const MODE_DIRECTORY = 0x4000 | 0o755;
const MODE_REGULAR = 0x8000 | 0o644;

const EXT4_MAGIC = 0xef53;
const EXTENT_MAGIC = 0xf30a;
const FLAG_EXTENTS = 0x80000;

function writeInode(buffer: Buffer, inode: number, mode: number, size: number, block: number): void {
  const base = INODE_TABLE_BLOCK * BLOCK_SIZE + (inode - 1) * INODE_SIZE;
  buffer.writeUInt16LE(mode, base);
  buffer.writeUInt32LE(size, base + 4);
  buffer.writeUInt32LE(FLAG_EXTENTS, base + 32);
  const inodeBlock = base + 40;
  buffer.writeUInt16LE(EXTENT_MAGIC, inodeBlock);
  buffer.writeUInt16LE(1, inodeBlock + 2);
  buffer.writeUInt16LE(4, inodeBlock + 4);
  buffer.writeUInt16LE(0, inodeBlock + 6);
  buffer.writeUInt32LE(0, inodeBlock + 12);
  buffer.writeUInt16LE(1, inodeBlock + 16);
  buffer.writeUInt16LE(0, inodeBlock + 18);
  buffer.writeUInt32LE(block, inodeBlock + 20);
}

function writeDirBlock(buffer: Buffer, block: number, entries: Ext4ImageDirEntry[]): void {
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

/** Build a valid ext4 image whose root directory holds the given files. */
function buildExt4Image(files: Ext4ImageFile[]): Buffer {
  const totalBlocks = Math.max(16, FIRST_FILE_BLOCK + files.length + 1);
  const buffer = Buffer.alloc(BLOCK_SIZE * totalBlocks);

  const superblock = buffer.subarray(1024, 1024 + 512);
  superblock.writeUInt32LE(INODES_PER_GROUP, 0); // s_inodes_count
  superblock.writeUInt32LE(totalBlocks, 4); // s_blocks_count_lo
  superblock.writeUInt32LE(FIRST_DATA_BLOCK, 20);
  superblock.writeUInt32LE(0, 24); // 1024-byte blocks
  superblock.writeUInt32LE(totalBlocks, 32); // s_blocks_per_group
  superblock.writeUInt32LE(INODES_PER_GROUP, 40);
  superblock.writeUInt16LE(EXT4_MAGIC, 56);
  superblock.writeUInt16LE(INODE_SIZE, 88);
  superblock.writeUInt16LE(32, 256); // s_desc_size

  buffer.writeUInt32LE(INODE_TABLE_BLOCK, 2 * BLOCK_SIZE + 8); // bg_inode_table_lo

  writeInode(buffer, ROOT_INODE, MODE_DIRECTORY, BLOCK_SIZE, ROOT_DIR_BLOCK);

  const entries: Ext4ImageDirEntry[] = [
    { inode: ROOT_INODE, type: 2, name: "." },
    { inode: ROOT_INODE, type: 2, name: ".." },
  ];
  files.forEach((file, index) => {
    const inode = FIRST_FILE_INODE + index;
    const content = Buffer.from(file.content, "utf8");
    writeInode(buffer, inode, MODE_REGULAR, content.length, FIRST_FILE_BLOCK + index);
    content.copy(buffer, (FIRST_FILE_BLOCK + index) * BLOCK_SIZE);
    entries.push({ inode, type: 1, name: file.name });
  });
  writeDirBlock(buffer, ROOT_DIR_BLOCK, entries);
  return buffer;
}

module.exports = { buildExt4Image };

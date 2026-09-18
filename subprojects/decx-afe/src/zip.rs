//! Native zip/jar reader and writer (pure `std`).
//!
//! Replaces the TypeScript `zip-utils.ts`, which shelled out to Info-ZIP
//! `unzip`/`zip` (or Windows `tar.exe`). Frameworks ship dex payloads inside
//! jars, so `afe process` must read zip archives on every host without extra
//! packages; system archivers are no longer part of the pipeline.
//!
//! Reader: central-directory driven, supports `stored` and `deflate`
//! entries plus zip64 sizes/offsets, and verifies the CRC-32 of every entry.
//! Writer: `stored` entries only. Jars produced by `afe pack` are read back
//! by analyzers rather than served over the network, so skipping the
//! compressor keeps the crate dependency-free.

use std::io::Write;
use std::path::Path;

use crate::error::{Error, Result};

const LOCAL_SIG: u32 = 0x0403_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;
const ZIP64_LOCATOR_SIG: u32 = 0x0706_4b50;
const METHOD_STORE: u16 = 0;
const METHOD_DEFLATE: u16 = 8;

fn le16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

fn le32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ])
}

fn le64(data: &[u8], offset: usize) -> u64 {
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&data[offset..offset + 8]);
    u64::from_le_bytes(bytes)
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3), used to verify entries and to write archives.
// ---------------------------------------------------------------------------

fn crc_table() -> &'static [u32; 256] {
    use std::sync::OnceLock;
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (index, slot) in table.iter_mut().enumerate() {
            let mut value = index as u32;
            for _ in 0..8 {
                value = if value & 1 != 0 {
                    (value >> 1) ^ 0xedb8_8320
                } else {
                    value >> 1
                };
            }
            *slot = value;
        }
        table
    })
}

/// CRC-32 of `data`.
pub fn crc32(data: &[u8]) -> u32 {
    let table = crc_table();
    let mut value = 0xffff_ffffu32;
    for byte in data {
        value = (value >> 8) ^ table[((value ^ *byte as u32) & 0xff) as usize];
    }
    value ^ 0xffff_ffff
}

// ---------------------------------------------------------------------------
// Raw DEFLATE (RFC 1951) decompression.
// ---------------------------------------------------------------------------

struct BitReader<'a> {
    data: &'a [u8],
    position: usize,
    accumulator: u32,
    bit_count: u32,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            position: 0,
            accumulator: 0,
            bit_count: 0,
        }
    }

    /// Read `count` bits, LSB first. Bits past the end of the stream read as
    /// zero, like zlib's inflate, so trailing padding never fails decoding.
    fn bits(&mut self, count: u32) -> Result<u32> {
        if count == 0 {
            return Ok(0);
        }
        while self.bit_count < count {
            let byte = if self.position < self.data.len() {
                self.data[self.position]
            } else {
                0
            };
            self.position += 1;
            self.accumulator |= (byte as u32) << self.bit_count;
            self.bit_count += 8;
        }
        let value = self.accumulator & ((1u32 << count) - 1);
        self.accumulator >>= count;
        self.bit_count -= count;
        Ok(value)
    }

    fn align_to_byte(&mut self) {
        let drop = self.bit_count % 8;
        self.accumulator >>= drop;
        self.bit_count -= drop;
    }
}

/// Canonical Huffman decoding table (RFC 1951 section 3.2.2).
struct Huffman {
    counts: [u16; 16],
    symbols: Vec<u16>,
}

impl Huffman {
    fn from_lengths(lengths: &[u8]) -> Result<Huffman> {
        let mut counts = [0u16; 16];
        for &length in lengths {
            if length as usize > 15 {
                return Err(Error::file("invalid deflate code length", None));
            }
            counts[length as usize] += 1;
        }
        counts[0] = 0;
        let mut offsets = [0u16; 16];
        for length in 1..15 {
            offsets[length + 1] = offsets[length] + counts[length];
        }
        let total = offsets[15] as usize + counts[15] as usize;
        let mut symbols = vec![0u16; total];
        for (symbol, &length) in lengths.iter().enumerate() {
            if length != 0 {
                symbols[offsets[length as usize] as usize] = symbol as u16;
                offsets[length as usize] += 1;
            }
        }
        Ok(Huffman { counts, symbols })
    }

    fn decode(&self, reader: &mut BitReader<'_>) -> Result<u16> {
        let mut code: i64 = 0;
        let mut first: i64 = 0;
        let mut index: i64 = 0;
        for length in 1..16 {
            code |= reader.bits(1)? as i64;
            let count = self.counts[length] as i64;
            if code - count < first {
                return Ok(self.symbols[(index + (code - first)) as usize]);
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        Err(Error::file("invalid deflate Huffman code", None))
    }
}

const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];
const CODE_LENGTH_ORDER: [usize; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

fn fixed_literal_huffman() -> Result<Huffman> {
    let mut lengths = vec![0u8; 288];
    for (symbol, length) in lengths.iter_mut().enumerate() {
        *length = match symbol {
            0..=143 => 8,
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    Huffman::from_lengths(&lengths)
}

fn fixed_distance_huffman() -> Result<Huffman> {
    Huffman::from_lengths(&[5u8; 32])
}

fn dynamic_huffman(reader: &mut BitReader<'_>) -> Result<(Huffman, Huffman)> {
    let literal_count = reader.bits(5)? as usize + 257;
    let distance_count = reader.bits(5)? as usize + 1;
    let code_length_count = reader.bits(4)? as usize + 4;
    let mut code_lengths = [0u8; 19];
    for &index in CODE_LENGTH_ORDER.iter().take(code_length_count) {
        code_lengths[index] = reader.bits(3)? as u8;
    }
    let code_length_huffman = Huffman::from_lengths(&code_lengths)?;

    let total = literal_count + distance_count;
    let mut lengths = Vec::with_capacity(total);
    while lengths.len() < total {
        let symbol = code_length_huffman.decode(reader)?;
        match symbol {
            0..=15 => lengths.push(symbol as u8),
            16 => {
                let Some(&previous) = lengths.last() else {
                    return Err(Error::file(
                        "invalid deflate repeat without a previous code",
                        None,
                    ));
                };
                let repeat = 3 + reader.bits(2)? as usize;
                lengths.extend(std::iter::repeat_n(previous, repeat));
            }
            17 => {
                let repeat = 3 + reader.bits(3)? as usize;
                lengths.extend(std::iter::repeat_n(0, repeat));
            }
            18 => {
                let repeat = 11 + reader.bits(7)? as usize;
                lengths.extend(std::iter::repeat_n(0, repeat));
            }
            other => {
                return Err(Error::file(
                    format!("invalid deflate code-length symbol {other}"),
                    None,
                ))
            }
        }
    }
    if lengths.len() > total {
        return Err(Error::file("deflate code overrun", None));
    }
    let literals = Huffman::from_lengths(&lengths[..literal_count])?;
    let distances = Huffman::from_lengths(&lengths[literal_count..])?;
    Ok((literals, distances))
}

fn inflate_block(
    reader: &mut BitReader<'_>,
    literals: &Huffman,
    distances: &Huffman,
    output: &mut Vec<u8>,
) -> Result<()> {
    loop {
        let symbol = literals.decode(reader)?;
        match symbol {
            0..=255 => output.push(symbol as u8),
            256 => return Ok(()),
            257..=285 => {
                let index = symbol as usize - 257;
                let length =
                    LENGTH_BASE[index] as usize + reader.bits(LENGTH_EXTRA[index] as u32)? as usize;
                let distance_symbol = distances.decode(reader)? as usize;
                if distance_symbol >= DIST_BASE.len() {
                    return Err(Error::file("invalid deflate distance code", None));
                }
                let distance = DIST_BASE[distance_symbol] as usize
                    + reader.bits(DIST_EXTRA[distance_symbol] as u32)? as usize;
                if distance == 0 || distance > output.len() {
                    return Err(Error::file("deflate distance beyond output", None));
                }
                let start = output.len() - distance;
                for offset in 0..length {
                    let byte = output[start + offset];
                    output.push(byte);
                }
            }
            other => {
                return Err(Error::file(
                    format!("invalid deflate literal symbol {other}"),
                    None,
                ))
            }
        }
    }
}

/// Decompress a raw DEFLATE stream (no zlib/gzip wrapper).
pub fn inflate_raw(input: &[u8]) -> Result<Vec<u8>> {
    let mut reader = BitReader::new(input);
    let mut output = Vec::new();
    loop {
        let is_final = reader.bits(1)? == 1;
        let block_type = reader.bits(2)?;
        match block_type {
            0 => {
                reader.align_to_byte();
                let length = reader.bits(16)? as usize;
                let complement = reader.bits(16)? as usize;
                if length != (!complement & 0xffff) {
                    return Err(Error::file("invalid deflate stored block length", None));
                }
                for _ in 0..length {
                    output.push(reader.bits(8)? as u8);
                }
            }
            1 => {
                let literals = fixed_literal_huffman()?;
                let distances = fixed_distance_huffman()?;
                inflate_block(&mut reader, &literals, &distances, &mut output)?;
            }
            2 => {
                let (literals, distances) = dynamic_huffman(&mut reader)?;
                inflate_block(&mut reader, &literals, &distances, &mut output)?;
            }
            other => {
                return Err(Error::file(
                    format!("invalid deflate block type {other}"),
                    None,
                ))
            }
        }
        if is_final {
            return Ok(output);
        }
    }
}

// ---------------------------------------------------------------------------
// Reader.
// ---------------------------------------------------------------------------

/// One central-directory entry.
#[derive(Debug, Clone)]
pub struct ZipEntry {
    pub name: String,
    pub method: u16,
    pub crc: u32,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_header_offset: u64,
}

/// In-memory zip archive. Framework payloads are a few hundred megabytes at
/// most, and every operation needs random access, so the file is read once.
pub struct ZipArchive {
    path: String,
    data: Vec<u8>,
}

impl ZipArchive {
    pub fn open(path: &str) -> Result<ZipArchive> {
        let data = std::fs::read(path)
            .map_err(|err| Error::file(format!("Failed to read '{path}': {err}"), Some(path)))?;
        Ok(ZipArchive {
            path: path.to_string(),
            data,
        })
    }

    pub fn from_bytes(path: &str, data: Vec<u8>) -> ZipArchive {
        ZipArchive {
            path: path.to_string(),
            data,
        }
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    /// All entries in central-directory order.
    pub fn entries(&self) -> Result<Vec<ZipEntry>> {
        let data = &self.data;
        if data.len() < 22 {
            return Err(self.malformed("archive is too small to hold an end record"));
        }
        let eocd = self.find_eocd()?;
        let mut count = le16(data, eocd + 10) as u64;
        let mut offset = le32(data, eocd + 16) as u64;

        // zip64: the locator sits directly before the EOCD record.
        if count == 0xffff || offset == 0xffff_ffff {
            if eocd < 20 {
                return Err(self.malformed("zip64 locator is missing"));
            }
            let locator = eocd - 20;
            if le32(data, locator) != ZIP64_LOCATOR_SIG {
                return Err(self.malformed("zip64 locator is missing"));
            }
            let zip64 = le64(data, locator + 8) as usize;
            if zip64 + 56 > data.len() || le32(data, zip64) != ZIP64_EOCD_SIG {
                return Err(self.malformed("zip64 end record is missing"));
            }
            count = le64(data, zip64 + 32);
            offset = le64(data, zip64 + 48);
        }

        let mut entries = Vec::with_capacity(count as usize);
        let mut cursor = offset as usize;
        for _ in 0..count {
            if cursor + 46 > data.len() || le32(data, cursor) != CENTRAL_SIG {
                return Err(self.malformed("invalid central directory entry"));
            }
            let mut method = le16(data, cursor + 10);
            let crc = le32(data, cursor + 16);
            let mut compressed = le32(data, cursor + 20) as u64;
            let mut uncompressed = le32(data, cursor + 24) as u64;
            let name_length = le16(data, cursor + 28) as usize;
            let extra_length = le16(data, cursor + 30) as usize;
            let comment_length = le16(data, cursor + 32) as usize;
            let mut local_offset = le32(data, cursor + 42) as u64;
            let name_start = cursor + 46;
            let name_end = name_start + name_length;
            if name_end > data.len() {
                return Err(self.malformed("central directory name is truncated"));
            }
            let name = String::from_utf8_lossy(&data[name_start..name_end]).to_string();

            // zip64 extra field: present values in the order sizes, offset.
            let extra_start = name_end;
            let extra_end = extra_start + extra_length;
            if extra_end > data.len() {
                return Err(self.malformed("central directory extra field is truncated"));
            }
            let mut extra = extra_start;
            while extra + 4 <= extra_end {
                let id = le16(data, extra);
                let size = le16(data, extra + 2) as usize;
                let body = extra + 4;
                if body + size > extra_end {
                    break;
                }
                if id == 0x0001 {
                    let mut field = body;
                    if uncompressed == 0xffff_ffff && field + 8 <= body + size {
                        uncompressed = le64(data, field);
                        field += 8;
                    }
                    if compressed == 0xffff_ffff && field + 8 <= body + size {
                        compressed = le64(data, field);
                        field += 8;
                    }
                    if local_offset == 0xffff_ffff && field + 8 <= body + size {
                        local_offset = le64(data, field);
                        field += 8;
                    }
                    if method == 0xffff && field + 2 <= body + size {
                        method = le16(data, field);
                    }
                }
                extra = body + size;
            }

            entries.push(ZipEntry {
                name,
                method,
                crc,
                compressed_size: compressed,
                uncompressed_size: uncompressed,
                local_header_offset: local_offset,
            });
            cursor = extra_end + comment_length;
        }
        Ok(entries)
    }

    fn find_eocd(&self) -> Result<usize> {
        let data = &self.data;
        let start = data.len().saturating_sub(22 + 0xffff);
        for position in (start..=data.len() - 22).rev() {
            if le32(data, position) == EOCD_SIG {
                return Ok(position);
            }
        }
        Err(self.malformed("end of central directory record not found"))
    }

    fn malformed(&self, why: &str) -> Error {
        Error::file(
            format!("Failed to read '{}': {why}", self.path),
            Some(&self.path),
        )
    }

    /// Decompress one entry and verify its size and CRC-32.
    pub fn read(&self, entry: &ZipEntry) -> Result<Vec<u8>> {
        let data = &self.data;
        let offset = entry.local_header_offset as usize;
        if offset + 30 > data.len() || le32(data, offset) != LOCAL_SIG {
            return Err(self.malformed(&format!("invalid local header for '{}'", entry.name)));
        }
        let name_length = le16(data, offset + 26) as usize;
        let extra_length = le16(data, offset + 28) as usize;
        let start = offset + 30 + name_length + extra_length;
        let end = start + entry.compressed_size as usize;
        if end > data.len() {
            return Err(self.malformed(&format!("truncated data for '{}'", entry.name)));
        }
        let content = match entry.method {
            METHOD_STORE => data[start..end].to_vec(),
            METHOD_DEFLATE => inflate_raw(&data[start..end])?,
            other => {
                return Err(self.malformed(&format!(
                    "unsupported compression method {other} for '{}'",
                    entry.name
                )))
            }
        };
        if content.len() as u64 != entry.uncompressed_size {
            return Err(self.malformed(&format!(
                "size mismatch for '{}' (expected {}, decoded {})",
                entry.name,
                entry.uncompressed_size,
                content.len()
            )));
        }
        if crc32(&content) != entry.crc {
            return Err(self.malformed(&format!("CRC mismatch for '{}'", entry.name)));
        }
        Ok(content)
    }

    /// Entry names in central-directory order.
    pub fn names(&self) -> Result<Vec<String>> {
        Ok(self
            .entries()?
            .into_iter()
            .map(|entry| entry.name)
            .collect())
    }

    /// Find an entry by exact name.
    pub fn find(&self, name: &str) -> Result<Option<ZipEntry>> {
        Ok(self.entries()?.into_iter().find(|entry| entry.name == name))
    }

    /// Read one entry by exact name.
    pub fn read_name(&self, name: &str) -> Result<Option<Vec<u8>>> {
        match self.find(name)? {
            Some(entry) => Ok(Some(self.read(&entry)?)),
            None => Ok(None),
        }
    }
}
// ---------------------------------------------------------------------------
// Writer.
// ---------------------------------------------------------------------------

/// Encode entries (name, content) as a `stored` zip archive.
pub fn encode_zip(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    let mut count = 0u32;
    for (name, data) in entries {
        let offset = out.len() as u32;
        let crc = crc32(data);
        let size = data.len() as u32;
        let name_bytes = name.as_bytes();
        if name_bytes.len() > u16::MAX as usize || data.len() > u32::MAX as usize {
            return Err(Error::file(
                format!("zip entry '{name}' is too large for the stored writer"),
                None,
            ));
        }

        out.extend_from_slice(&LOCAL_SIG.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
        out.extend_from_slice(&METHOD_STORE.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // time
        out.extend_from_slice(&0x0021u16.to_le_bytes()); // date: 1980-01-01
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra length
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);

        central.extend_from_slice(&CENTRAL_SIG.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&METHOD_STORE.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // time
        central.extend_from_slice(&0x0021u16.to_le_bytes()); // date
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra length
        central.extend_from_slice(&0u16.to_le_bytes()); // comment length
        central.extend_from_slice(&0u16.to_le_bytes()); // disk number
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
        central.extend_from_slice(&0u32.to_le_bytes()); // external attributes
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name_bytes);
        count += 1;
    }

    let central_offset = out.len() as u32;
    let central_size = central.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&EOCD_SIG.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // this disk
    out.extend_from_slice(&0u16.to_le_bytes()); // central directory disk
    out.extend_from_slice(&(count as u16).to_le_bytes());
    out.extend_from_slice(&(count as u16).to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment length
    Ok(out)
}

/// Write a zip archive from paths relative to `cwd`. Directory entries are
/// stored with a trailing slash, matching the entries `zip -r` emitted for
/// the framework jar.
fn collect_archive_records(
    archive_path: &str,
    cwd: &Path,
    name: &str,
    records: &mut Vec<(String, Vec<u8>)>,
) -> Result<()> {
    let source = cwd.join(name);
    let io_error = |err: std::io::Error| {
        Error::file(
            format!("Failed to create '{archive_path}': {err}"),
            Some(archive_path),
        )
    };
    if source.is_dir() {
        records.push((format!("{}/", name.trim_end_matches('/')), Vec::new()));
        let mut children: Vec<String> = std::fs::read_dir(&source)
            .map_err(io_error)?
            .map(|entry| entry.map(|value| value.file_name().to_string_lossy().to_string()))
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(io_error)?;
        children.sort();
        for child in children {
            collect_archive_records(
                archive_path,
                cwd,
                &format!("{}/{child}", name.trim_end_matches('/')),
                records,
            )?;
        }
        return Ok(());
    }
    let content = std::fs::read(&source).map_err(io_error)?;
    records.push((name.to_string(), content));
    Ok(())
}

pub fn create_zip_archive(archive_path: &str, entries: &[String], cwd: &Path) -> Result<()> {
    let target = Path::new(archive_path);
    if target.exists() {
        std::fs::remove_file(target).map_err(|err| {
            Error::file(
                format!("Failed to create '{archive_path}': {err}"),
                Some(archive_path),
            )
        })?;
    }
    // Directory names are expanded recursively like bsdtar/zip do, so a
    // staging directory containing META-INF/ also archives its manifest.
    let mut records = Vec::new();
    for name in entries {
        collect_archive_records(archive_path, cwd, name, &mut records)?;
    }
    let blob = encode_zip(&records)?;
    let mut file = std::fs::File::create(target).map_err(|err| {
        Error::file(
            format!("Failed to create '{archive_path}': {err}"),
            Some(archive_path),
        )
    })?;
    file.write_all(&blob).map_err(|err| {
        Error::file(
            format!("Failed to create '{archive_path}': {err}"),
            Some(archive_path),
        )
    })
}

// ---------------------------------------------------------------------------
// CLI-facing helpers (TS `zip-utils.ts` surface).
// ---------------------------------------------------------------------------

/// Entry names of an archive (TS `listZipEntries`).
pub fn list_zip_entries(archive_path: &str) -> Result<Vec<String>> {
    ZipArchive::open(archive_path)?.names()
}

/// Read one entry as text (TS `readZipEntryText`).
pub fn read_zip_entry_text(archive_path: &str, entry_name: &str) -> Result<String> {
    let bytes = read_zip_entry_bytes(archive_path, entry_name)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn read_zip_entry_bytes(archive_path: &str, entry_name: &str) -> Result<Vec<u8>> {
    let archive = ZipArchive::open(archive_path)?;
    match archive.read_name(entry_name)? {
        Some(bytes) => Ok(bytes),
        None => Err(Error::file(
            format!("Failed to read '{entry_name}' from {archive_path}: no such entry"),
            Some(archive_path),
        )),
    }
}

/// Extract one entry into `target` (TS `extractZipEntry`). The partially
/// written file is removed when reading or writing fails.
pub fn extract_zip_entry(archive_path: &str, entry_name: &str, target: &str) -> Result<()> {
    let bytes = read_zip_entry_bytes(archive_path, entry_name)?;
    if let Some(parent) = Path::new(target).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|err| {
                Error::file(
                    format!("Failed to read '{entry_name}' from {archive_path}: {err}"),
                    Some(archive_path),
                )
            })?;
        }
    }
    std::fs::write(target, &bytes).map_err(|err| {
        let _ = std::fs::remove_file(target);
        Error::file(
            format!("Failed to read '{entry_name}' from {archive_path}: {err}"),
            Some(archive_path),
        )
    })
}

/// Write the whole archive (used by the packer through `create_zip_archive`).
pub fn write_zip_file(archive_path: &str, entries: &[(String, Vec<u8>)]) -> Result<()> {
    let blob = encode_zip(entries)?;
    std::fs::write(archive_path, &blob).map_err(|err| {
        Error::file(
            format!("Failed to create '{archive_path}': {err}"),
            Some(archive_path),
        )
    })
}

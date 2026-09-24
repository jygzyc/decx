//! Zip/jar containers, backed by well-tested crates: the `zip` crate parses
//! and reads archives (central directory, zip64, stored/deflate entries),
//! `flate2` provides the raw DEFLATE decoder used by [`inflate_raw`] for
//! streams that are not embedded in a zip container, and `crc32fast`
//! computes the checksums this module exposes.

use std::cell::RefCell;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::Path;

use flate2::read::DeflateDecoder;
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::error::{io_error, Error};

/// Metadata for one central-directory entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntry {
    pub name: String,
    pub method: u16,
    pub crc: u32,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_header_offset: u64,
}

/// A read-only zip archive opened from memory or from disk.
///
/// The archive is parsed once, when it is opened; [`ZipArchive::entries`] and
/// friends report the parse failure if the bytes were not a valid zip.
pub struct ZipArchive {
    label: String,
    parsed: RefCell<Option<zip::ZipArchive<Cursor<Vec<u8>>>>>,
    parse_error: Option<String>,
}

impl ZipArchive {
    /// Open an archive from disk and parse its central directory.
    pub fn open(path: &str) -> Result<Self, Error> {
        let bytes = fs::read(path).map_err(|err| io_error(&format!("read '{path}'"), err))?;
        Ok(Self::from_bytes(path, bytes))
    }

    /// Wrap an in-memory archive. Invalid data is reported by [`Self::entries`].
    pub fn from_bytes(label: &str, bytes: Vec<u8>) -> Self {
        match zip::ZipArchive::new(Cursor::new(bytes)) {
            Ok(archive) => ZipArchive {
                label: label.to_string(),
                parsed: RefCell::new(Some(archive)),
                parse_error: None,
            },
            Err(err) => ZipArchive {
                label: label.to_string(),
                parsed: RefCell::new(None),
                parse_error: Some(err.to_string()),
            },
        }
    }

    /// Path or in-memory label this archive was opened with.
    pub fn path(&self) -> &str {
        &self.label
    }

    /// All entries in central-directory order.
    pub fn entries(&self) -> Result<Vec<ZipEntry>, Error> {
        self.with_archive(|archive| {
            // Central-directory entry counts are attacker-controlled: grow the
            // list as entries are parsed instead of reserving from the count.
            let mut entries = Vec::new();
            for index in 0..archive.len() {
                let file = archive
                    .by_index_raw(index)
                    .map_err(|err| self.zip_error(None, err))?;
                entries.push(entry_from(&file));
            }
            Ok(entries)
        })
    }

    /// All entry names in central-directory order, directories included.
    pub fn names(&self) -> Result<Vec<String>, Error> {
        self.with_archive(|archive| Ok(archive.file_names().map(str::to_string).collect()))
    }

    /// Metadata for `name`, if the archive contains it.
    pub fn find(&self, name: &str) -> Result<Option<ZipEntry>, Error> {
        self.with_archive(|archive| {
            let Some(index) = archive.index_for_name(name) else {
                return Ok(None);
            };
            let file = archive
                .by_index_raw(index)
                .map_err(|err| self.zip_error(Some(name), err))?;
            Ok(Some(entry_from(&file)))
        })
    }

    /// Decompressed payload of `entry`.
    pub fn read(&self, entry: &ZipEntry) -> Result<Vec<u8>, Error> {
        match self.read_name(&entry.name)? {
            Some(data) => Ok(data),
            None => Err(self.no_entry(&entry.name)),
        }
    }

    /// Decompressed payload of `name`; `None` when the entry is absent.
    pub fn read_name(&self, name: &str) -> Result<Option<Vec<u8>>, Error> {
        self.with_archive(|archive| {
            let Some(index) = archive.index_for_name(name) else {
                return Ok(None);
            };
            // The `zip` crate refuses unsupported methods while opening the
            // reader; report the numeric method so the caller knows what the
            // archive asked for.
            let method = archive
                .by_index_raw(index)
                .ok()
                .map(|raw| method_code(raw.compression()));
            let mut file = match archive.by_index(index) {
                Ok(file) => file,
                Err(ZipError::FileNotFound) => return Ok(None),
                Err(err) => return Err(self.method_error(name, method, err)),
            };
            // The size in the central directory is untrusted: never reserve
            // from it (a lying size used to abort the process with a capacity
            // overflow). Grow as bytes actually arrive instead.
            let mut data = Vec::new();
            file.read_to_end(&mut data).map_err(|err| {
                if err.to_string().contains("Invalid checksum") {
                    self.bad_checksum(name)
                } else {
                    Error::file(
                        format!("Failed to read '{name}' from '{}': {err}", self.label),
                        Some(&self.label),
                    )
                }
            })?;
            Ok(Some(data))
        })
    }

    fn with_archive<T>(
        &self,
        action: impl FnOnce(&mut zip::ZipArchive<Cursor<Vec<u8>>>) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let mut guard = self.parsed.borrow_mut();
        match guard.as_mut() {
            Some(archive) => action(archive),
            None => Err(self.parse_failure()),
        }
    }

    fn parse_failure(&self) -> Error {
        let detail = self.parse_error.as_deref().unwrap_or("invalid zip archive");
        Error::file(
            format!("Failed to read '{}': {detail}", self.label),
            Some(&self.label),
        )
    }

    fn zip_error(&self, name: Option<&str>, err: ZipError) -> Error {
        let what = match name {
            Some(name) => format!("entry '{name}'"),
            None => "archive".to_string(),
        };
        Error::file(
            format!("Failed to read {what} from '{}': {err}", self.label),
            Some(&self.label),
        )
    }

    fn method_error(&self, name: &str, method: Option<u16>, err: ZipError) -> Error {
        match (err, method) {
            (ZipError::UnsupportedArchive(_), Some(method)) => Error::file(
                format!(
                    "unsupported compression method {method} for '{name}' in '{}'",
                    self.label
                ),
                Some(&self.label),
            ),
            (err, _) => self.zip_error(Some(name), err),
        }
    }

    fn no_entry(&self, name: &str) -> Error {
        Error::file(
            format!("no such entry '{name}' in '{}'", self.label),
            Some(&self.label),
        )
    }

    fn bad_checksum(&self, name: &str) -> Error {
        Error::file(
            format!("CRC mismatch in '{name}' inside '{}'", self.label),
            Some(&self.label),
        )
    }
}

fn entry_from(file: &zip::read::ZipFile<'_>) -> ZipEntry {
    ZipEntry {
        name: file.name().to_string(),
        method: method_code(file.compression()),
        crc: file.crc32(),
        compressed_size: file.compressed_size(),
        uncompressed_size: file.size(),
        local_header_offset: file.header_start(),
    }
}

#[allow(deprecated)]
fn method_code(method: CompressionMethod) -> u16 {
    match method {
        CompressionMethod::Stored => 0,
        CompressionMethod::Deflated => 8,
        CompressionMethod::Unsupported(code) => code,
        // Only the `deflate` feature is enabled, so the `zip` crate reports
        // every other method as `Unsupported`; keep a sane fallback for any
        // future feature we may enable.
        _ => 0,
    }
}

fn stored_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .last_modified_time(zip::DateTime::default())
}

fn deflated_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::default())
}

/// CRC-32 (IEEE) checksum, as stored in zip headers.
pub fn crc32(data: &[u8]) -> u32 {
    crc32fast::hash(data)
}

/// Inflate a raw DEFLATE stream (no zlib/gzip wrapper).
pub fn inflate_raw(input: &[u8]) -> Result<Vec<u8>, Error> {
    let mut decoder = DeflateDecoder::new(input);
    let mut output = Vec::new();
    decoder
        .read_to_end(&mut output)
        .map_err(|err| Error::file(format!("Failed to inflate deflate stream: {err}"), None))?;
    Ok(output)
}

/// Build an in-memory zip holding `entries` as stored (uncompressed) members.
pub fn encode_zip(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>, Error> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in entries {
        writer
            .start_file(name.as_str(), stored_options())
            .map_err(|err| Error::file(format!("Failed to write '{name}': {err}"), None))?;
        writer
            .write_all(data)
            .map_err(|err| Error::file(format!("Failed to write '{name}': {err}"), None))?;
    }
    let cursor = writer
        .finish()
        .map_err(|err| Error::file(format!("Failed to finish zip archive: {err}"), None))?;
    Ok(cursor.into_inner())
}

/// Write a zip containing `names` (relative to `cwd`); directories are
/// expanded recursively and recorded with a trailing slash, regular files are
/// deflated (packed `out.jar` must stay compressible: a stored-only archive is
/// about 2.5x bigger than the compressed one the Python implementation wrote).
pub fn create_zip_archive(archive_path: &str, names: &[String], cwd: &Path) -> Result<(), Error> {
    let file = File::create(archive_path)
        .map_err(|err| io_error(&format!("create '{archive_path}'"), err))?;
    let mut writer = zip::ZipWriter::new(file);
    let mut seen = HashSet::new();
    for name in names {
        add_zip_entry(&mut writer, &cwd.join(name), name, &mut seen)?;
    }
    writer
        .finish()
        .map_err(|err| zip_write_error(&format!("write '{archive_path}'"), err))?;
    Ok(())
}

fn add_zip_entry(
    writer: &mut zip::ZipWriter<File>,
    source: &Path,
    name: &str,
    seen: &mut HashSet<String>,
) -> Result<(), Error> {
    let metadata = fs::metadata(source)
        .map_err(|err| io_error(&format!("stat '{}'", source.display()), err))?;
    if metadata.is_dir() {
        let directory_name = format!("{name}/");
        if seen.insert(directory_name.clone()) {
            writer
                .add_directory(directory_name.as_str(), stored_options())
                .map_err(|err| zip_write_error(&format!("write '{directory_name}'"), err))?;
        }
        let mut children = Vec::new();
        for child in fs::read_dir(source)
            .map_err(|err| io_error(&format!("read dir '{}'", source.display()), err))?
        {
            let child =
                child.map_err(|err| io_error(&format!("read dir '{}'", source.display()), err))?;
            children.push(child.path());
        }
        children.sort();
        for child in children {
            let Some(file_name) = child.file_name().and_then(|value| value.to_str()) else {
                return Err(Error::file(
                    format!("non-UTF-8 file name under '{}'", source.display()),
                    None,
                ));
            };
            add_zip_entry(writer, &child, &format!("{name}/{file_name}"), seen)?;
        }
        return Ok(());
    }
    if !seen.insert(name.to_string()) {
        return Ok(());
    }
    writer
        .start_file(name, deflated_options())
        .map_err(|err| zip_write_error(&format!("write '{name}'"), err))?;
    let data =
        fs::read(source).map_err(|err| io_error(&format!("read '{}'", source.display()), err))?;
    writer
        .write_all(&data)
        .map_err(|err| io_error(&format!("write '{name}'"), err))
}

fn zip_write_error(context: &str, err: ZipError) -> Error {
    Error::file(format!("{context}: {err}"), None)
}

/// Entry names of an archive on disk, in central-directory order.
pub fn list_zip_entries(archive_path: &str) -> Result<Vec<String>, Error> {
    ZipArchive::open(archive_path)?.names()
}

/// Read one entry of an archive on disk as UTF-8 text.
pub fn read_zip_entry_text(archive_path: &str, name: &str) -> Result<String, Error> {
    let archive = ZipArchive::open(archive_path)?;
    let data = archive
        .read_name(name)?
        .ok_or_else(|| archive.no_entry(name))?;
    String::from_utf8(data).map_err(|err| {
        Error::file(
            format!("entry '{name}' in '{archive_path}' is not UTF-8 text: {err}"),
            Some(archive_path),
        )
    })
}

/// Extract one entry of an archive on disk to `target`.
pub fn extract_zip_entry(archive_path: &str, name: &str, target: &str) -> Result<(), Error> {
    let archive = ZipArchive::open(archive_path)?;
    let data = archive
        .read_name(name)?
        .ok_or_else(|| archive.no_entry(name))?;
    let target_path = Path::new(target);
    if let Some(parent) = target_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|err| io_error(&format!("create dir '{}'", parent.display()), err))?;
        }
    }
    fs::write(target_path, data).map_err(|err| io_error(&format!("write '{target}'"), err))
}

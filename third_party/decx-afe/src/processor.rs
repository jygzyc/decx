//! Framework source processing: expands jars/apks and APEX images into the
//! set of dex files packed into the framework jar. Port of the TypeScript
//! `framework-processor.ts`.
//!
//! APEX payload images are read natively ([`crate::ext4`], [`crate::erofs`]);
//! there is no external extractor left, so an image the native readers reject
//! fails its input with the reader's error.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::collector::{extname_posix, remote_module};
use crate::erofs::ErofsImage;
use crate::error::{io_error, Error, Result};
use crate::ext4::Ext4Image;
use crate::hash::sha256_prefix8;
use crate::layout::{is_drive_relative_name, mkdtemp, FrameworkLayout};
use crate::zip::{extract_zip_entry, list_zip_entries, ZipArchive};

const SUPPORTED_INPUT_EXTENSIONS: [&str; 5] = [".jar", ".apk", ".dex", ".apex", ".capex"];
const APEX_CONTENT_EXTENSIONS: [&str; 3] = [".jar", ".apk", ".dex"];

pub const FILESYSTEM_EROFS: &str = "erofs";
pub const FILESYSTEM_EXT4: &str = "ext4";
pub const FILESYSTEM_EXT2: &str = "ext2";

/// Per-input processing failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessFailure {
    pub path: String,
    pub error: String,
}

/// Counters and outputs returned by [`process_framework`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcessResult {
    pub processed: u64,
    /// Output names produced by more than one input; the later input wins.
    pub duplicates: u64,
    pub outputs: Vec<PathBuf>,
    pub failures: Vec<ProcessFailure>,
}

impl ProcessResult {
    pub fn to_json(&self) -> Value {
        json!({
            "processed": self.processed,
            "duplicates": self.duplicates,
            "outputs": self
                .outputs
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>(),
            "failures": self
                .failures
                .iter()
                .map(|failure| json!({ "path": failure.path, "error": failure.error }))
                .collect::<Vec<_>>(),
        })
    }
}

/// `path.extname(path).toLowerCase()`.
pub fn extension_lower(path: &Path) -> String {
    path.file_name()
        .map(|name| extname_posix(&name.to_string_lossy()).to_ascii_lowercase())
        .unwrap_or_default()
}

/// Basename without its extension.
pub fn file_stem_name(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let extension = extname_posix(&name);
    name[..name.len() - extension.len()].to_string()
}

fn extension_of_str(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    extname_posix(base).to_ascii_lowercase()
}

/// Relative path with forward slashes (the TS code splits and joins on
/// `path.sep` after `path.relative`).
fn relative_slash(root: &Path, file: &Path) -> String {
    file.strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn is_supported_framework_input(file_path: &Path) -> bool {
    let extension = extension_lower(file_path);
    SUPPORTED_INPUT_EXTENSIONS.contains(&extension.as_str())
}

/// Regular files under `root` with a supported extension, sorted.
pub fn walk_framework_inputs(root: &Path) -> Result<Vec<PathBuf>> {
    if !root.exists() {
        return Err(Error::file(
            format!("no such directory: {}", root.display()),
            Some(&root.to_string_lossy()),
        ));
    }
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|err| io_error(&format!("read directory '{}'", dir.display()), err))?;
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let full = entry.path();
            if kind.is_dir() {
                stack.push(full);
                continue;
            }
            if kind.is_file() && is_supported_framework_input(&full) {
                files.push(full);
            }
        }
    }
    files.sort();
    Ok(files)
}

/// Extracts every `*.dex` entry from a jar/apk into `target_dir`, namespaced
/// with `prefix`.
pub fn extract_dex_from_zip(
    package_path: &Path,
    target_dir: &Path,
    prefix: &str,
) -> Result<Vec<PathBuf>> {
    std::fs::create_dir_all(target_dir)
        .map_err(|err| io_error(&format!("create '{}'", target_dir.display()), err))?;
    let package = package_path.to_string_lossy().to_string();
    let archive = ZipArchive::open(&package)?;
    let mut written = Vec::new();
    for entry in archive.names()? {
        if !entry.to_ascii_lowercase().ends_with(".dex") {
            continue;
        }
        // Split on both separators: a backslash in an entry name is a path
        // separator on Windows, where it would escape the target directory.
        let mut name = entry
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&entry)
            .to_string();
        if name.is_empty() || name == "." || name == ".." || is_drive_relative_name(&name) {
            name = sha256_prefix8(entry.as_bytes());
        }
        // Include a path digest for non-root entries so two nested
        // classes.dex files cannot silently overwrite each other.
        if entry.trim_matches(['/', '\\']).contains(['/', '\\']) {
            name = format!("{}_{}", sha256_prefix8(entry.as_bytes()), name);
        }
        let target = target_dir.join(format!("{prefix}_{name}"));
        if target.exists() {
            return Err(Error::file(
                format!("dex output collision at '{}'", target.display()),
                Some(&package),
            ));
        }
        archive.extract_name(&entry, &target)?;
        written.push(target);
    }
    Ok(written)
}

/// Payload kind from the superblock magic: EROFS at 1024, ext4 at 1080.
pub fn detect_filesystem_type(image_path: &Path) -> Result<&'static str> {
    let header = read_image_header(image_path)?;
    if header.len() >= 1028
        && header[1024] == 0xe2
        && header[1025] == 0xe1
        && header[1026] == 0xf5
        && header[1027] == 0xe0
    {
        return Ok(FILESYSTEM_EROFS);
    }
    if header.len() >= 1082 && header[1080] == 0x53 && header[1081] == 0xef {
        return Ok(FILESYSTEM_EXT4);
    }
    Ok(FILESYSTEM_EXT2)
}

fn read_image_header(image_path: &Path) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(image_path)
        .map_err(|err| io_error(&format!("open '{}'", image_path.display()), err))?;
    let mut header = vec![0u8; 1082];
    let mut total = 0usize;
    while total < header.len() {
        let read = file
            .read(&mut header[total..])
            .map_err(|err| io_error(&format!("read '{}'", image_path.display()), err))?;
        if read == 0 {
            break;
        }
        total += read;
    }
    header.truncate(total);
    Ok(header)
}

/// Nested `original_apex` containers are unwrapped at most this deep; a real
/// device nests once, so anything deeper is a malformed or hostile container.
const MAX_APEX_NESTING: u32 = 8;

/// Writes `apex_payload.img` from an `.apex` container into `target_dir` and
/// returns its path. Nested `original_apex` containers are unwrapped first.
pub fn extract_apex_payload(apex_file: &Path, target_dir: &Path) -> Result<PathBuf> {
    extract_apex_payload_at(apex_file, target_dir, 0)
}

fn extract_apex_payload_at(apex_file: &Path, target_dir: &Path, depth: u32) -> Result<PathBuf> {
    if depth > MAX_APEX_NESTING {
        let label = apex_file.to_string_lossy().to_string();
        return Err(Error::file(
            format!("apex container nested deeper than {MAX_APEX_NESTING} levels"),
            Some(&label),
        ));
    }
    std::fs::create_dir_all(target_dir)
        .map_err(|err| io_error(&format!("create '{}'", target_dir.display()), err))?;
    let container = apex_file.to_string_lossy().to_string();
    let names = list_zip_entries(&container)?;
    if names.iter().any(|name| name == "original_apex") {
        // Distinct paths per level: streaming extraction must never truncate
        // the archive it is currently reading.
        let nested = target_dir.join(format!("original-{depth}.apex"));
        extract_zip_entry(&container, "original_apex", &nested.to_string_lossy())?;
        return extract_apex_payload_at(&nested, target_dir, depth + 1);
    }
    if !names.iter().any(|name| name == "apex_payload.img") {
        return Err(Error::file(
            format!("no apex_payload.img found in {container}"),
            Some(&container),
        ));
    }
    let payload = target_dir.join("apex_payload.img");
    extract_zip_entry(&container, "apex_payload.img", &payload.to_string_lossy())?;
    Ok(payload)
}

/// Extracts one APEX payload image (ext4 or EROFS) into `extract_dir`.
/// Extraction is native only: an image that is neither ext4 nor EROFS, or that
/// uses a feature the native readers do not implement, fails the input instead
/// of falling back to `debugfs` / `erofs-utils`.
pub fn extract_payload_image(
    image_path: &Path,
    extract_dir: &Path,
    filter: &dyn Fn(&str) -> bool,
) -> Result<()> {
    let image_path_string = image_path.to_string_lossy().to_string();
    let extract_dir_string = extract_dir.to_string_lossy().to_string();
    match detect_filesystem_type(image_path)? {
        FILESYSTEM_EXT4 => {
            let image = Ext4Image::open(&image_path_string)
                .map_err(|err| Error::file(err.to_string(), Some(&image_path_string)))?;
            let outcome = (|| -> Result<()> {
                std::fs::create_dir_all(extract_dir)
                    .map_err(|err| io_error(&format!("create '{}'", extract_dir.display()), err))?;
                image
                    .extract_to(&extract_dir_string, filter)
                    .map_err(|err| Error::file(err.to_string(), Some(&image_path_string)))
            })();
            image.close();
            outcome
        }
        FILESYSTEM_EROFS => {
            let image = ErofsImage::open(&image_path_string)
                .map_err(|err| Error::file(err.to_string(), Some(&image_path_string)))?;
            let outcome = (|| -> Result<()> {
                std::fs::create_dir_all(extract_dir)
                    .map_err(|err| io_error(&format!("create '{}'", extract_dir.display()), err))?;
                image
                    .extract_to(&extract_dir_string, filter)
                    .map_err(|err| Error::file(err.to_string(), Some(&image_path_string)))
            })();
            image.close();
            outcome
        }
        other => Err(Error::file(
            format!("unsupported payload image: {other} is neither ext4 nor EROFS"),
            Some(&image_path_string),
        )),
    }
}

/// Expands one `.apex`/`.capex` input into dex outputs inside `work_dir`.
/// Every output is namespaced with `prefix` so modules shipping same-named
/// jars cannot overwrite each other.
pub fn process_apex(apex_file: &Path, work_dir: &Path, prefix: &str) -> Result<()> {
    let apex_dir = work_dir.join(format!("apex-{}", file_stem_name(apex_file)));
    let payload_dir = apex_dir.join("payload");
    let payload = extract_apex_payload(apex_file, &apex_dir)?;
    let nested_filter =
        |relative: &str| APEX_CONTENT_EXTENSIONS.contains(&extension_of_str(relative).as_str());
    extract_payload_image(&payload, &payload_dir, &nested_filter)?;
    for nested in walk_framework_inputs(&payload_dir)? {
        let extension = extension_lower(&nested);
        // APEX payloads can contain same-named containers in different
        // directories. Include their relative path in the namespace.
        let relative = relative_slash(&payload_dir, &nested);
        let namespace = format!("{prefix}_{}", sha256_prefix8(relative.as_bytes()));
        if extension == ".jar" || extension == ".apk" {
            let stem = file_stem_name(&nested);
            extract_dex_from_zip(&nested, work_dir, &format!("{namespace}_{stem}"))?;
            continue;
        }
        if extension == ".dex" {
            let name = nested
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            let target = work_dir.join(format!("{namespace}_{name}"));
            if target.exists() {
                return Err(Error::file(
                    format!("dex output collision at '{}'", target.display()),
                    Some(&nested.to_string_lossy()),
                ));
            }
            std::fs::copy(&nested, &target)
                .map_err(|err| io_error(&format!("copy '{}'", target.display()), err))?;
        }
    }
    Ok(())
}

/// Expands every supported source file into a staging directory and swaps it
/// in as the layout's `out_tmp_dir`. Nothing is replaced unless every input
/// processed, so a failed run keeps the previous output.
pub fn process_framework(layout: &FrameworkLayout) -> Result<ProcessResult> {
    let mut result = ProcessResult::default();
    let files = walk_framework_inputs(&layout.source_dir)?;
    if files.is_empty() {
        return Err(Error::file(
            "no supported framework inputs found",
            Some(&layout.source_dir.to_string_lossy()),
        ));
    }
    let staging = mkdtemp(&layout.out_dir, ".process-")
        .map_err(|err| io_error(&format!("create '{}'", layout.out_dir.display()), err))?;

    let outcome = (|| -> Result<()> {
        for file in &files {
            let relative = relative_slash(&layout.source_dir, file);
            let extension = extension_lower(file);
            let stem = file_stem_name(file);
            let module = remote_module(&relative);
            let prefix = if module.is_empty() {
                stem
            } else {
                format!("{module}_{stem}")
            };

            let work = mkdtemp(&layout.out_dir, ".input-")
                .map_err(|err| io_error(&format!("create '{}'", layout.out_dir.display()), err))?;
            let step = (|| -> Result<u64> {
                match extension.as_str() {
                    ".dex" => {
                        let target = work.join(format!("{prefix}.dex"));
                        std::fs::copy(file, &target).map_err(|err| {
                            io_error(&format!("copy '{}'", target.display()), err)
                        })?;
                    }
                    ".jar" | ".apk" => {
                        extract_dex_from_zip(file, &work, &prefix)?;
                    }
                    _ => process_apex(file, &work, &prefix)?,
                }
                let mut names: Vec<String> = std::fs::read_dir(&work)
                    .map_err(|err| io_error(&format!("read directory '{}'", work.display()), err))?
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .collect();
                names.sort();
                let mut duplicates = 0_u64;
                for name in names {
                    let source = work.join(&name);
                    if !source.is_file() {
                        continue;
                    }
                    let destination = staging.join(&name);
                    if destination.exists() {
                        // The TypeScript CLI let the later input win: the same
                        // output name legitimately comes from two paths when a
                        // module was captured more than once (a runtime
                        // `/apex/<module>@<version>` tree and its image, say).
                        // Overwrite and count it instead of failing the run.
                        duplicates += 1;
                    }
                    std::fs::copy(&source, &destination).map_err(|err| {
                        io_error(&format!("copy '{}'", destination.display()), err)
                    })?;
                }
                Ok(duplicates)
            })();
            let _ = std::fs::remove_dir_all(&work);
            match step {
                Ok(duplicates) => {
                    result.processed += 1;
                    result.duplicates += duplicates;
                }
                Err(err) => result.failures.push(ProcessFailure {
                    path: file.to_string_lossy().to_string(),
                    error: err.message,
                }),
            }
        }

        if !result.failures.is_empty() {
            let failures = result
                .failures
                .iter()
                .map(|failure| json!({ "path": failure.path, "error": failure.error }))
                .collect::<Vec<_>>();
            return Err(Error::new(
                "PROCESS_FAILED",
                format!(
                    "{} framework inputs failed; previous output retained",
                    result.failures.len()
                ),
            )
            .detail("failures", Value::Array(failures)));
        }

        let previous = PathBuf::from(format!("{}.previous", layout.out_tmp_dir.to_string_lossy()));
        if previous.exists() {
            return Err(Error::file(
                format!("recovery directory exists: {}", previous.display()),
                Some(&previous.to_string_lossy()),
            ));
        }
        let mut had_old = false;
        if layout.out_tmp_dir.exists() {
            std::fs::rename(&layout.out_tmp_dir, &previous).map_err(|err| {
                io_error(
                    &format!(
                        "rename '{}' to '{}'",
                        layout.out_tmp_dir.display(),
                        previous.display()
                    ),
                    err,
                )
            })?;
            had_old = true;
        }
        if let Err(err) = std::fs::rename(&staging, &layout.out_tmp_dir) {
            if had_old {
                let _ = std::fs::rename(&previous, &layout.out_tmp_dir);
            }
            return Err(io_error(
                &format!("rename '{}'", layout.out_tmp_dir.display()),
                err,
            ));
        }
        if had_old {
            let _ = std::fs::remove_dir_all(&previous);
        }

        result.outputs = walk_framework_inputs(&layout.out_tmp_dir)?;
        Ok(())
    })();

    let _ = std::fs::remove_dir_all(&staging);
    outcome.map(|()| result)
}

/// Number of regular files under `root` (used for the pack file count).
pub fn count_framework_files(root: &Path) -> u64 {
    let mut count = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                count += 1;
            }
        }
    }
    count
}

/// Removes intermediate processing state and optionally the collected
/// sources.
pub fn clean_framework_outputs(layout: &FrameworkLayout, clean_source: bool) -> Result<()> {
    clean_framework_output(layout)?;
    if clean_source {
        clean_framework_source(layout)?;
    }
    Ok(())
}

/// Remove the previous processed output directory (`out_tmp`) only.
pub fn clean_framework_output(layout: &FrameworkLayout) -> Result<()> {
    match std::fs::remove_dir_all(&layout.out_tmp_dir) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(io_error(
                &format!("remove '{}'", layout.out_tmp_dir.display()),
                err,
            ))
        }
    }
    Ok(())
}

/// Remove the collected source tree only.
pub fn clean_framework_source(layout: &FrameworkLayout) -> Result<()> {
    match std::fs::remove_dir_all(&layout.source_dir) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(io_error(
                &format!("remove '{}'", layout.source_dir.display()),
                err,
            ))
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::sha256_prefix8;
    use crate::layout::FrameworkArtifact;
    use crate::test_support::{build_ext4_image, erofs_fixture_path};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "afe-processor-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_file(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        std::fs::write(path, contents).expect("write file");
    }

    fn zip_file(path: &Path, entries: &[(&str, &[u8])]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        let cwd = path.parent().expect("archive parent");
        let names: Vec<String> = entries.iter().map(|(name, _)| name.to_string()).collect();
        for (name, contents) in entries {
            write_file(&cwd.join(name), contents);
        }
        crate::zip::create_zip_archive(&path.to_string_lossy(), &names, cwd)
            .expect("create zip archive");
        for (name, _) in entries {
            let _ = std::fs::remove_file(cwd.join(name));
        }
    }

    fn test_layout(label: &str) -> (PathBuf, FrameworkLayout) {
        let root = temp_dir(label);
        let out_dir = root.join("out");
        std::fs::create_dir_all(&out_dir).expect("create out dir");
        let artifact = FrameworkArtifact {
            name: "framework_test_device".to_string(),
            oem: "test".to_string(),
            vendor: "device".to_string(),
            root_dir: out_dir.clone(),
            jar_path: out_dir.join("framework_test_device.jar"),
            updated_at: 1,
        };
        let layout = FrameworkLayout {
            source_dir: out_dir.join("source"),
            out_dir: out_dir.clone(),
            out_tmp_dir: out_dir.join("out_tmp"),
            artifact,
        };
        std::fs::create_dir_all(&layout.source_dir).expect("create source dir");
        (root, layout)
    }

    fn synthesized_erofs(feature_incompat: u32) -> Vec<u8> {
        let mut image = vec![0u8; 2048];
        image[1024..1028].copy_from_slice(&[0xe2, 0xe1, 0xf5, 0xe0]);
        image[1024 + 12] = 12;
        image[1024 + 80..1024 + 84].copy_from_slice(&feature_incompat.to_le_bytes());
        image
    }

    #[test]
    fn walk_framework_inputs_requires_directory_and_sorts() {
        let root = temp_dir("walk");
        write_file(&root.join("b.jar"), b"jar");
        write_file(&root.join("a.dex"), b"dex");
        write_file(&root.join("nested/c.apex"), b"apex");
        write_file(&root.join("notes.txt"), b"text");
        let files = walk_framework_inputs(&root).expect("walk");
        let names: Vec<String> = files
            .iter()
            .map(|path| {
                path.strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(names, vec!["a.dex", "b.jar", "nested/c.apex"]);
        let missing = walk_framework_inputs(&root.join("nope")).unwrap_err();
        assert!(
            missing.message.contains("no such directory"),
            "{}",
            missing.message
        );
    }

    #[test]
    fn extract_dex_from_zip_namespaces_nested_entries() {
        let root = temp_dir("dex-zip");
        let jar = root.join("input.jar");
        zip_file(
            &jar,
            &[
                ("classes.dex", b"first"),
                ("classes2.dex", b"second"),
                ("nested/classes.dex", b"third"),
                ("resources.arsc", b"ignored"),
            ],
        );
        let target = root.join("out");
        let written = extract_dex_from_zip(&jar, &target, "base").expect("extract");
        assert_eq!(written.len(), 3);
        assert_eq!(
            std::fs::read(target.join("base_classes.dex")).unwrap(),
            b"first"
        );
        assert_eq!(
            std::fs::read(target.join("base_classes2.dex")).unwrap(),
            b"second"
        );
        let namespaced = format!("base_{}_classes.dex", sha256_prefix8(b"nested/classes.dex"));
        assert_eq!(std::fs::read(target.join(&namespaced)).unwrap(), b"third");
    }

    #[test]
    fn detect_filesystem_type_recognizes_magics() {
        let root = temp_dir("detect");
        let erofs = root.join("erofs.img");
        write_file(&erofs, &synthesized_erofs(0));
        assert_eq!(detect_filesystem_type(&erofs).unwrap(), FILESYSTEM_EROFS);

        let ext4 = root.join("ext4.img");
        write_file(&ext4, &build_ext4_image(&[("classes.dex", b"payload dex")]));
        assert_eq!(detect_filesystem_type(&ext4).unwrap(), FILESYSTEM_EXT4);

        let unknown = root.join("unknown.img");
        write_file(&unknown, &vec![0x41u8; 4096]);
        assert_eq!(detect_filesystem_type(&unknown).unwrap(), FILESYSTEM_EXT2);

        let short = root.join("short.img");
        write_file(&short, b"short");
        assert_eq!(detect_filesystem_type(&short).unwrap(), FILESYSTEM_EXT2);
    }

    #[test]
    fn extract_apex_payload_unwraps_original_apex() {
        let root = temp_dir("apex-payload");
        let inner = root.join("inner.apex");
        zip_file(&inner, &[("apex_payload.img", b"payload-bytes")]);
        let outer = root.join("outer.apex");
        let inner_bytes = std::fs::read(&inner).unwrap();
        zip_file(&outer, &[("original_apex", &inner_bytes)]);

        let target = root.join("apex-outer");
        let payload = extract_apex_payload(&outer, &target).expect("unwrap original_apex");
        assert_eq!(std::fs::read(&payload).unwrap(), b"payload-bytes");

        let missing = root.join("missing.apex");
        zip_file(&missing, &[("other.img", b"nope")]);
        let error = extract_apex_payload(&missing, &root.join("apex-missing")).unwrap_err();
        assert!(
            error.message.contains("no apex_payload.img found in"),
            "{}",
            error.message
        );
    }

    #[test]
    fn synthetic_ext4_payload_extracts_files() {
        let root = temp_dir("ext4-image");
        let image = root.join("apex_payload.img");
        write_file(
            &image,
            &build_ext4_image(&[("classes.dex", b"payload dex")]),
        );
        let target = root.join("payload");
        let filter = |relative: &str| relative.ends_with(".dex");
        extract_payload_image(&image, &target, &filter).expect("extract");
        assert_eq!(
            std::fs::read(target.join("classes.dex")).unwrap(),
            b"payload dex"
        );
    }

    #[test]
    fn unsupported_erofs_feature_is_a_hard_error() {
        let root = temp_dir("erofs-unsupported");
        let image = root.join("apex_payload.img");
        write_file(&image, &synthesized_erofs(0x100));
        let target = root.join("payload");
        let filter = |relative: &str| relative.ends_with(".dex");
        let error = extract_payload_image(&image, &target, &filter).unwrap_err();
        assert_eq!(error.code, "FILE_ERROR");
        assert!(
            error.message.contains("unsupported image feature"),
            "{}",
            error.message
        );
    }

    #[test]
    fn committed_erofs_fixture_extracts_natively() {
        let fixture = erofs_fixture_path();
        assert!(fixture.exists(), "missing fixture {}", fixture.display());
        let root = temp_dir("erofs-fixture");
        let target = root.join("payload");
        let filter = |relative: &str| relative.ends_with(".jar") || relative.ends_with(".bin");
        extract_payload_image(&fixture, &target, &filter).expect("extract");
        let module = target.join("javalib/module.jar");
        assert_eq!(std::fs::metadata(&module).unwrap().len(), 171_000);
        let bytes = std::fs::read(&module).unwrap();
        assert_eq!(&bytes[..13], b"payload line ");
        assert_eq!(
            std::fs::metadata(target.join("priv-app/shim/dup1.bin"))
                .unwrap()
                .len(),
            3000
        );
    }

    #[test]
    fn processes_apex_with_ext4_payload_natively() {
        let (root, layout) = test_layout("apex-ext4");
        let inner_jar = root.join("classes.jar");
        zip_file(&inner_jar, &[("classes.dex", b"module dex")]);
        let inner_jar_bytes = std::fs::read(&inner_jar).unwrap();
        let payload = build_ext4_image(&[("javalib/module.jar", inner_jar_bytes.as_slice())]);
        let apex = layout.source_dir.join("apex/com.android.mod/classes.apex");
        zip_file(&apex, &[("apex_payload.img", payload.as_slice())]);

        let result = process_framework(&layout).expect("process");
        assert_eq!(result.processed, 1);
        assert!(result.failures.is_empty());
        let names: Vec<String> = result
            .outputs
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            names,
            vec![format!(
                "com.android.mod_classes_{}_module_classes.dex",
                sha256_prefix8(b"javalib/module.jar")
            )]
        );
        assert_eq!(
            std::fs::read(layout.out_tmp_dir.join(&names[0])).unwrap(),
            b"module dex"
        );
    }

    #[test]
    fn apex_same_named_containers_keep_both_dex_files() {
        let (root, layout) = test_layout("apex-duplicate-stems");
        let first = root.join("first.jar");
        let second = root.join("second.jar");
        zip_file(&first, &[("classes.dex", b"first")]);
        zip_file(&second, &[("classes.dex", b"second")]);
        let first_bytes = std::fs::read(&first).unwrap();
        let second_bytes = std::fs::read(&second).unwrap();
        let payload = build_ext4_image(&[
            ("javalib/module.jar", first_bytes.as_slice()),
            ("other/module.jar", second_bytes.as_slice()),
        ]);
        let apex = layout.source_dir.join("apex/com.android.mod/classes.apex");
        zip_file(&apex, &[("apex_payload.img", payload.as_slice())]);
        let result = process_framework(&layout).unwrap();
        assert_eq!(result.outputs.len(), 2);
        let mut contents: Vec<Vec<u8>> = result
            .outputs
            .iter()
            .map(|path| std::fs::read(path).unwrap())
            .collect();
        contents.sort();
        assert_eq!(contents, vec![b"first".to_vec(), b"second".to_vec()]);
    }

    #[test]
    fn process_framework_keeps_previous_output_on_failure() {
        let (_root, layout) = test_layout("atomic");
        zip_file(
            &layout.source_dir.join("one.jar"),
            &[("classes.dex", b"one")],
        );
        let first = match process_framework(&layout) {
            Ok(value) => value,
            Err(err) => panic!("first failed: {} {:?}", err.message, err.details),
        };
        assert_eq!(first.processed, 1);
        assert!(layout.out_tmp_dir.join("one_classes.dex").exists());
        assert!(!PathBuf::from(format!("{}.previous", layout.out_tmp_dir.display())).exists());

        // A broken input still fails the run and has to leave the previous
        // out_tmp (and its `.previous` slot) untouched.
        std::fs::write(layout.source_dir.join("broken.jar"), b"not a zip").unwrap();
        let error = process_framework(&layout).unwrap_err();
        assert_eq!(error.code, "PROCESS_FAILED");
        assert!(
            error.message.contains("1 framework inputs failed"),
            "{}",
            error.message
        );
        let details = error.details.as_ref().expect("failure details");
        assert!(format!("{details:?}").contains("broken.jar"), "{details:?}");
        assert!(layout.out_tmp_dir.join("one_classes.dex").exists());
        assert!(!PathBuf::from(format!("{}.previous", layout.out_tmp_dir.display())).exists());
    }

    #[test]
    fn process_framework_tolerates_duplicate_outputs() {
        // `dup.jar` and `dup.apk` both resolve to `dup_classes.dex`. The
        // TypeScript CLI let the later input win, so the run succeeds, the
        // collision is counted and the last writer's bytes are kept.
        let (_root, layout) = test_layout("duplicate");
        zip_file(
            &layout.source_dir.join("dup.apk"),
            &[("classes.dex", b"dup-apk")],
        );
        zip_file(
            &layout.source_dir.join("dup.jar"),
            &[("classes.dex", b"dup-jar")],
        );
        let result = process_framework(&layout).expect("process");
        assert_eq!(result.processed, 2);
        assert_eq!(result.duplicates, 1);
        assert!(result.failures.is_empty());
        assert_eq!(
            std::fs::read(layout.out_tmp_dir.join("dup_classes.dex")).unwrap(),
            b"dup-jar"
        );
        assert_eq!(result.to_json()["duplicates"], 1);
    }

    #[test]
    fn unsupported_payload_images_fail_without_fallbacks() {
        let (_root, layout) = test_layout("no-fallback");
        // An EROFS image using a feature the native reader does not implement
        // and a blob that is not a filesystem image at all both fail the run:
        // there is no external extractor left to hand them to.
        let payload = synthesized_erofs(0x100);
        zip_file(
            &layout.source_dir.join("unsupported.apex"),
            &[("apex_payload.img", payload.as_slice())],
        );
        zip_file(
            &layout.source_dir.join("garbage.apex"),
            &[("apex_payload.img", b"not an image".as_slice())],
        );
        let error = process_framework(&layout).unwrap_err();
        assert_eq!(error.code, "PROCESS_FAILED");
        assert!(
            error.message.contains("2 framework inputs failed"),
            "{}",
            error.message
        );
        let details = format!("{:?}", error.details);
        assert!(details.contains("unsupported image feature"), "{details}");
        assert!(
            details.contains("unsupported payload image: ext2"),
            "{details}"
        );
        // Nothing was written: out_tmp is only swapped in after every input
        // has been processed, so a failed run must not create it at all.
        assert!(
            !layout.out_tmp_dir.exists(),
            "out_tmp must not exist after a failed run"
        );
    }

    #[test]
    fn count_and_clean_framework_outputs() {
        let (_root, layout) = test_layout("clean");
        zip_file(
            &layout.source_dir.join("one.jar"),
            &[("classes.dex", b"one")],
        );
        process_framework(&layout).expect("process");
        assert_eq!(count_framework_files(&layout.out_tmp_dir), 1);
        assert_eq!(count_framework_files(&layout.out_tmp_dir.join("nope")), 0);
        clean_framework_outputs(&layout, false).expect("clean");
        assert!(!layout.out_tmp_dir.exists());
        assert!(layout.source_dir.exists());
        clean_framework_outputs(&layout, true).expect("clean source");
        assert!(!layout.source_dir.exists());
    }
}

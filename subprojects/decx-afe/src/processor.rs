//! Framework source processing: expands jars/apks and APEX images into the
//! set of dex files packed into the framework jar. Port of the TypeScript
//! `framework-processor.ts`.
//!
//! APEX payload images are read natively ([`crate::ext4`], [`crate::erofs`]);
//! the external-tool path (`debugfs`, erofs-utils) is only used for payloads
//! the native readers reject, and it is resolved lazily so images handled
//! natively work without those tools installed.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::collector::{extname_posix, remote_module};
use crate::erofs::{ErofsError, ErofsImage};
use crate::error::{io_error, Error, Result};
use crate::ext4::{Ext4Error, Ext4Image};
use crate::framework_tools::{
    is_fsck_erofs, resolve_debugfs_tool, resolve_erofs_tool, run_framework_tool, FrameworkTool,
    ToolContext, ToolRunOptions, EXTRACT_TIMEOUT,
};
use crate::hash::sha256_prefix8;
use crate::layout::{mkdtemp, FrameworkLayout};
use crate::zip::{extract_zip_entry, list_zip_entries};

const MAX_EXPANDED_ENTRY_BYTES: u64 = 8 * 1024 * 1024 * 1024;
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
    pub outputs: Vec<PathBuf>,
    pub failures: Vec<ProcessFailure>,
}

impl ProcessResult {
    pub fn to_json(&self) -> Value {
        json!({
            "processed": self.processed,
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
    let mut written = Vec::new();
    for entry in list_zip_entries(&package)? {
        if !entry.to_ascii_lowercase().ends_with(".dex") {
            continue;
        }
        let mut name = entry.rsplit('/').next().unwrap_or(&entry).to_string();
        // Include a path digest for non-root entries so two nested
        // classes.dex files cannot silently overwrite each other.
        if entry.trim_matches('/').contains('/') {
            name = format!("{}_{}", sha256_prefix8(entry.as_bytes()), name);
        }
        let target = target_dir.join(format!("{prefix}_{name}"));
        let target_string = target.to_string_lossy().to_string();
        extract_zip_entry(&package, &entry, &target_string)?;
        let size = std::fs::metadata(&target)
            .map_err(|err| io_error(&format!("stat '{}'", target.display()), err))?
            .len();
        if size > MAX_EXPANDED_ENTRY_BYTES {
            let _ = std::fs::remove_file(&target);
            return Err(Error::file("expanded entry exceeds 8 GiB", Some(&package)));
        }
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

/// Writes `apex_payload.img` from an `.apex` container into `target_dir` and
/// returns its path. Nested `original_apex` containers are unwrapped first.
pub fn extract_apex_payload(apex_file: &Path, target_dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(target_dir)
        .map_err(|err| io_error(&format!("create '{}'", target_dir.display()), err))?;
    let container = apex_file.to_string_lossy().to_string();
    let names = list_zip_entries(&container)?;
    if names.iter().any(|name| name == "original_apex") {
        let nested = target_dir.join("original.apex");
        extract_zip_entry(&container, "original_apex", &nested.to_string_lossy())?;
        return extract_apex_payload(&nested, target_dir);
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

/// External-tool extraction for payload images the native reader rejects.
/// The EROFS extractor is called with the flag set matching its binary name;
/// everything else goes through `debugfs rdump`.
pub fn extract_filesystem_image(
    image_path: &Path,
    extract_dir: &Path,
    tools: &ToolContext,
) -> Result<()> {
    std::fs::create_dir_all(extract_dir)
        .map_err(|err| io_error(&format!("create '{}'", extract_dir.display()), err))?;
    let image = image_path.to_string_lossy().to_string();
    let directory = extract_dir.to_string_lossy().to_string();
    if detect_filesystem_type(image_path)? == FILESYSTEM_EROFS {
        let tool = resolve_erofs_tool(tools)?;
        let args = if is_fsck_erofs(&tool) {
            vec![
                format!("--extract={directory}"),
                "--overwrite".to_string(),
                image,
            ]
        } else {
            vec![
                "-i".to_string(),
                image,
                "-x".to_string(),
                "-f".to_string(),
                "-o".to_string(),
                directory,
            ]
        };
        run_checked_framework_tool(&tool, &args, tools)?;
        return Ok(());
    }
    let tool = resolve_debugfs_tool(tools)?;
    let args = vec!["-R".to_string(), format!("rdump ./ {directory}"), image];
    run_checked_framework_tool(&tool, &args, tools)
}

fn run_checked_framework_tool(
    tool: &FrameworkTool,
    args: &[String],
    tools: &ToolContext,
) -> Result<()> {
    let options = ToolRunOptions {
        timeout: Some(EXTRACT_TIMEOUT),
        input: None,
    };
    let result = run_framework_tool(tool, args, &options, tools)?;
    if result.status != Some(0) {
        let detail = {
            let stderr = result.stderr.trim();
            if !stderr.is_empty() {
                stderr.to_string()
            } else {
                let stdout = result.stdout.trim();
                if !stdout.is_empty() {
                    stdout.to_string()
                } else {
                    match result.status {
                        Some(code) => format!("exit {code}"),
                        None => "exit null".to_string(),
                    }
                }
            }
        };
        return Err(Error::file(
            format!("{}: {detail}", tool.argv.join(" ")),
            None,
        ));
    }
    Ok(())
}

fn can_fall_back_ext4(error: &Ext4Error) -> bool {
    matches!(
        error,
        Ext4Error::NotExt4Image | Ext4Error::UnsupportedFeature(_)
    )
}

fn can_fall_back_erofs(error: &ErofsError) -> bool {
    matches!(
        error,
        ErofsError::NotErofsImage | ErofsError::Unsupported(_)
    )
}

/// Native payload extraction. Returns `false` only when the payload is not an
/// ext4/EROFS image or uses a feature the native readers reject, so the caller
/// can fall back to the external tools; any other error is a hard failure.
pub fn extract_payload_natively(
    image_path: &Path,
    extract_dir: &Path,
    filter: &dyn Fn(&str) -> bool,
) -> Result<bool> {
    let image_path_string = image_path.to_string_lossy().to_string();
    let extract_dir_string = extract_dir.to_string_lossy().to_string();
    match detect_filesystem_type(image_path)? {
        FILESYSTEM_EXT4 => {
            let image = match Ext4Image::open(&image_path_string) {
                Ok(image) => image,
                Err(err) => {
                    return if can_fall_back_ext4(&err) {
                        Ok(false)
                    } else {
                        Err(Error::file(err.to_string(), Some(&image_path_string)))
                    }
                }
            };
            let outcome = (|| -> Result<bool> {
                std::fs::create_dir_all(extract_dir)
                    .map_err(|err| io_error(&format!("create '{}'", extract_dir.display()), err))?;
                match image.extract_to(&extract_dir_string, filter) {
                    Ok(()) => Ok(true),
                    Err(err) => {
                        if can_fall_back_ext4(&err) {
                            Ok(false)
                        } else {
                            Err(Error::file(err.to_string(), Some(&image_path_string)))
                        }
                    }
                }
            })();
            image.close();
            outcome
        }
        FILESYSTEM_EROFS => {
            let image = match ErofsImage::open(&image_path_string) {
                Ok(image) => image,
                Err(err) => {
                    return if can_fall_back_erofs(&err) {
                        Ok(false)
                    } else {
                        Err(Error::file(err.to_string(), Some(&image_path_string)))
                    }
                }
            };
            let outcome = (|| -> Result<bool> {
                std::fs::create_dir_all(extract_dir)
                    .map_err(|err| io_error(&format!("create '{}'", extract_dir.display()), err))?;
                match image.extract_to(&extract_dir_string, filter) {
                    Ok(()) => Ok(true),
                    Err(err) => {
                        if can_fall_back_erofs(&err) {
                            Ok(false)
                        } else {
                            Err(Error::file(err.to_string(), Some(&image_path_string)))
                        }
                    }
                }
            })();
            image.close();
            outcome
        }
        // ext2 or unknown magic: leave the image to the external tools.
        _ => Ok(false),
    }
}

/// Expands one `.apex`/`.capex` input into dex outputs inside `work_dir`.
/// Every output is namespaced with `prefix` so modules shipping same-named
/// jars cannot overwrite each other.
pub fn process_apex(
    apex_file: &Path,
    work_dir: &Path,
    prefix: &str,
    tools: &ToolContext,
) -> Result<()> {
    let apex_dir = work_dir.join(format!("apex-{}", file_stem_name(apex_file)));
    let payload_dir = apex_dir.join("payload");
    let payload = extract_apex_payload(apex_file, &apex_dir)?;
    let nested_filter =
        |relative: &str| APEX_CONTENT_EXTENSIONS.contains(&extension_of_str(relative).as_str());
    let extracted = extract_payload_natively(&payload, &payload_dir, &nested_filter)?;
    if !extracted {
        // Payload or feature the native readers reject: extract with the
        // external tools (debugfs / erofs-utils from PATH; Linux/macOS only).
        let _ = std::fs::remove_dir_all(&payload_dir);
        extract_filesystem_image(&payload, &payload_dir, tools)?;
    }
    for nested in walk_framework_inputs(&payload_dir)? {
        let extension = extension_lower(&nested);
        if extension == ".jar" || extension == ".apk" {
            let stem = file_stem_name(&nested);
            extract_dex_from_zip(&nested, work_dir, &format!("{prefix}_{stem}"))?;
            continue;
        }
        if extension == ".dex" {
            let name = nested
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            let target = work_dir.join(format!("{prefix}_{name}"));
            std::fs::copy(&nested, &target)
                .map_err(|err| io_error(&format!("copy '{}'", target.display()), err))?;
        }
    }
    Ok(())
}

/// Expands every supported source file into a staging directory and swaps it
/// in as the layout's `out_tmp_dir`. Nothing is replaced unless every input
/// processed, so a failed run keeps the previous output.
pub fn process_framework(layout: &FrameworkLayout, tools: &ToolContext) -> Result<ProcessResult> {
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
            let step = (|| -> Result<()> {
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
                    _ => process_apex(file, &work, &prefix, tools)?,
                }
                let mut names: Vec<String> = std::fs::read_dir(&work)
                    .map_err(|err| io_error(&format!("read directory '{}'", work.display()), err))?
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .collect();
                names.sort();
                for name in names {
                    let source = work.join(&name);
                    if !source.is_file() {
                        continue;
                    }
                    let destination = staging.join(&name);
                    if destination.exists() {
                        return Err(Error::file(
                            format!("duplicate output {name} from {}", file.display()),
                            Some(&file.to_string_lossy()),
                        ));
                    }
                    std::fs::copy(&source, &destination).map_err(|err| {
                        io_error(&format!("copy '{}'", destination.display()), err)
                    })?;
                }
                Ok(())
            })();
            let _ = std::fs::remove_dir_all(&work);
            match step {
                Ok(()) => result.processed += 1,
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
        assert!(extract_payload_natively(&image, &target, &filter).expect("extract"));
        assert_eq!(
            std::fs::read(target.join("classes.dex")).unwrap(),
            b"payload dex"
        );
    }

    #[test]
    fn unsupported_erofs_feature_falls_back() {
        let root = temp_dir("erofs-fallback");
        let image = root.join("apex_payload.img");
        write_file(&image, &synthesized_erofs(0x100));
        let target = root.join("payload");
        let filter = |relative: &str| relative.ends_with(".dex");
        assert!(!extract_payload_natively(&image, &target, &filter).expect("no hard error"));
    }

    #[test]
    fn committed_erofs_fixture_extracts_natively() {
        let fixture = erofs_fixture_path();
        assert!(fixture.exists(), "missing fixture {}", fixture.display());
        let root = temp_dir("erofs-fixture");
        let target = root.join("payload");
        let filter = |relative: &str| relative.ends_with(".jar") || relative.ends_with(".bin");
        assert!(extract_payload_natively(&fixture, &target, &filter).expect("extract"));
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

        let result = process_framework(&layout, &ToolContext::from_process_env()).expect("process");
        assert_eq!(result.processed, 1);
        assert!(result.failures.is_empty());
        let names: Vec<String> = result
            .outputs
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["com.android.mod_classes_module_classes.dex"]);
        assert_eq!(
            std::fs::read(layout.out_tmp_dir.join(&names[0])).unwrap(),
            b"module dex"
        );
    }

    #[test]
    fn process_framework_keeps_previous_output_on_failure() {
        let (_root, layout) = test_layout("atomic");
        zip_file(
            &layout.source_dir.join("one.jar"),
            &[("classes.dex", b"one")],
        );
        let first = match process_framework(&layout, &ToolContext::from_process_env()) {
            Ok(value) => value,
            Err(err) => panic!("first failed: {} {:?}", err.message, err.details),
        };
        assert_eq!(first.processed, 1);
        assert!(layout.out_tmp_dir.join("one_classes.dex").exists());
        assert!(!PathBuf::from(format!("{}.previous", layout.out_tmp_dir.display())).exists());

        // Same prefix from two inputs: the second becomes a duplicate output
        // and the run must fail without replacing the previous out_tmp.
        zip_file(
            &layout.source_dir.join("dup.jar"),
            &[("classes.dex", b"dup-jar")],
        );
        zip_file(
            &layout.source_dir.join("dup.apk"),
            &[("classes.dex", b"dup-apk")],
        );
        let error = process_framework(&layout, &ToolContext::from_process_env()).unwrap_err();
        assert_eq!(error.code, "PROCESS_FAILED");
        assert!(
            error.message.contains("1 framework inputs failed"),
            "{}",
            error.message
        );
        let failures = error
            .details
            .as_ref()
            .expect("failure details")
            .get("failures")
            .expect("failure details");
        assert!(failures
            .to_string()
            .contains("duplicate output dup_classes.dex"));
        assert!(layout.out_tmp_dir.join("one_classes.dex").exists());
        assert!(!layout.out_tmp_dir.join("dup_classes.dex").exists());
        assert!(!PathBuf::from(format!("{}.previous", layout.out_tmp_dir.display())).exists());
    }

    #[test]
    fn missing_external_tools_fail_actionably() {
        let (root, layout) = test_layout("missing-tools");
        let payload = synthesized_erofs(0x100);
        let apex = layout.source_dir.join("unsupported.apex");
        zip_file(&apex, &[("apex_payload.img", payload.as_slice())]);
        let mut tools = ToolContext::from_process_env();
        tools
            .env
            .insert("AFE_FSCK_EROFS".to_string(), String::new());
        tools
            .env
            .insert("AFE_EXTRACT_EROFS".to_string(), String::new());
        tools.env.insert("AFE_DEBUGFS".to_string(), String::new());
        tools.env.insert(
            "PATH".to_string(),
            root.join("empty").to_string_lossy().to_string(),
        );
        let error = process_framework(&layout, &tools).unwrap_err();
        assert_eq!(error.code, "PROCESS_FAILED");
        let details = format!("{:?}", error.details);
        // The message is platform-specific: Windows reports that erofs-utils
        // has no native binary instead of the install hint.
        let expected = if tools.platform == "win32" {
            crate::framework_tools::EROFS_MISSING_WIN32
        } else {
            crate::framework_tools::EROFS_MISSING
        };
        assert!(details.contains(expected), "{}", details);
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
        process_framework(&layout, &ToolContext::from_process_env()).expect("process");
        assert_eq!(count_framework_files(&layout.out_tmp_dir), 1);
        assert_eq!(count_framework_files(&layout.out_tmp_dir.join("nope")), 0);
        clean_framework_outputs(&layout, false).expect("clean");
        assert!(!layout.out_tmp_dir.exists());
        assert!(layout.source_dir.exists());
        clean_framework_outputs(&layout, true).expect("clean source");
        assert!(!layout.source_dir.exists());
    }
}

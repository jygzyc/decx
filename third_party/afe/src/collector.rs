//! Framework collection from a connected Android device. Port of the
//! TypeScript `framework-collector.ts` (itself a port of the Go
//! `android.Collect`).
//!
//! The remote roots and their file filters are fixed. The runtime `/apex`
//! mount is scanned before `/system/apex`, and images for modules already
//! present under the source tree are skipped (`skipped_covered_modules`).
//! Every pulled file lands under the source directory, mirroring its device
//! path.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::adb::{AdbClient, ADB_TIMEOUT};
use crate::error::{io_error, Result};
use crate::layout::{absolute, mkdtemp, FrameworkLayout};

/// Scanned in this order; `/apex` covers activated modules before
/// `/system/apex`.
pub const FRAMEWORK_REMOTE_ROOTS: [&str; 6] = [
    "/system/framework",
    "/apex",
    "/vendor/framework",
    "/system_ext/framework",
    "/product/framework",
    "/system/apex",
];

pub const APEX_IMAGE_EXTENSIONS: [&str; 2] = [".apex", ".capex"];
pub const DEX_CONTAINER_EXTENSIONS: [&str; 3] = [".jar", ".apk", ".dex"];

/// Per-file collection failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectFailure {
    pub path: String,
    pub error: String,
}

/// Collection counters returned by [`collect_framework`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CollectResult {
    pub scanned: u64,
    pub pulled: u64,
    pub skipped_covered_modules: u64,
    pub failures: Vec<CollectFailure>,
}

impl CollectResult {
    pub fn to_json(&self) -> Value {
        json!({
            "scanned": self.scanned,
            "pulled": self.pulled,
            "skippedCoveredModules": self.skipped_covered_modules,
            "failures": self
                .failures
                .iter()
                .map(|failure| json!({ "path": failure.path, "error": failure.error }))
                .collect::<Vec<_>>(),
        })
    }
}

/// True when `target` is `root` itself or nested inside it.
pub fn is_inside_dir(root: &Path, target: &Path) -> bool {
    let root = absolute(root);
    let target = absolute(target);
    target.strip_prefix(&root).is_ok()
}

/// Posix `path.extname`: the extension including the dot, or `""`.
pub fn extname_posix(name: &str) -> &str {
    match name.rfind('.') {
        Some(0) | None => "",
        Some(index) => &name[index..],
    }
}

fn base_name(remote_path: &str) -> &str {
    remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
}

/// APEX module owning a path, taken from an `apex/<module>[/...]` segment.
/// Requires a segment after the module name, so `/apex/foo` alone does not
/// count as a module directory.
pub fn remote_module(remote_path: &str) -> String {
    let parts: Vec<&str> = remote_path.trim_start_matches('/').split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        if *part == "apex" && index + 2 < parts.len() {
            return parts[index + 1].split('@').next().unwrap_or("").to_string();
        }
    }
    String::new()
}

/// A `.apex`/`.capex` whose base name is not a versioned module link.
pub fn is_apex_module_image(remote_path: &str) -> bool {
    let base = base_name(remote_path);
    let extension = extname_posix(base);
    let stem = &base[..base.len() - extension.len()];
    !stem.contains('@')
}

/// File filter per root: `/system/apex` keeps images, every other root keeps
/// dex containers.
pub fn accepts_remote_file(root: &str, remote_path: &str) -> bool {
    let extension = extname_posix(base_name(remote_path)).to_ascii_lowercase();
    if root == "/system/apex" {
        return APEX_IMAGE_EXTENSIONS.contains(&extension.as_str())
            && is_apex_module_image(remote_path);
    }
    DEX_CONTAINER_EXTENSIONS.contains(&extension.as_str())
}

/// Module segment of an `.apex`/`.capex` path (`module@version.apex` →
/// `module`).
pub fn apex_module_of(remote_path: &str) -> String {
    let base = base_name(remote_path);
    let extension = extname_posix(base);
    base[..base.len() - extension.len()]
        .split('@')
        .next()
        .unwrap_or("")
        .to_string()
}

/// Accepted remote files from one `find` invocation, in output order.
pub fn parse_framework_find_output(root: &str, output: &str) -> Vec<String> {
    let prefix = format!("{root}/");
    let mut files = Vec::new();
    for raw_line in output.split('\n') {
        let remote = raw_line.trim();
        if !remote.starts_with(&prefix) {
            continue;
        }
        if !accepts_remote_file(root, remote) {
            continue;
        }
        files.push(remote.to_string());
    }
    files
}

/// Modules already present under `<source_dir>/apex/...`, counted from files
/// a previous successful pull left behind.
pub fn scan_covered_modules(source_dir: &Path) -> HashSet<String> {
    let mut covered = HashSet::new();
    let root = source_dir.join("apex");
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let full = entry.path();
            if kind.is_dir() {
                stack.push(full);
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let relative = full
                .strip_prefix(source_dir)
                .unwrap_or(&full)
                .to_string_lossy()
                .replace('\\', "/");
            let module = remote_module(&relative);
            if !module.is_empty() {
                covered.insert(module);
            }
        }
    }
    covered
}

fn pull_remote_file(
    adb: &mut AdbClient,
    layout: &FrameworkLayout,
    result: &mut CollectResult,
    covered: &mut HashSet<String>,
    remote: &str,
) {
    let clean = remote.trim_start_matches('/');
    let mut local: PathBuf = layout.source_dir.clone();
    for part in clean.split('/') {
        local.push(part);
    }
    if !remote.starts_with('/') || !is_inside_dir(&layout.source_dir, &local) {
        result.failures.push(CollectFailure {
            path: remote.to_string(),
            error: "invalid device path".to_string(),
        });
        return;
    }

    let attempt = (|| -> Result<()> {
        let parent = local
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| layout.source_dir.clone());
        std::fs::create_dir_all(&parent)
            .map_err(|err| io_error(&format!("create '{}'", parent.display()), err))?;
        let temp_dir = mkdtemp(&parent, ".pull-")
            .map_err(|err| io_error(&format!("create temp dir in '{}'", parent.display()), err))?;
        let temp_path = temp_dir.join("pull.tmp");
        let outcome = (|| -> Result<()> {
            adb.pull(remote, &temp_path.to_string_lossy(), ADB_TIMEOUT)?;
            std::fs::rename(&temp_path, &local)
                .map_err(|err| io_error(&format!("rename into '{}'", local.display()), err))?;
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(&temp_dir);
        outcome
    })();

    match attempt {
        Ok(()) => {
            result.pulled += 1;
            let module = remote_module(remote);
            if !module.is_empty() {
                covered.insert(module);
            }
        }
        Err(err) => result.failures.push(CollectFailure {
            path: remote.to_string(),
            error: err.message,
        }),
    }
}

/// Pull the framework files described by [`FRAMEWORK_REMOTE_ROOTS`].
pub fn collect_framework(adb: &mut AdbClient, layout: &FrameworkLayout) -> Result<CollectResult> {
    let mut result = CollectResult::default();
    let mut covered = scan_covered_modules(&layout.source_dir);

    for root in FRAMEWORK_REMOTE_ROOTS {
        // Missing OEM paths and inaccessible mounts are expected; fallback
        // images are scanned separately even when the runtime /apex scan is
        // denied.
        let output = adb.shell(
            &format!("find {root} -type f 2>/dev/null; true"),
            ADB_TIMEOUT,
        )?;
        for remote in parse_framework_find_output(root, &output) {
            result.scanned += 1;
            if root == "/system/apex" && covered.contains(&apex_module_of(&remote)) {
                result.skipped_covered_modules += 1;
                continue;
            }
            pull_remote_file(adb, layout, &mut result, &mut covered, &remote);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_module_requires_a_segment_after_apex() {
        assert_eq!(
            remote_module("apex/com.android.foo/etc/x"),
            "com.android.foo"
        );
        // The TS rule needs one segment *after* the module directory, so a
        // bare `/system/apex/<module>.apex` (a file, not a module dir) and a
        // trailing-only path deliberately yield no module.
        assert_eq!(remote_module("system/apex/bar@1.apex"), "");
        assert_eq!(remote_module("system/apex/bar/javalib/x.jar"), "bar");
        assert_eq!(remote_module("apex/foo"), "");
        assert_eq!(remote_module("system/framework/framework.jar"), "");
    }

    #[test]
    fn apex_image_detection_skips_versioned_links() {
        assert!(is_apex_module_image("/system/apex/com.android.foo.apex"));
        assert!(!is_apex_module_image("/system/apex/com.android.foo@1.apex"));
        assert!(accepts_remote_file(
            "/system/apex",
            "/system/apex/com.android.foo.capex"
        ));
        assert!(!accepts_remote_file(
            "/system/apex",
            "/system/apex/readme.txt"
        ));
        assert!(accepts_remote_file(
            "/system/framework",
            "/system/framework/framework.jar"
        ));
        assert!(!accepts_remote_file(
            "/system/framework",
            "/system/framework/framework.apex"
        ));
    }

    #[test]
    fn find_output_is_filtered_by_root_and_extension() {
        let output = "/system/framework/framework.jar\n/system/framework/foo.apk\n/system/framework/notes.txt\n/other/framework.jar\n";
        assert_eq!(
            parse_framework_find_output("/system/framework", output),
            vec![
                "/system/framework/framework.jar".to_string(),
                "/system/framework/foo.apk".to_string()
            ]
        );
    }

    #[test]
    fn covered_modules_are_scanned_from_the_source_tree() {
        let dir = mkdtemp(&std::env::temp_dir(), "afe-covered-").unwrap();
        std::fs::create_dir_all(dir.join("apex/com.android.module/etc")).unwrap();
        std::fs::write(dir.join("apex/com.android.module/etc/x"), b"x").unwrap();
        std::fs::create_dir_all(dir.join("system").join("framework")).unwrap();
        std::fs::write(dir.join("system").join("framework").join("f.jar"), b"j").unwrap();
        let covered = scan_covered_modules(&dir);
        assert!(covered.contains("com.android.module"));
        assert_eq!(covered.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}

//! Framework jar packing. Port of the TypeScript `framework-packer.ts`.
//!
//! The jar holds a minimal manifest plus one entry per processed dex file,
//! named by its basename. The previous jar is only replaced once the new
//! archive exists.

use std::path::{Path, PathBuf};

use crate::error::{io_error, Error, Result};
use crate::layout::{mkdtemp, FrameworkLayout};
use crate::processor::walk_framework_inputs;
use crate::zip::create_zip_archive;

pub const FRAMEWORK_MANIFEST: &str = "Manifest-Version: 1.0\r\nCreated-By: decx\r\n\r\n";
pub const FRAMEWORK_MANIFEST_PATH: &str = "META-INF/MANIFEST.MF";

/// Write `META-INF/MANIFEST.MF` under `root` and return its path.
pub fn create_framework_manifest(root: &Path) -> Result<PathBuf> {
    let directory = root.join("META-INF");
    std::fs::create_dir_all(&directory)
        .map_err(|err| io_error(&format!("create '{}'", directory.display()), err))?;
    let manifest = root.join("META-INF").join("MANIFEST.MF");
    std::fs::write(&manifest, FRAMEWORK_MANIFEST)
        .map_err(|err| io_error(&format!("write '{}'", manifest.display()), err))?;
    Ok(manifest)
}

/// Pack the processed dex files into `layout.artifact.jar_path` and return it.
pub fn pack_framework_jar(layout: &FrameworkLayout) -> Result<PathBuf> {
    let files = walk_framework_inputs(&layout.out_tmp_dir)?;
    if files.is_empty() {
        return Err(Error::file(
            "no processed dex files",
            Some(&layout.out_tmp_dir.to_string_lossy()),
        ));
    }
    let staging = mkdtemp(&layout.out_dir, ".pack-")
        .map_err(|err| io_error(&format!("create '{}'", layout.out_dir.display()), err))?;

    let outcome = (|| -> Result<PathBuf> {
        create_framework_manifest(&staging)?;
        let mut entries = vec!["META-INF".to_string()];
        for file in &files {
            let name = file
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            let target = staging.join(&name);
            std::fs::copy(file, &target).map_err(|err| {
                io_error(
                    &format!("copy '{}' to '{}'", file.display(), target.display()),
                    err,
                )
            })?;
            entries.push(name);
        }
        let archive = staging.join("framework.jar");
        create_zip_archive(&archive.to_string_lossy(), &entries, &staging)?;
        let jar_path = layout.artifact.jar_path.clone();
        match std::fs::remove_file(&jar_path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(io_error(&format!("remove '{}'", jar_path.display()), err)),
        }
        std::fs::rename(&archive, &jar_path)
            .map_err(|err| io_error(&format!("rename into '{}'", jar_path.display()), err))?;
        Ok(jar_path)
    })();

    let _ = std::fs::remove_dir_all(&staging);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_matches_the_java_tooling_expectation() {
        let dir = mkdtemp(&std::env::temp_dir(), "afe-pack-").unwrap();
        let manifest = create_framework_manifest(&dir).unwrap();
        let text = std::fs::read_to_string(&manifest).unwrap();
        assert_eq!(text, "Manifest-Version: 1.0\r\nCreated-By: decx\r\n\r\n");
        std::fs::remove_dir_all(&dir).ok();
    }
}

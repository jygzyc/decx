//! `afe collect` / `afe process` / `afe pack` flows. Each returns the JSON
//! object the command prints on stdout, mirroring the TypeScript `index.ts`
//! handlers (`{artifact, layout, collection}`, `{artifact, layout, process,
//! pack}`).

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::adb::AdbClient;
use crate::collector::collect_framework;
use crate::error::{Error, Result};
use crate::layout::{
    layout_json, resolve_framework_layout, summarize_artifact, FrameworkLayoutRequest,
};
use crate::packer::pack_framework_jar;
use crate::processor::{
    clean_framework_output, clean_framework_source, count_framework_files, process_framework,
};

/// Inputs shared by the framework flows.
pub struct FrameworkOptions {
    pub home: PathBuf,
    pub adb_path: String,
    /// True when `--adb-path` was given, which makes device failures fatal.
    pub adb_path_explicit: bool,
    pub serial: Option<String>,
    pub oem: Option<String>,
    pub source_dir: Option<PathBuf>,
    pub out_dir: Option<PathBuf>,
    /// Keep `out_tmp` after a successful `process` (AFE extension; the
    /// TypeScript flow always removes it once the jar is packed).
    pub keep_outputs: bool,
}

impl FrameworkOptions {
    fn client(&self) -> AdbClient {
        AdbClient::new(Some(self.adb_path.clone()), self.serial.clone())
    }

    /// TS `requiredDevice()`.
    fn required_device(&self) -> Result<AdbClient> {
        let mut client = self.client();
        client.ensure_available()?;
        client.select()?;
        Ok(client)
    }

    /// TS `frameworkDevice(false)`: a usable client, or `None` when adb is
    /// absent and the caller did not ask for a specific device.
    fn optional_device(&self) -> Result<Option<AdbClient>> {
        let mut client = self.client();
        let failure = client
            .ensure_available()
            .err()
            .or_else(|| client.select().err());
        match failure {
            None => Ok(Some(client)),
            Some(err) if self.serial.is_some() || self.adb_path_explicit => Err(err),
            Some(_) => Ok(None),
        }
    }

    fn request(&self, device: bool) -> FrameworkLayoutRequest {
        FrameworkLayoutRequest {
            home: self.home.clone(),
            oem: self.oem.clone(),
            vendor: None,
            source_dir: self.source_dir.clone(),
            out_dir: self.out_dir.clone(),
            device,
            serial_requested: self.serial.is_some(),
        }
    }
}

/// `afe collect`: pull the ready-made framework roots and the apex payload
/// images the ready-made pass did not cover.
pub fn collect(options: &FrameworkOptions) -> Result<Value> {
    let mut client = options.required_device()?;
    let layout = resolve_framework_layout(&options.request(true), Some(&mut client))?;
    let collection = collect_framework(&mut client, &layout)?;
    Ok(json!({
        "artifact": summarize_artifact(&layout),
        "layout": layout_json(&layout),
        "collection": collection.to_json(),
    }))
}

/// `afe process`: expand every collected input, swap `out_tmp` atomically,
/// pack the framework jar, and optionally drop the source tree.
pub fn process(options: &FrameworkOptions, clean_source: bool) -> Result<Value> {
    let mut device = options.optional_device()?;
    let layout = resolve_framework_layout(
        &options.request(false),
        device.as_mut().map(|client| client as &mut AdbClient),
    )?;
    let processed = process_framework(&layout)?;
    let jar_path = pack_framework_jar(&layout)?;
    let file_count = count_framework_files(&layout.out_tmp_dir);
    if !options.keep_outputs {
        clean_framework_output(&layout)?;
    }
    if clean_source {
        clean_framework_source(&layout)?;
    }
    Ok(json!({
        "artifact": summarize_artifact(&layout),
        "layout": layout_json(&layout),
        "process": processed.to_json(),
        "pack": {
            "jarPath": jar_path.to_string_lossy(),
            "fileCount": file_count,
        },
    }))
}

/// `afe pack`: re-pack an existing `out_tmp` directory without re-processing.
/// `afe process` removes `out_tmp` once the jar exists, so use
/// `--keep-outputs` when this command is meant to run afterwards.
pub fn pack(options: &FrameworkOptions) -> Result<Value> {
    let layout = resolve_framework_layout(&options.request(false), None)?;
    if !layout.out_tmp_dir.is_dir() {
        return Err(Error::file(
            format!(
                "no processed dex files: {} does not exist (pass --keep-outputs to 'afe process' to retain it)",
                layout.out_tmp_dir.display()
            ),
            Some(&layout.out_tmp_dir.to_string_lossy()),
        ));
    }
    let file_count = count_framework_files(&layout.out_tmp_dir);
    let jar_path = pack_framework_jar(&layout)?;
    Ok(json!({
        "artifact": summarize_artifact(&layout),
        "layout": layout_json(&layout),
        "pack": {
            "jarPath": jar_path.to_string_lossy(),
            "fileCount": file_count,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zip::create_zip_archive;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("afe-flows-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_jar(path: &std::path::Path) {
        let staging = temp_dir("jar-stage");
        std::fs::write(staging.join("classes.dex"), b"dex").unwrap();
        create_zip_archive(
            &path.to_string_lossy(),
            &["classes.dex".to_string()],
            &staging,
        )
        .unwrap();
        let _ = std::fs::remove_dir_all(&staging);
    }

    fn make_options(root: &std::path::Path, keep_outputs: bool) -> FrameworkOptions {
        FrameworkOptions {
            home: root.join("home"),
            adb_path: root.join("missing-adb").to_string_lossy().to_string(),
            adb_path_explicit: false,
            serial: None,
            oem: Some("test".to_string()),
            source_dir: Some(root.join("source")),
            out_dir: Some(root.join("out")),
            keep_outputs,
        }
    }

    #[test]
    fn keep_outputs_retains_out_tmp_for_pack() {
        let root = temp_dir("keep");
        let options = make_options(&root, true);
        let source = options.source_dir.clone().unwrap();
        std::fs::create_dir_all(&source).unwrap();
        write_jar(&source.join("one.jar"));

        let processed = process(&options, false).expect("process");
        assert_eq!(processed["process"]["processed"], 1);
        assert!(options.out_dir.clone().unwrap().join("out_tmp").is_dir());

        let packed = pack(&options).expect("pack");
        assert_eq!(packed["pack"]["fileCount"], 1);

        // Without --keep-outputs the default TypeScript behavior removes
        // out_tmp and pack then fails with an actionable message.
        let strict = make_options(&root, false);
        process(&strict, false).expect("process again");
        assert!(!strict.out_dir.clone().unwrap().join("out_tmp").exists());
        let error: Error = pack(&strict).unwrap_err();
        assert_eq!(error.code, "FILE_ERROR");
        assert!(
            error.message.contains("pass --keep-outputs"),
            "{}",
            error.message
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}

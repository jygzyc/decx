//! Framework layout and artifact naming. Port of the TypeScript
//! `framework.ts` (plus the artifact helpers the CLI used).
//!
//! OEM and vendor come from the explicit flags, the recorded
//! `out_dir/.artifact.json`, or the connected device, in that order. Every
//! successful resolution rewrites the artifact record.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::adb::AdbClient;
use crate::collector::is_inside_dir;
use crate::error::{Error, Result};

/// One recorded artifact: the packaged framework jar and its metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameworkArtifact {
    pub name: String,
    pub oem: String,
    pub vendor: String,
    pub root_dir: PathBuf,
    pub jar_path: PathBuf,
    pub updated_at: u128,
}

/// Resolved input/output layout for the collect/process commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameworkLayout {
    pub source_dir: PathBuf,
    pub out_dir: PathBuf,
    pub out_tmp_dir: PathBuf,
    pub artifact: FrameworkArtifact,
}

/// Inputs for [`resolve_framework_layout`].
#[derive(Debug, Clone, Default)]
pub struct FrameworkLayoutRequest {
    /// Root for the default `source`/`out` directories ([`crate::afe_home`]).
    pub home: PathBuf,
    pub oem: Option<String>,
    pub vendor: Option<String>,
    pub source_dir: Option<PathBuf>,
    pub out_dir: Option<PathBuf>,
    /// True when the command cannot work offline (collection from a device).
    pub device: bool,
    /// True when the caller pinned a device with `--serial`.
    pub serial_requested: bool,
}

/// Lowercase; runs outside `[a-z0-9._-]` collapse to `_`; leading and trailing
/// `.`/`_`/`-` are trimmed. Never empty.
pub fn segment(value: &str) -> String {
    let mut normalized = String::new();
    let mut pending_separator = false;
    for ch in value.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_lowercase() || lower.is_ascii_digit() || matches!(lower, '.' | '_' | '-')
        {
            if pending_separator {
                normalized.push('_');
                pending_separator = false;
            }
            normalized.push(lower);
        } else {
            pending_separator = true;
        }
    }
    let trimmed = normalized.trim_matches(|ch| matches!(ch, '.' | '_' | '-'));
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Windows drive-relative names ("C:evil.dex") carry a prefix but no root, so
/// `Path::join`/`Path::push` treats them as a path replacement and they escape
/// the extraction root. Rejected on every platform so an image extracts the
/// same way everywhere.
pub fn is_drive_relative_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic()) && chars.next() == Some(':')
}

/// Make `path` absolute (against the current directory) and lexically
/// normalize it.
pub fn absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(path),
            Err(_) => path.to_path_buf(),
        }
    };
    normalize(&joined)
}

/// Lexically normalize a path (`path.resolve` semantics, without touching the
/// file system).
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Create a uniquely named directory under `parent` (`mkdtemp`).
pub fn mkdtemp(parent: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    for attempt in 0..1000 {
        let candidate = parent.join(format!(
            "{prefix}{}-{}-{attempt}",
            std::process::id(),
            stamp
        ));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not create a unique temporary directory",
    ))
}

/// Read `<out_dir>/.artifact.json`. A malformed file is an error, a missing
/// file is `None`.
pub fn read_framework_artifact(out_dir: &Path) -> Result<Option<FrameworkArtifact>> {
    let file = out_dir.join(".artifact.json");
    if !file.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&file).map_err(|err| {
        Error::new("INVALID_ARTIFACT", format!("invalid .artifact.json: {err}"))
            .detail("filePath", json!(file.to_string_lossy()))
    })?;
    let value: Value = serde_json::from_str(&text).map_err(|err| {
        Error::new("INVALID_ARTIFACT", format!("invalid .artifact.json: {err}"))
            .detail("filePath", json!(file.to_string_lossy()))
    })?;
    let string = |key: &str| -> String {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let name = string("name");
    Ok(Some(FrameworkArtifact {
        name: if name.is_empty() {
            format!(
                "framework_{}_{}",
                segment(&string("oem")),
                segment(&string("vendor"))
            )
        } else {
            name
        },
        oem: string("oem"),
        vendor: string("vendor"),
        root_dir: PathBuf::from(string("rootDir")),
        jar_path: PathBuf::from(string("jarPath")),
        updated_at: value.get("updatedAt").and_then(Value::as_u64).unwrap_or(0) as u128,
    }))
}

fn artifact_json(artifact: &FrameworkArtifact) -> Value {
    json!({
        "name": artifact.name,
        "oem": artifact.oem,
        "vendor": artifact.vendor,
        "rootDir": artifact.root_dir.to_string_lossy(),
        "jarPath": artifact.jar_path.to_string_lossy(),
        "updatedAt": artifact.updated_at as u64,
    })
}

/// Resolve the layout, consulting `adb` for OEM/vendor when a device is
/// usable. `adb` is `None` for offline commands.
pub fn resolve_framework_layout(
    request: &FrameworkLayoutRequest,
    mut adb: Option<&mut AdbClient>,
) -> Result<FrameworkLayout> {
    let explicit_out_dir = request
        .out_dir
        .as_ref()
        .filter(|path| !path.as_os_str().is_empty())
        .map(|path| absolute(path));
    let previous = match &explicit_out_dir {
        Some(dir) => read_framework_artifact(dir)?,
        None => None,
    };

    let mut oem = request.oem.clone().unwrap_or_default();
    let mut vendor = request.vendor.clone().unwrap_or_default();
    if oem.is_empty() {
        if let Some(previous) = &previous {
            oem = previous.oem.clone();
        }
    }
    if vendor.is_empty() {
        if let Some(previous) = &previous {
            vendor = previous.vendor.clone();
        }
    }

    if let Some(client) = adb.as_mut() {
        if request.device || oem.is_empty() || vendor.is_empty() || vendor == "unknown" {
            let mut selected = false;
            match client.select() {
                Ok(()) => selected = true,
                Err(err) => {
                    let ambiguous = err.code == "ADB_DEVICE_AMBIGUOUS";
                    if request.device || request.serial_requested || ambiguous {
                        return Err(err);
                    }
                }
            }
            if selected {
                if oem.is_empty() {
                    oem = client.oem()?;
                }
                if vendor.is_empty() || vendor == "unknown" {
                    vendor = client.vendor()?;
                }
            }
        }
    }

    if oem.is_empty() {
        return Err(Error::new(
            "MISSING_OEM",
            "specify --oem for offline processing or provide .artifact.json at --out-dir",
        ));
    }
    let oem = segment(&oem);
    let vendor = segment(&vendor);
    let out_dir = match explicit_out_dir {
        Some(dir) => dir,
        None => absolute(&request.home.join("out")),
    };
    let source_dir = match &request.source_dir {
        Some(path) => absolute(path),
        None => absolute(&request.home.join("source")),
    };
    let out_tmp_dir = out_dir.join("out_tmp");
    if source_dir == out_dir
        || is_inside_dir(&source_dir, &out_tmp_dir)
        || is_inside_dir(&source_dir, &out_dir)
    {
        return Err(Error::new(
            "INVALID_LAYOUT",
            "framework output must not be inside the source directory",
        ));
    }

    let name = format!("framework_{oem}_{vendor}");
    let jar_path = out_dir.join(format!("{name}.jar"));
    let artifact = FrameworkArtifact {
        name,
        oem,
        vendor,
        root_dir: out_dir.clone(),
        jar_path,
        updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or(0),
    };
    std::fs::create_dir_all(&out_dir).map_err(|err| {
        Error::file(
            format!("Failed to create '{}': {err}", out_dir.display()),
            Some(&out_dir.to_string_lossy()),
        )
    })?;
    let record = out_dir.join(".artifact.json");
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(&artifact_json(&artifact)).unwrap_or_default()
    );
    std::fs::write(&record, body).map_err(|err| {
        Error::file(
            format!("Failed to write '{}': {err}", record.display()),
            Some(&record.to_string_lossy()),
        )
    })?;

    Ok(FrameworkLayout {
        source_dir,
        out_dir,
        out_tmp_dir,
        artifact,
    })
}

/// `{session, oem, vendor, jarPath}` summary returned by the CLI.
pub fn summarize_artifact(layout: &FrameworkLayout) -> Value {
    json!({
        "session": layout.artifact.name,
        "oem": layout.artifact.oem,
        "vendor": layout.artifact.vendor,
        "jarPath": layout.artifact.jar_path.to_string_lossy(),
    })
}

/// Layout as the CLI reports it (same field names as the TypeScript version).
pub fn layout_json(layout: &FrameworkLayout) -> Value {
    json!({
        "sourceDir": layout.source_dir.to_string_lossy(),
        "outDir": layout.out_dir.to_string_lossy(),
        "outTmpDir": layout.out_tmp_dir.to_string_lossy(),
        "artifact": artifact_json(&layout.artifact),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_normalizes_device_names() {
        assert_eq!(segment("SM-T970/Android 13"), "sm-t970_android_13");
        assert_eq!(segment(".."), "unknown");
        assert_eq!(segment(""), "unknown");
        assert_eq!(segment("Google.Pixel_7"), "google.pixel_7");
        assert_eq!(segment("  --  "), "unknown");
        assert_eq!(segment("-a.b-"), "a.b");
    }

    #[test]
    fn layout_requires_an_oem_offline() {
        let request = FrameworkLayoutRequest {
            home: std::env::temp_dir().join("afe-home-none"),
            ..FrameworkLayoutRequest::default()
        };
        let error = resolve_framework_layout(&request, None).unwrap_err();
        assert_eq!(error.code, "MISSING_OEM");
        assert_eq!(
            error.message,
            "specify --oem for offline processing or provide .artifact.json at --out-dir"
        );
    }

    #[test]
    fn layout_defaults_and_artifact_roundtrip() {
        let dir = mkdtemp(&std::env::temp_dir(), "afe-layout-").unwrap();
        let out_dir = dir.join("out");
        let request = FrameworkLayoutRequest {
            home: dir.clone(),
            oem: Some("Samsung/Device".to_string()),
            out_dir: Some(out_dir.clone()),
            ..FrameworkLayoutRequest::default()
        };
        let layout = resolve_framework_layout(&request, None).unwrap();
        assert_eq!(layout.artifact.name, "framework_samsung_device_unknown");
        // An explicit --out does not move the default source directory.
        assert_eq!(layout.source_dir, dir.join("source"));
        assert_eq!(layout.out_tmp_dir, out_dir.join("out_tmp"));
        assert!(out_dir.join(".artifact.json").is_file());

        // A second resolution reuses the recorded OEM/vendor.
        let reuse = FrameworkLayoutRequest {
            home: dir.clone(),
            out_dir: Some(out_dir.clone()),
            ..FrameworkLayoutRequest::default()
        };
        let layout = resolve_framework_layout(&reuse, None).unwrap();
        assert_eq!(layout.artifact.oem, "samsung_device");
        assert_eq!(layout.artifact.vendor, "unknown");

        // Defaults sit directly under the AFE home: <home>/source, <home>/out.
        let default_home = mkdtemp(&std::env::temp_dir(), "afe-home-").unwrap();
        let request = FrameworkLayoutRequest {
            home: default_home.clone(),
            oem: Some("Pixel".to_string()),
            ..FrameworkLayoutRequest::default()
        };
        let layout = resolve_framework_layout(&request, None).unwrap();
        assert_eq!(layout.source_dir, default_home.join("source"));
        assert_eq!(layout.out_dir, default_home.join("out"));
        assert_eq!(layout.out_tmp_dir, default_home.join("out").join("out_tmp"));
        assert!(layout.out_dir.join(".artifact.json").is_file());

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&default_home).ok();
    }

    #[test]
    fn output_inside_source_is_rejected() {
        let dir = mkdtemp(&std::env::temp_dir(), "afe-layout-nested-").unwrap();
        let out_dir = dir.join("out");
        let request = FrameworkLayoutRequest {
            home: dir.clone(),
            oem: Some("oem".to_string()),
            source_dir: Some(dir.clone()),
            out_dir: Some(out_dir),
            ..FrameworkLayoutRequest::default()
        };
        let error = resolve_framework_layout(&request, None).unwrap_err();
        assert_eq!(error.code, "INVALID_LAYOUT");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn malformed_artifact_is_reported() {
        let dir = mkdtemp(&std::env::temp_dir(), "afe-layout-bad-").unwrap();
        std::fs::write(dir.join(".artifact.json"), "{not json").unwrap();
        let error = read_framework_artifact(&dir).unwrap_err();
        assert_eq!(error.code, "INVALID_ARTIFACT");
        assert!(error.message.starts_with("invalid .artifact.json: "));
        std::fs::remove_dir_all(&dir).ok();
    }
}

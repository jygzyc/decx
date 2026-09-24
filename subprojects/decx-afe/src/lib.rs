//! Android Framework Extract (AFE): collect framework artifacts from a
//! connected Android device, expand their dex payloads, and pack the result
//! into one framework jar.
//!
//! Pure-Rust port of the former TypeScript extension
//! `extensions/ard-framework`. The module split mirrors the CLI commands:
//!
//! - [`adb`] — device access and output parsers for the `device` commands.
//! - [`collector`] — tiered device pull for `collect`.
//! - [`processor`] — payload expansion (native-only ext4/EROFS readers) and
//!   the atomic `out_tmp` swap.
//! - [`packer`] — framework jar assembly.
//! - [`layout`] — artifact/layout resolution and `.artifact.json`.
//! - [`flows`] — command flows returning the JSON payloads.
//! - [`process`] — child-process helper with a wall-clock timeout.
//! - [`zip`] — native zip/jar reader/writer (no Info-ZIP dependency).
//! - [`ext4`] / [`erofs`] — native payload image readers.
//! - [`test_support`] — test-only helpers (synthesized ext4 images).

pub mod adb;
pub mod collector;
pub mod device;
pub mod erofs;
pub mod error;
pub mod ext4;
pub mod flows;
pub mod hash;
pub mod layout;
pub mod packer;
pub mod process;
pub mod processor;
#[cfg(test)]
pub mod test_support;
pub mod zip;

/// Root directory for the default `source`/`out` directories: `AFE_HOME`,
/// then `$DECX_HOME/afe`, then `<home>/.decx/afe` where `<home>` is
/// `$HOME`/`%USERPROFILE%`, then `%HOMEDRIVE%%HOMEPATH%`.
pub fn afe_home() -> std::path::PathBuf {
    afe_home_from(|key| std::env::var(key).ok())
}

fn afe_home_from(mut lookup: impl FnMut(&str) -> Option<String>) -> std::path::PathBuf {
    if let Some(value) = non_empty(&mut lookup, "AFE_HOME") {
        return std::path::PathBuf::from(value);
    }
    if let Some(value) = non_empty(&mut lookup, "DECX_HOME") {
        return std::path::PathBuf::from(value).join("afe");
    }
    home_dir_from(&mut lookup).join(".decx").join("afe")
}

fn non_empty(lookup: &mut impl FnMut(&str) -> Option<String>, key: &str) -> Option<String> {
    lookup(key).filter(|value| !value.trim().is_empty())
}

fn home_dir_from(lookup: &mut impl FnMut(&str) -> Option<String>) -> std::path::PathBuf {
    for key in ["HOME", "USERPROFILE"] {
        if let Some(value) = non_empty(lookup, key) {
            return std::path::PathBuf::from(value);
        }
    }
    match (
        non_empty(lookup, "HOMEDRIVE"),
        non_empty(lookup, "HOMEPATH"),
    ) {
        (Some(drive), Some(path)) => std::path::PathBuf::from(format!("{drive}{path}")),
        _ => std::path::PathBuf::from("."),
    }
}

/// Default adb binary: `AFE_ADB`, then the legacy `DECX_ADB`, then `adb`.
pub fn default_adb_path() -> String {
    for key in ["AFE_ADB", "DECX_ADB"] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                return value;
            }
        }
    }
    "adb".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn home_from(env: &[(&str, &str)]) -> PathBuf {
        let env: BTreeMap<String, String> = env
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        afe_home_from(|key| env.get(key).cloned())
    }

    #[test]
    fn home_prefers_explicit_overrides() {
        assert_eq!(
            home_from(&[("AFE_HOME", "/afe"), ("HOME", "/home/user")]),
            PathBuf::from("/afe")
        );
        // A bare DECX_HOME is the decx root: AFE lives in its `afe/` subdir.
        assert_eq!(
            home_from(&[("DECX_HOME", "/decx"), ("HOME", "/home/user")]),
            PathBuf::from("/decx").join("afe")
        );
        assert_eq!(
            home_from(&[("AFE_HOME", "/afe"), ("DECX_HOME", "/decx")]),
            PathBuf::from("/afe")
        );
    }

    #[test]
    fn home_falls_back_to_platform_variables() {
        assert_eq!(
            home_from(&[("HOME", "/home/user")]),
            PathBuf::from("/home/user").join(".decx").join("afe")
        );
        assert_eq!(
            home_from(&[("USERPROFILE", "C:\\Users\\user")]),
            PathBuf::from("C:\\Users\\user").join(".decx").join("afe")
        );
        assert_eq!(
            home_from(&[("HOMEDRIVE", "C:"), ("HOMEPATH", "\\Users\\user")]),
            PathBuf::from("C:\\Users\\user").join(".decx").join("afe")
        );
        assert_eq!(home_from(&[]), PathBuf::from(".").join(".decx").join("afe"));
    }
}

//! Android Framework Extract (AFE): collect framework artifacts from a
//! connected Android device, expand their dex payloads, and pack the result
//! into one framework jar.
//!
//! Pure-Rust port of the former TypeScript extension
//! `extensions/ard-framework`. The module split mirrors the CLI commands:
//!
//! - [`adb`] — device access and output parsers for the `device` commands.
//! - [`collector`] — tiered device pull for `collect`.
//! - [`processor`] — payload expansion (native ext4/EROFS readers with the
//!   debugfs/erofs-utils fallback) and the atomic `out_tmp` swap.
//! - [`packer`] — framework jar assembly.
//! - [`layout`] — artifact/layout resolution and `.artifact.json`.
//! - [`flows`] — command flows returning the JSON payloads.
//! - [`framework_tools`] — lazy external-tool resolution.
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
pub mod framework_tools;
pub mod hash;
pub mod layout;
pub mod packer;
pub mod process;
pub mod processor;
#[cfg(test)]
pub mod test_support;
pub mod zip;

/// Home directory used for the default output location: `AFE_HOME`, then the
/// legacy `DECX_HOME`, then `$HOME`/`%USERPROFILE%`, then
/// `%HOMEDRIVE%%HOMEPATH%`.
pub fn afe_home() -> std::path::PathBuf {
    afe_home_from(|key| std::env::var(key).ok())
}

fn afe_home_from(mut lookup: impl FnMut(&str) -> Option<String>) -> std::path::PathBuf {
    for key in ["AFE_HOME", "DECX_HOME", "HOME", "USERPROFILE"] {
        if let Some(value) = lookup(key) {
            if !value.trim().is_empty() {
                return std::path::PathBuf::from(value);
            }
        }
    }
    match (lookup("HOMEDRIVE"), lookup("HOMEPATH")) {
        (Some(drive), Some(path)) if !drive.is_empty() && !path.is_empty() => {
            std::path::PathBuf::from(format!("{drive}{path}"))
        }
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
        assert_eq!(
            home_from(&[("DECX_HOME", "/decx"), ("HOME", "/home/user")]),
            PathBuf::from("/decx")
        );
    }

    #[test]
    fn home_falls_back_to_platform_variables() {
        assert_eq!(
            home_from(&[("HOME", "/home/user")]),
            PathBuf::from("/home/user")
        );
        assert_eq!(
            home_from(&[("USERPROFILE", "C:\\Users\\user")]),
            PathBuf::from("C:\\Users\\user")
        );
        assert_eq!(
            home_from(&[("HOMEDRIVE", "C:"), ("HOMEPATH", "\\Users\\user")]),
            PathBuf::from("C:\\Users\\user")
        );
        assert_eq!(home_from(&[]), PathBuf::from("."));
    }
}

//! Command-line parsing and SLEIGH specs-root resolution.

use std::path::{Path, PathBuf};

pub const USAGE: &str = "usage: kuna-server <target-file> --port <port> [--specs <dir>] \
[--mode <auto|reliable|aggressive|fast>] [--language <c-language|rust-language|auto>] \
[--slice <name>] [--host 127.0.0.1]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    pub target: PathBuf,
    pub port: u16,
    pub host: String,
    pub specs: Option<PathBuf>,
    pub mode: Option<String>,
    pub language: Option<String>,
    pub slice: Option<String>,
}

fn take_value(argv: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    *index += 1;
    argv.get(*index)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| format!("missing value for {flag}\n{USAGE}"))
}

/// Parse `kuna-server` arguments (without argv[0]). Pure and side-effect free
/// so unit tests can exercise every error path.
pub fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut target: Option<PathBuf> = None;
    let mut port: Option<u16> = None;
    let mut host = String::from("127.0.0.1");
    let mut specs = None;
    // Server default is `reliable`; `--mode auto` opts into size-based mode
    // selection via `kuna_decomp::modes::resolve_mode_for_size`.
    let mut mode = Some(String::from("reliable"));
    let mut language = None;
    let mut slice = None;

    let mut index = 0;
    while index < argv.len() {
        let arg = argv[index].as_str();
        match arg {
            "--port" => {
                let value = take_value(argv, &mut index, "--port")?;
                let parsed: u16 = value.parse().map_err(|_| {
                    format!("invalid --port value {value:?} (expected 1..65535)\n{USAGE}")
                })?;
                if parsed == 0 {
                    return Err(format!(
                        "invalid --port value {value:?} (expected 1..65535)\n{USAGE}"
                    ));
                }
                port = Some(parsed);
            }
            "--host" => host = take_value(argv, &mut index, "--host")?,
            "--specs" => specs = Some(PathBuf::from(take_value(argv, &mut index, "--specs")?)),
            "--mode" => mode = Some(take_value(argv, &mut index, "--mode")?),
            "--language" => language = Some(take_value(argv, &mut index, "--language")?),
            "--slice" => slice = Some(take_value(argv, &mut index, "--slice")?),
            other if other.starts_with('-') => {
                return Err(format!("unknown flag {other:?}\n{USAGE}"));
            }
            other => {
                if target.is_some() {
                    return Err(format!("unexpected extra positional argument {other:?}\n{USAGE}"));
                }
                target = Some(PathBuf::from(other));
            }
        }
        index += 1;
    }

    let target = target.ok_or_else(|| format!("missing <target-file>\n{USAGE}"))?;
    let port = port.ok_or_else(|| format!("missing --port\n{USAGE}"))?;
    Ok(Args {
        target,
        port,
        host,
        specs,
        mode,
        language,
        slice,
    })
}

/// Candidate specs roots in precedence order:
/// `--specs` > `KUNA_SPECS` > `<exe_dir>/specs` > `<exe_dir>/../specs`.
pub fn specs_candidates(
    explicit: Option<&Path>,
    env_value: Option<&Path>,
    exe_dir: &Path,
) -> Vec<PathBuf> {
    let mut candidates = Vec::with_capacity(4);
    if let Some(dir) = explicit {
        candidates.push(dir.to_path_buf());
    }
    if let Some(dir) = env_value {
        candidates.push(dir.to_path_buf());
    }
    candidates.push(exe_dir.join("specs"));
    candidates.push(exe_dir.join("..").join("specs"));
    candidates
}

fn count_extension_recursive(dir: &Path, extension: &str) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            count += count_extension_recursive(&path, extension);
        } else if path.extension().and_then(|value| value.to_str()) == Some(extension) {
            count += 1;
        }
    }
    count
}

/// Number of compiled SLEIGH specs (`*.sla`) under `dir` (recursive).
pub fn count_compiled_specs(dir: &Path) -> usize {
    count_extension_recursive(dir, "sla")
}

fn no_compiled_specs_message(dir: &Path) -> String {
    let uncompiled = count_extension_recursive(dir, "slaspec");
    let detail = if uncompiled > 0 {
        format!(
            "the tree holds {uncompiled} uncompiled .slaspec files instead; \
             run the build's spec step (modules/decx-kuna/build.sh) to compile them with slacomp"
        )
    } else {
        "the directory holds no SLEIGH specs at all".to_string()
    };
    format!(
        "no compiled SLEIGH specs (*.sla) under {} ({detail}); set KUNA_SPECS or pass --specs to \
         the extracted archive's specs/ directory (archive layout: kuna-server/bin/kuna-server + \
         kuna-server/specs/), or run modules/decx-kuna/build.sh",
        dir.display()
    )
}

/// Resolve the specs root. The first candidate that exists wins; it must hold
/// at least one `*.sla`, otherwise resolution fails instead of silently falling
/// through to a lower-precedence directory.
pub fn resolve_specs_root(
    explicit: Option<&Path>,
    env_value: Option<&Path>,
    exe_dir: &Path,
) -> Result<PathBuf, String> {
    let candidates = specs_candidates(explicit, env_value, exe_dir);
    let existing = candidates.iter().find(|candidate| candidate.is_dir());
    let Some(dir) = existing else {
        return Err(format!(
            "no specs root found (tried --specs, KUNA_SPECS, <exe_dir>/specs and <exe_dir>/../specs); \
             set KUNA_SPECS or pass --specs to the extracted archive's specs/ directory (archive \
             layout: kuna-server/bin/kuna-server + kuna-server/specs/), or run modules/decx-kuna/build.sh"
        ));
    };
    if count_compiled_specs(dir) == 0 {
        return Err(no_compiled_specs_message(dir));
    }
    Ok(dir.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parses_target_port_and_flags() {
        let args = parse_args(&argv(&[
            "/tmp/sample.elf",
            "--port",
            "45999",
            "--specs",
            "/opt/kuna/specs",
            "--mode",
            "reliable",
            "--language",
            "rust-language",
            "--slice",
            "arm64",
            "--host",
            "0.0.0.0",
        ]))
        .unwrap();
        assert_eq!(args.target, PathBuf::from("/tmp/sample.elf"));
        assert_eq!(args.port, 45999);
        assert_eq!(args.host, "0.0.0.0");
        assert_eq!(args.specs, Some(PathBuf::from("/opt/kuna/specs")));
        assert_eq!(args.mode.as_deref(), Some("reliable"));
        assert_eq!(args.language.as_deref(), Some("rust-language"));
        assert_eq!(args.slice.as_deref(), Some("arm64"));
    }

    #[test]
    fn flags_may_precede_the_target() {
        let args = parse_args(&argv(&["--port", "1", "target.bin"])).unwrap();
        assert_eq!(args.target, PathBuf::from("target.bin"));
        assert_eq!(args.port, 1);
    }

    #[test]
    fn defaults_are_localhost_and_no_overrides() {
        let args = parse_args(&argv(&["target.bin", "--port", "8000"])).unwrap();
        assert_eq!(args.host, "127.0.0.1");
        assert_eq!(args.specs, None);
        assert_eq!(args.mode.as_deref(), Some("reliable"));
        assert_eq!(args.language, None);
        assert_eq!(args.slice, None);
    }

    #[test]
    fn rejects_missing_target_and_port() {
        assert!(parse_args(&argv(&["--port", "8000"]))
            .unwrap_err()
            .contains("missing <target-file>"));
        assert!(parse_args(&argv(&["target.bin"]))
            .unwrap_err()
            .contains("missing --port"));
    }

    #[test]
    fn rejects_unknown_flags_and_missing_values() {
        assert!(parse_args(&argv(&["target.bin", "--port", "1", "--wat"]))
            .unwrap_err()
            .contains("unknown flag"));
        assert!(parse_args(&argv(&["target.bin", "--port"]))
            .unwrap_err()
            .contains("missing value for --port"));
        assert!(parse_args(&argv(&["target.bin", "--port", "1", "extra"]))
            .unwrap_err()
            .contains("unexpected extra positional"));
    }

    #[test]
    fn rejects_out_of_range_ports() {
        assert!(parse_args(&argv(&["target.bin", "--port", "0"]))
            .unwrap_err()
            .contains("invalid --port"));
        assert!(parse_args(&argv(&["target.bin", "--port", "70000"]))
            .unwrap_err()
            .contains("invalid --port"));
        assert!(parse_args(&argv(&["target.bin", "--port", "abc"]))
            .unwrap_err()
            .contains("invalid --port"));
    }

    #[test]
    fn specs_candidates_follow_precedence_order() {
        let exe_dir = Path::new("/opt/kuna-server/bin");
        let candidates = specs_candidates(
            Some(Path::new("/explicit/specs")),
            Some(Path::new("/env/specs")),
            exe_dir,
        );
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("/explicit/specs"),
                PathBuf::from("/env/specs"),
                PathBuf::from("/opt/kuna-server/bin/specs"),
                PathBuf::from("/opt/kuna-server/bin/../specs"),
            ]
        );
        assert_eq!(candidates.len(), 4);
    }

    #[test]
    fn specs_candidates_without_overrides_only_use_exe_dir() {
        let candidates = specs_candidates(None, None, Path::new("/opt/bin"));
        assert_eq!(
            candidates,
            vec![PathBuf::from("/opt/bin/specs"), PathBuf::from("/opt/bin/../specs")]
        );
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kuna-server-args-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_prefers_explicit_then_env_then_exe_dir() {
        let root = temp_dir("resolve");
        let explicit = root.join("explicit");
        let env_dir = root.join("env");
        let exe_specs = root.join("exe/specs");
        for dir in [&explicit, &env_dir, &exe_specs] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("x86.sla"), b"sla").unwrap();
        }

        let resolved =
            resolve_specs_root(Some(&explicit), Some(&env_dir), &root.join("exe")).unwrap();
        assert_eq!(resolved, explicit);

        let resolved = resolve_specs_root(None, Some(&env_dir), &root.join("exe")).unwrap();
        assert_eq!(resolved, env_dir);

        let resolved = resolve_specs_root(None, None, &root.join("exe")).unwrap();
        assert_eq!(resolved, exe_specs);
    }

    #[test]
    fn resolve_falls_through_missing_candidates_to_parent_specs() {
        let root = temp_dir("parent");
        let exe_dir = root.join("bin");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let parent_specs = root.join("specs");
        std::fs::create_dir_all(&parent_specs).unwrap();
        std::fs::write(parent_specs.join("x86.sla"), b"sla").unwrap();

        let resolved = resolve_specs_root(None, None, &exe_dir).unwrap();
        assert_eq!(
            resolved.canonicalize().unwrap(),
            parent_specs.canonicalize().unwrap()
        );
    }

    #[test]
    fn resolve_errors_on_uncompiled_tree() {
        let root = temp_dir("uncompiled");
        let specs = root.join("specs");
        std::fs::create_dir_all(specs.join("Ghidra/Processors/X86/data/languages")).unwrap();
        std::fs::write(
            specs.join("Ghidra/Processors/X86/data/languages/x86.slaspec"),
            b"spec",
        )
        .unwrap();

        let error = resolve_specs_root(None, Some(&specs), &root).unwrap_err();
        assert!(error.contains("*.sla"), "{error}");
        assert!(error.contains("slaspec"), "{error}");
        assert!(error.contains("KUNA_SPECS"), "{error}");
        assert!(error.contains("archive layout"), "{error}");
    }

    #[test]
    fn resolve_errors_when_no_candidate_exists() {
        let root = temp_dir("missing");
        let error = resolve_specs_root(None, None, &root.join("bin")).unwrap_err();
        assert!(error.contains("no specs root found"), "{error}");
        assert!(error.contains("KUNA_SPECS"), "{error}");
    }
}

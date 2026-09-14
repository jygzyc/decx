//! One-time engine bootstrap: load the target image, commit analysis, classify
//! the canonical function inventory and build the xref index.
//!
//! This mirrors the in-process blueprint the upstream project ships in
//! `kuna-wasm` (`crates/kuna-wasm/src/lib.rs`): `load_program`'s mode/env
//! handling and `resolve_language`'s Rust-detection policy are adapted
//! verbatim, minus the browser-specific surface. The engine is mutable state
//! (`ConsoleProgram`), so all entry points take `&mut self`; the HTTP layer
//! serializes them behind a mutex.

use std::time::Instant;

use kuna_analysis::listing::xrefs::{build_with_focus, discovery_seeds, XrefIndex};
use kuna_analysis::loader::elf_shdr::read_image;
use kuna_analysis::loadimage_object::parse_object;
use kuna_analysis::sourcelang::{detect_compiler, Compiler};
use kuna_console::classify::Classifier;
use kuna_console::engine::{bootstrap_from_image, ConsoleProgram, EntrySelector, FunctionEntry};
use kuna_decomp::kuna_lang::OutLang;
use kuna_decomp::modes;

use crate::handlers::ApiError;

pub struct Engine {
    pub binary: String,
    pub specs_root: String,
    /// The decompiler program. Mutated by per-request decompiles.
    pub program: ConsoleProgram,
    /// Reference index over the image's decoded instruction stream.
    pub xrefs: XrefIndex,
    /// Canonical function inventory (one record per entry address, ascending).
    pub entries: Vec<FunctionEntry>,
    /// Parallel to `entries`: the `func`/`plt`/`thunk` classifier verdict.
    pub kinds: Vec<&'static str>,
    pub mode: &'static str,
    pub language: Option<&'static str>,
    /// Wall time spent in `Engine::build` (reported at startup).
    pub built_ms: u128,
}

impl Engine {
    /// Bootstrap the engine from `binary` with the compiled specs under
    /// `specs_root`. `requested_mode` follows kuna's `auto|reliable|aggressive|
    /// fast` vocabulary (`None` means `auto`); `requested_language` is
    /// `auto`/`c-language`/`rust-language` (`None`/`auto` detect Rust binaries).
    pub fn build(
        binary: &str,
        specs_root: &str,
        requested_mode: Option<&str>,
        requested_language: Option<&str>,
    ) -> Result<Engine, String> {
        let started = Instant::now();
        let binary_size = std::fs::metadata(binary)
            .map_err(|error| format!("cannot read target metadata for {binary}: {error}"))?
            .len();
        let mode = modes::resolve_mode_for_size(requested_mode, binary_size).ok_or_else(|| {
            let known: Vec<&str> = modes::mode_names().collect();
            format!(
                "unknown mode {:?} (known: {})",
                requested_mode.unwrap_or("auto"),
                known.join(", ")
            )
        })?;
        let language = resolve_language(binary, requested_language)?;

        // `want_fast_funcdisc = true`: keep the mode's discovery policy (the
        // `reliable` default leaves fast discovery off). There is no
        // per-request mode switching in v1, so a single startup policy applies.
        let program = load_program(binary, specs_root, mode, true, language)?;

        let entries = program.function_entries_canonical();
        let classifier =
            Classifier::new(&program, binary, entries.iter().map(|entry| entry.addr.get_offset()));
        let kinds: Vec<&'static str> = entries
            .iter()
            .map(|entry| classifier.kind(&program, &entry.name, entry.addr.get_offset()))
            .collect();

        let bytes = read_image(binary)
            .map_err(|error| format!("cannot read {binary} for xref analysis: {error}"))?;
        let file = parse_object(&*bytes)
            .map_err(|error| format!("cannot parse {binary} for xref analysis: {error}"))?;
        let inventory: Vec<u64> = entries.iter().map(|entry| entry.addr.get_offset()).collect();
        let seeds = discovery_seeds(&file, &inventory, program.arch().analysis_funcstart_patterns);
        let xrefs = build_with_focus(
            &file,
            program.arch(),
            program.arch().translate(),
            &seeds,
            &[],
        );

        Ok(Engine {
            binary: binary.to_string(),
            specs_root: specs_root.to_string(),
            program,
            xrefs,
            entries,
            kinds,
            mode,
            language,
            built_ms: started.elapsed().as_millis(),
        })
    }

    /// Resolve a request's `name`/`address` selector to exactly one body entry.
    /// Exactly one selector is required; both missing or both present is an
    /// `INVALID_PARAMETER`, an unresolvable selector a `FUNCTION_NOT_FOUND`.
    pub fn resolve_entry(
        &self,
        name: Option<&str>,
        address: Option<&str>,
    ) -> Result<FunctionEntry, ApiError> {
        let name = name.map(str::trim).filter(|value| !value.is_empty());
        let address = address.map(str::trim).filter(|value| !value.is_empty());
        let selector = match (name, address) {
            (Some(_), Some(_)) => {
                return Err(ApiError::invalid(
                    "specify exactly one of \"name\" or \"address\"",
                ))
            }
            (None, None) => {
                return Err(ApiError::invalid("either \"name\" or \"address\" is required"))
            }
            (Some(name), None) => EntrySelector::parse(name),
            (None, Some(address)) => {
                let vma = parse_address(address).ok_or_else(|| {
                    ApiError::invalid(format!(
                        "invalid address {address:?} (expected 0x… hex or decimal)"
                    ))
                })?;
                EntrySelector::Numeric(vma)
            }
        };
        self.program
            .resolve_body_entry(&selector)
            .map_err(|error| ApiError::function_not_found(error.to_string()))
    }

    /// The function whose byte extent contains `vma`, if any. Canonical
    /// entries are address-ordered (`function_entries_canonical` is built from
    /// a `BTreeMap` keyed by entry offset), so the search is a binary search
    /// plus one extent check.
    pub fn containing_function(&self, vma: u64) -> Option<(String, u64)> {
        if let Some(entry) = self.program.find_entry_at(vma) {
            return Some((entry.name, entry.addr.get_offset()));
        }
        let index = self
            .entries
            .partition_point(|entry| entry.addr.get_offset() <= vma);
        if index == 0 {
            return None;
        }
        let entry = &self.entries[index - 1];
        let start = entry.addr.get_offset();
        let extent = self.program.function_extent_at(start);
        (extent > 0 && vma < start.saturating_add(extent))
            .then(|| (entry.name.clone(), start))
    }
}

/// Parse an explicit `address` selector: `0x`-prefixed hex or plain decimal.
/// Bare non-decimal tokens are rejected (they are names, not addresses).
pub fn parse_address(token: &str) -> Option<u64> {
    let trimmed = token.trim();
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        if hex.is_empty() {
            return None;
        }
        return u64::from_str_radix(hex, 16).ok();
    }
    if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    trimmed.parse::<u64>().ok()
}

/// The output language for this run: an explicit name, or the auto policy that
/// marks Rust binaries (`kuna_analysis::sourcelang`, the port of Ghidra's
/// `SourceLanguageAnalyzer`). Detection failure leaves the C default in place.
fn resolve_language(binary: &str, requested: Option<&str>) -> Result<Option<&'static str>, String> {
    let explicit = match requested {
        None | Some("auto") | Some("") => None,
        Some(name) => Some(
            OutLang::from_print_name(name)
                .ok_or_else(|| {
                    format!(
                        "unknown output language {name:?} (expected auto, or one of: {})",
                        OutLang::names().join(", ")
                    )
                })?
                .print_name(),
        ),
    };
    if explicit.is_some() {
        return Ok(explicit);
    }
    let Ok(bytes) = read_image(binary) else {
        return Ok(None);
    };
    let Ok(file) = parse_object(&*bytes) else {
        return Ok(None);
    };
    Ok(match detect_compiler(&file, &bytes) {
        Compiler::Rustc => Some("rust-language"),
        _ => None,
    })
}

/// Bootstrap the architecture and run the analysis commit, then inject the
/// `decompile-all` discovery defaults unless the selected mode owns those
/// options (mode-then-explicit-default ordering, as in the upstream CLI).
#[allow(clippy::too_many_arguments)]
fn load_program(
    binary: &str,
    spec_root: &str,
    mode: &str,
    want_fast_funcdisc: bool,
    language: Option<&str>,
) -> Result<ConsoleProgram, String> {
    let overrides = modes::mode_overrides(mode)
        .ok_or_else(|| format!("unknown mode {mode:?}"))?;
    let owns_arm64e = overrides
        .iter()
        .any(|(option, _)| *option == "macho-arm64e");
    let previous_arm64e = std::env::var_os("KUNA_MACHO_ARM64E");
    if owns_arm64e {
        std::env::remove_var("KUNA_MACHO_ARM64E");
    }
    if overrides
        .iter()
        .any(|(option, value)| *option == "macho-arm64e" && *value == "on")
    {
        std::env::set_var("KUNA_MACHO_ARM64E", "1");
    }

    let spec_roots = vec![spec_root.to_string()];
    let bootstrap = bootstrap_from_image(binary, "", &spec_roots);
    if owns_arm64e {
        match previous_arm64e {
            Some(value) => std::env::set_var("KUNA_MACHO_ARM64E", value),
            None => std::env::remove_var("KUNA_MACHO_ARM64E"),
        }
    }
    let mut program = bootstrap
        .map_err(|error| format!("could not build an architecture for {binary}: {}", error.explain()))?;

    program
        .arch_mut()
        .apply_mode(mode)
        .map_err(|error| format!("mode {mode}: {}", error.explain()))?;
    if !want_fast_funcdisc {
        program
            .arch_mut()
            .set_kuna_option("fast_funcdisc", "off")
            .map_err(|error| format!("option fast_funcdisc: {}", error.explain()))?;
    }
    let mode_owns = |name: &str| overrides.iter().any(|(option, _)| *option == name);

    if !mode_owns("listing") {
        program
            .arch_mut()
            .set_kuna_option("listing", "on")
            .map_err(|error| format!("option listing: {}", error.explain()))?;
    }
    if let Some(name) = language {
        program
            .arch_mut()
            .set_print_language_checked(name)
            .map_err(|error| error.explain().to_string())?;
    }

    use object::Object;
    let non_x86_64 = if !mode_owns("funcstart_patterns") || !mode_owns("aif") {
        read_image(binary)
            .ok()
            .and_then(|bytes| {
                parse_object(&*bytes)
                    .ok()
                    .map(|file| file.architecture() != object::Architecture::X86_64)
            })
            .unwrap_or(false)
    } else {
        false
    };
    if non_x86_64 && !mode_owns("funcstart_patterns") {
        program
            .arch_mut()
            .set_kuna_option("funcstart_patterns", "on")
            .map_err(|error| format!("option funcstart_patterns: {}", error.explain()))?;
    }
    if non_x86_64 && !mode_owns("aif") {
        program
            .arch_mut()
            .set_kuna_option("aif", "on")
            .map_err(|error| format!("option aif: {}", error.explain()))?;
    }

    program
        .commit_pending_analysis()
        .map_err(|error| format!("read symbols (analysis commit) failed: {}", error.explain()))?;
    Ok(program)
}

#[cfg(test)]
mod tests {
    use super::parse_address;

    #[test]
    fn parses_hex_and_decimal_addresses() {
        assert_eq!(parse_address("0x401000"), Some(0x401000));
        assert_eq!(parse_address("0X10"), Some(16));
        assert_eq!(parse_address("16"), Some(16));
        assert_eq!(parse_address(" 4096 "), Some(4096));
    }

    #[test]
    fn rejects_non_address_tokens() {
        assert_eq!(parse_address(""), None);
        assert_eq!(parse_address("   "), None);
        assert_eq!(parse_address("main"), None);
        assert_eq!(parse_address("0x"), None);
        assert_eq!(parse_address("0xzz"), None);
        assert_eq!(parse_address("-1"), None);
        assert_eq!(parse_address("deadbeef"), None);
        assert_eq!(parse_address("0xffffffffffffffffff"), None);
    }
}

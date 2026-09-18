//! Lazy resolution of the external tools the processor falls back to:
//! `debugfs` for ext4 images the native reader cannot handle, and
//! `fsck.erofs` / `extract.erofs` for EROFS images with unsupported
//! features. Port of the TypeScript `framework-tools.ts`.
//!
//! Resolution only inspects the environment and `PATH`; nothing is spawned
//! during resolution, so `afe process` does not require e2fsprogs or
//! erofs-utils unless one of their payloads actually needs the fallback.
//!
//! Overrides: `AFE_DEBUGFS`, `AFE_EXTRACT_EROFS`, `AFE_FSCK_EROFS`, with the
//! legacy `DECX_*` names still honored as a fallback.
//!
//! On Windows only the bare name and the `.exe` extension are probed: the
//! resolved tools are spawned with `Command::new`, which cannot execute
//! `.cmd`/`.bat` shims without going through `cmd /C`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::process::{spawn_capture, ProcessOutput};

/// Legacy environment variable names (still honored).
pub const DEBUGFS_ENV: &str = "DECX_DEBUGFS";
pub const EXTRACT_EROFS_ENV: &str = "DECX_EXTRACT_EROFS";
pub const FSCK_EROFS_ENV: &str = "DECX_FSCK_EROFS";

pub const DEBUGFS_MISSING: &str =
    "debugfs not found. Install e2fsprogs (e.g. 'apt install e2fsprogs') so debugfs is on PATH.";
pub const DEBUGFS_MISSING_WIN32: &str = "ext4 feature not supported by the native reader and debugfs has no native Windows binary. Run 'framework process' on Linux/macOS (e2fsprogs) to unpack this payload.";
pub const EROFS_MISSING: &str =
    "No EROFS extractor found. Install fsck.erofs/extract.erofs (erofs-utils).";
pub const EROFS_MISSING_WIN32: &str = "EROFS payload images need erofs-utils, which has no native Windows binary. Run 'framework process' on Linux/macOS (erofs-utils) to unpack this payload.";

/// Default timeout for external tool invocations.
pub const TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// Timeout used when unpacking a payload image.
pub const EXTRACT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// A resolved external tool: argv[0] is what gets executed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameworkTool {
    pub argv: Vec<String>,
}

impl FrameworkTool {
    pub fn new(argv: Vec<String>) -> Self {
        Self { argv }
    }
}

/// Options for one tool invocation.
#[derive(Debug, Clone, Default)]
pub struct ToolRunOptions {
    pub timeout: Option<std::time::Duration>,
    pub input: Option<Vec<u8>>,
}

/// Result of one tool invocation.
#[derive(Debug, Clone, Default)]
pub struct ToolRunResult {
    pub stdout: String,
    pub stderr: String,
    pub status: Option<i32>,
}

/// Runner used for actual tool invocations (injectable so resolution stays
/// testable without spawning processes).
pub type ToolRunner = Box<dyn Fn(&[String], &ToolRunOptions) -> ToolRunResult>;

/// Everything the resolver needs to stay testable: the platform, the
/// environment map, and the runner used for actual invocations.
pub struct ToolContext {
    pub platform: String,
    pub env: BTreeMap<String, String>,
    pub run: ToolRunner,
}

impl ToolContext {
    /// Context reading the real environment (`process.env` equivalent).
    pub fn from_process_env() -> Self {
        let env = std::env::vars().collect();
        Self {
            platform: platform_string(),
            env,
            run: Box::new(default_tool_run),
        }
    }

    /// Context with an explicit environment (used by tests).
    pub fn with_env(env: BTreeMap<String, String>) -> Self {
        Self {
            platform: platform_string(),
            env,
            run: Box::new(default_tool_run),
        }
    }

    fn is_windows(&self) -> bool {
        self.platform == "win32"
    }

    /// Environment override for one tool, preferring the `AFE_` name and the
    /// legacy `DECX_` name as a fallback. Empty values are ignored.
    fn env_override(&self, var: &str) -> Option<String> {
        let legacy = var.to_string();
        let preferred = var.replacen("DECX_", "AFE_", 1);
        for key in [&preferred, &legacy] {
            if let Some(value) = self.env.get(key.as_str()) {
                if !value.trim().is_empty() {
                    return Some(value.clone());
                }
            }
        }
        None
    }
}

/// Node-style platform string. Windows reports `win32`; macOS reports
/// `macos` where Node says `darwin` (the distinction only matters for the
/// Windows-specific messages, which are chosen by `platform == "win32"`).
pub fn platform_string() -> String {
    if cfg!(windows) {
        "win32".to_string()
    } else {
        std::env::consts::OS.to_string()
    }
}

/// Look up one `PATH` candidate list, first hit wins. Never spawns anything.
pub fn find_executable(name: &str, ctx: &ToolContext) -> Option<PathBuf> {
    // `.cmd`/`.bat` shims are deliberately not candidates: the runner spawns
    // the argv directly (`Command::new`), which Windows cannot use for batch
    // files. The fallback tools are native binaries anyway.
    let candidates: Vec<String> = if ctx.is_windows() {
        vec![name.to_string(), format!("{name}.exe")]
    } else {
        vec![name.to_string()]
    };
    let path_var = ctx.env.get("PATH").cloned().unwrap_or_default();
    let separator = if ctx.is_windows() { ';' } else { ':' };
    for entry in path_var.split(separator) {
        let entry = entry.trim();
        // Some Windows installers quote `PATH` entries; strip one surrounding
        // pair so the join below still points at the right directory.
        let entry = entry
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or(entry);
        if entry.is_empty() {
            continue;
        }
        for candidate in &candidates {
            let full = Path::new(entry).join(candidate);
            if ctx.is_windows() {
                if full.is_file() {
                    return Some(full);
                }
            } else if is_executable(&full) {
                return Some(full);
            }
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(path) {
            Ok(metadata) => metadata.is_file() && metadata.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Resolve `debugfs`: environment override first, then `PATH`.
pub fn resolve_debugfs_tool(ctx: &ToolContext) -> Result<FrameworkTool> {
    if let Some(explicit) = ctx.env_override(DEBUGFS_ENV) {
        return Ok(FrameworkTool::new(vec![explicit]));
    }
    if let Some(found) = find_executable("debugfs", ctx) {
        return Ok(FrameworkTool::new(vec![found
            .to_string_lossy()
            .to_string()]));
    }
    Err(Error::tool(if ctx.is_windows() {
        DEBUGFS_MISSING_WIN32
    } else {
        DEBUGFS_MISSING
    }))
}

/// Resolve an EROFS extractor: `AFE_FSCK_EROFS`/`AFE_EXTRACT_EROFS`, then
/// `fsck.erofs`, then `extract.erofs` on `PATH`.
pub fn resolve_erofs_tool(ctx: &ToolContext) -> Result<FrameworkTool> {
    if let Some(explicit) = ctx.env_override(FSCK_EROFS_ENV) {
        return Ok(FrameworkTool::new(vec![explicit]));
    }
    if let Some(explicit) = ctx.env_override(EXTRACT_EROFS_ENV) {
        return Ok(FrameworkTool::new(vec![explicit]));
    }
    for name in ["fsck.erofs", "extract.erofs"] {
        if let Some(found) = find_executable(name, ctx) {
            return Ok(FrameworkTool::new(vec![found
                .to_string_lossy()
                .to_string()]));
        }
    }
    Err(Error::tool(if ctx.is_windows() {
        EROFS_MISSING_WIN32
    } else {
        EROFS_MISSING
    }))
}

/// Basename of the resolved executable (tolerates Windows separators).
pub fn tool_executable_name(tool: &FrameworkTool) -> String {
    tool.argv
        .last()
        .map(|arg| {
            arg.replace('\\', "/")
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_string()
        })
        .unwrap_or_default()
}

/// `fsck.erofs` takes `--extract=DIR`, the others take `-x`.
pub fn is_fsck_erofs(tool: &FrameworkTool) -> bool {
    tool_executable_name(tool) == "fsck.erofs"
}

pub fn is_erofs_tool(tool: &FrameworkTool) -> bool {
    tool_executable_name(tool).contains("erofs")
}

/// Run a resolved tool with `args` appended to its argv.
pub fn run_framework_tool(
    tool: &FrameworkTool,
    args: &[String],
    options: &ToolRunOptions,
    ctx: &ToolContext,
) -> Result<ToolRunResult> {
    if tool.argv.is_empty() {
        return Err(Error::tool("framework tool is not resolved"));
    }
    let mut argv = tool.argv.clone();
    argv.extend(args.iter().cloned());
    Ok((ctx.run)(&argv, options))
}

/// Default runner: spawn the argv with a timeout, capturing output.
pub fn default_tool_run(argv: &[String], options: &ToolRunOptions) -> ToolRunResult {
    let Some((program, rest)) = argv.split_first() else {
        return ToolRunResult {
            stderr: "empty argv".to_string(),
            status: None,
            ..ToolRunResult::default()
        };
    };
    let mut command = std::process::Command::new(program);
    command.args(rest);
    let output: ProcessOutput = spawn_capture(
        command,
        options.timeout.unwrap_or(TOOL_TIMEOUT),
        options.input.clone(),
    );
    if output.timed_out {
        return ToolRunResult {
            stdout: output.stdout,
            stderr: format!(
                "command timed out after {}s",
                options.timeout.unwrap_or(TOOL_TIMEOUT).as_secs()
            ),
            status: None,
        };
    }
    ToolRunResult {
        stdout: output.stdout,
        stderr: output.spawn_error.unwrap_or(output.stderr),
        status: output.status,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(env: &[(&str, &str)]) -> ToolContext {
        ToolContext {
            platform: "linux".to_string(),
            env: env
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
            run: Box::new(|argv, _options| ToolRunResult {
                // Joined with '|' so a regression that collapses the argv into
                // a single element would be visible in the assertions.
                stdout: argv.join("|"),
                status: Some(0),
                ..ToolRunResult::default()
            }),
        }
    }

    #[test]
    fn env_override_wins_over_path() {
        let ctx = context(&[("AFE_DEBUGFS", "/custom/debugfs")]);
        let tool = resolve_debugfs_tool(&ctx).unwrap();
        assert_eq!(tool.argv, vec!["/custom/debugfs"]);
        // Legacy DECX_ name still works.
        let legacy = context(&[("DECX_DEBUGFS", "/legacy/debugfs")]);
        assert_eq!(
            resolve_debugfs_tool(&legacy).unwrap().argv,
            vec!["/legacy/debugfs"]
        );
    }

    #[test]
    fn resolved_tool_argv_is_passed_through() {
        let ctx = context(&[("AFE_DEBUGFS", "/custom/debugfs")]);
        let result = run_framework_tool(
            &resolve_debugfs_tool(&ctx).unwrap(),
            &["-R".to_string(), "rdump".to_string()],
            &ToolRunOptions::default(),
            &ctx,
        )
        .unwrap();
        assert_eq!(result.stdout, "/custom/debugfs|-R|rdump");
    }

    #[test]
    fn empty_argv_is_rejected() {
        let ctx = context(&[]);
        let err = run_framework_tool(
            &FrameworkTool::new(vec![]),
            &[],
            &ToolRunOptions::default(),
            &ctx,
        )
        .unwrap_err();
        assert_eq!(err.code, "TOOL_NOT_FOUND");
    }

    #[test]
    fn missing_tools_report_actionable_messages() {
        let ctx = context(&[("PATH", "")]);
        let err = resolve_debugfs_tool(&ctx).unwrap_err();
        assert_eq!(err.code, "TOOL_NOT_FOUND");
        assert_eq!(err.message, DEBUGFS_MISSING);
        let err = resolve_erofs_tool(&ctx).unwrap_err();
        assert_eq!(err.message, EROFS_MISSING);

        let windows = ToolContext {
            platform: "win32".to_string(),
            ..context(&[("PATH", "")])
        };
        assert_eq!(
            resolve_debugfs_tool(&windows).unwrap_err().message,
            DEBUGFS_MISSING_WIN32
        );
        assert_eq!(
            resolve_erofs_tool(&windows).unwrap_err().message,
            EROFS_MISSING_WIN32
        );
    }

    #[test]
    fn path_lookup_prefers_fsck_erofs() {
        let dir = std::env::temp_dir().join(format!("afe-tools-{}", std::process::id()));
        let nested = dir.join("bin");
        std::fs::create_dir_all(&nested).unwrap();
        for name in ["fsck.erofs", "extract.erofs"] {
            let file = nested.join(name);
            // Resolution only checks that the file exists/execs; the content
            // is never run, so it can be a neutral stub.
            std::fs::write(&file, b"stub").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let ctx = context(&[("PATH", nested.to_str().unwrap())]);
        let tool = resolve_erofs_tool(&ctx).unwrap();
        assert!(tool.argv[0].ends_with("fsck.erofs"));
        assert!(is_fsck_erofs(&tool));
        assert!(is_erofs_tool(&tool));

        // Without the execute bit the candidate is skipped.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                nested.join("fsck.erofs"),
                std::fs::Permissions::from_mode(0o644),
            )
            .unwrap();
            let tool = resolve_erofs_tool(&ctx).unwrap();
            assert!(tool.argv[0].ends_with("extract.erofs"));
            assert!(!is_fsck_erofs(&tool));
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn windows_lookup_accepts_exe_but_not_cmd_or_bat() {
        let dir = std::env::temp_dir().join(format!("afe-tools-win-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // `.cmd`/`.bat` shims cannot be spawned by `Command::new` on Windows,
        // so they must not be offered as candidates.
        for name in ["fsck.erofs.cmd", "extract.erofs.bat"] {
            std::fs::write(dir.join(name), b"@echo off\r\n").unwrap();
        }
        let ctx = ToolContext {
            platform: "win32".to_string(),
            ..context(&[("PATH", dir.to_str().unwrap())])
        };
        assert_eq!(
            resolve_erofs_tool(&ctx).unwrap_err().message,
            EROFS_MISSING_WIN32
        );

        // A native `.exe` is accepted, including from a quoted PATH entry.
        std::fs::write(dir.join("extract.erofs.exe"), b"MZ").unwrap();
        let quoted = format!("\"{}\"", dir.display());
        let quoted_ctx = ToolContext {
            platform: "win32".to_string(),
            ..context(&[("PATH", quoted.as_str())])
        };
        let tool = resolve_erofs_tool(&quoted_ctx).unwrap();
        assert!(tool.argv[0].ends_with("extract.erofs.exe"));
        assert!(is_erofs_tool(&tool));
        assert!(!is_fsck_erofs(&tool));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn executable_name_handles_windows_separators() {
        assert_eq!(
            tool_executable_name(&FrameworkTool::new(vec!["C:\\tools\\extract.erofs".into()])),
            "extract.erofs"
        );
        assert_eq!(
            tool_executable_name(&FrameworkTool::new(vec!["/usr/bin/fsck.erofs".into()])),
            "fsck.erofs"
        );
        assert!(is_erofs_tool(&FrameworkTool::new(vec![
            "/usr/bin/extract.erofs".into()
        ])));
        assert!(!is_erofs_tool(&FrameworkTool::new(vec![
            "/usr/bin/debugfs".into()
        ])));
    }

    #[test]
    fn default_run_of_a_missing_binary_reports_no_status() {
        let result = default_tool_run(
            &["/definitely/not/a/tool".to_string()],
            &ToolRunOptions::default(),
        );
        assert!(result.status.is_none());
        assert!(!result.stderr.is_empty());
    }
}

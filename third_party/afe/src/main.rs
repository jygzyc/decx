//! `afe` — Android Framework Extract.
//!
//! One JSON object on stdout per invocation (the same field names the former
//! TypeScript commands returned); diagnostics on stderr; non-zero exit on
//! failure.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use serde_json::Value;

use afe::device::{permission_info, system_services, DeviceOptions};
use afe::error::{Error, Result};
use afe::flows::{collect, pack, process, FrameworkOptions};
use afe::{afe_home, default_adb_path};

/// Connection/identity flags shared by every subcommand.
#[derive(Args, Clone, Default)]
struct DeviceArgs {
    /// Device serial (required when several devices are connected).
    #[arg(long, value_name = "SERIAL")]
    serial: Option<String>,
    /// adb binary to run (default: $AFE_ADB, $DECX_ADB, or `adb`).
    #[arg(long, value_name = "PATH")]
    adb_path: Option<String>,
}

/// Location flags shared by the framework subcommands.
#[derive(Args, Clone, Default)]
struct FrameworkArgs {
    /// OEM segment of the artifact name.
    #[arg(long, value_name = "OEM")]
    oem: Option<String>,
    /// Directory holding the collected files (default: $AFE_HOME/source, else
    /// $DECX_HOME/afe/source, else ~/.decx/afe/source).
    #[arg(long, visible_aliases = ["source-dir", "input"], value_name = "DIR")]
    source: Option<PathBuf>,
    /// Output directory of the artifact (default: $AFE_HOME/out, else
    /// $DECX_HOME/afe/out, else ~/.decx/afe/out).
    #[arg(
        long,
        short = 'o',
        visible_aliases = ["out-dir", "output"],
        value_name = "DIR"
    )]
    out: Option<PathBuf>,
}

#[derive(Parser)]
#[command(
    name = "afe",
    version,
    about = "Collect Android framework files, expand their dex payloads, and pack a framework jar",
    propagate_version = true
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Collect framework files from a connected device.
    Collect {
        #[command(flatten)]
        device: DeviceArgs,
        #[command(flatten)]
        framework: FrameworkArgs,
        /// Accepted for CLI-surface parity; the TypeScript collect handler
        /// ignored it.
        #[arg(long, visible_alias = "clean")]
        clean_source: bool,
    },
    /// Expand collected inputs into dex outputs and pack the framework jar.
    Process {
        #[command(flatten)]
        device: DeviceArgs,
        #[command(flatten)]
        framework: FrameworkArgs,
        /// OEM segment, as a positional (kept for the TypeScript CLI).
        #[arg(value_name = "OEM")]
        oem_positional: Option<String>,
        /// Remove the source directory after a successful run.
        #[arg(long, visible_alias = "clean")]
        clean_source: bool,
        /// Keep out_tmp after packing, so `afe pack` can run afterwards.
        #[arg(long, visible_alias = "keep-tmp")]
        keep_outputs: bool,
    },
    /// Pack an existing out_tmp directory into the framework jar.
    Pack {
        #[command(flatten)]
        framework: FrameworkArgs,
    },
    /// Device queries.
    Device {
        #[command(subcommand)]
        command: DeviceCommand,
    },
}

#[derive(Subcommand)]
enum DeviceCommand {
    /// List system services (`service list`).
    SystemServices {
        #[command(flatten)]
        device: DeviceArgs,
        /// Only keep services whose name or interfaces contain this text.
        #[arg(long, value_name = "FILTER")]
        grep: Option<String>,
    },
    /// Show `pm list permissions -f` metadata for one permission.
    PermissionInfo {
        #[command(flatten)]
        device: DeviceArgs,
        /// Permission name, as a positional.
        #[arg(value_name = "PERMISSION")]
        permission_positional: Option<String>,
        /// Permission name.
        #[arg(long, value_name = "PERMISSION")]
        permission: Option<String>,
    },
}

fn device_options(args: &DeviceArgs) -> DeviceOptions {
    DeviceOptions {
        adb_path: args.adb_path.clone().unwrap_or_else(default_adb_path),
        serial: args.serial.clone(),
    }
}

fn framework_options(device: &DeviceArgs, framework: &FrameworkArgs) -> FrameworkOptions {
    FrameworkOptions {
        home: afe_home(),
        adb_path: device.adb_path.clone().unwrap_or_else(default_adb_path),
        adb_path_explicit: device.adb_path.is_some(),
        serial: device.serial.clone(),
        oem: framework.oem.clone(),
        source_dir: framework.source.clone(),
        out_dir: framework.out.clone(),
        keep_outputs: false,
    }
}

fn run(cli: Cli) -> Result<Value> {
    match cli.command {
        Command::Collect {
            device,
            framework,
            clean_source: _,
        } => collect(&framework_options(&device, &framework)),
        Command::Process {
            device,
            framework,
            oem_positional,
            clean_source,
            keep_outputs,
        } => {
            let mut options = framework_options(&device, &framework);
            if options.oem.is_none() {
                options.oem = oem_positional;
            }
            options.keep_outputs = keep_outputs;
            process(&options, clean_source)
        }
        Command::Pack { framework } => pack(&framework_options(&DeviceArgs::default(), &framework)),
        Command::Device { command } => match command {
            DeviceCommand::SystemServices { device, grep } => {
                system_services(&device_options(&device), grep.as_deref())
            }
            DeviceCommand::PermissionInfo {
                device,
                permission_positional,
                permission,
            } => permission_info(
                &device_options(&device),
                permission.as_deref().or(permission_positional.as_deref()),
            ),
        },
    }
}

fn main() {
    let cli = Cli::parse();
    // A crafted image must never take the process down with a panic: the
    // contract is one JSON envelope on stdout, so an unexpected panic still
    // becomes a structured error.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(cli)))
        .unwrap_or_else(|payload| {
            let detail = payload
                .downcast_ref::<&str>()
                .map(|text| (*text).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            Err(Error::internal(format!("unexpected panic: {detail}")))
        });
    match result {
        Ok(value) => {
            println!(
                "{}",
                serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
            );
        }
        Err(error) => {
            eprintln!("{}", error.message);
            println!(
                "{}",
                serde_json::to_string(&error.payload()).unwrap_or_else(|_| "{}".to_string())
            );
            std::process::exit(error.exit);
        }
    }
}

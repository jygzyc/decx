//! adb access and output parsers for the `device` commands and framework
//! collection. Port of the TypeScript `adb.ts`.
//!
//! The client spawns adb synchronously with a timeout (polling `try_wait`)
//! and fails with the same error codes as the TypeScript implementation:
//! `ADB_NOT_FOUND` when adb cannot be executed, `ADB_DEVICE_MISSING` /
//! `ADB_DEVICE_AMBIGUOUS` for device selection, `PROCESS_ERROR` for non-zero
//! exits, `INVALID_PARAMETER` / `RESOURCE_NOT_FOUND` for permission lookups.

use std::process::Command;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::error::{Error, Result};

/// Default command timeout (TypeScript `ADB_TIMEOUT_MS`).
pub const ADB_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// One row parsed from `service list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemService {
    pub index: u64,
    pub name: String,
    pub interfaces: Vec<String>,
}

impl SystemService {
    pub fn to_json(&self) -> Value {
        json!({
            "index": self.index,
            "name": self.name,
            "interfaces": self.interfaces,
        })
    }
}

/// `service list` result: total count plus matching rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemServiceList {
    pub total: usize,
    pub services: Vec<SystemService>,
}

impl SystemServiceList {
    pub fn to_json(&self) -> Value {
        json!({
            "total": self.total,
            "services": self.services.iter().map(SystemService::to_json).collect::<Vec<_>>(),
        })
    }
}

/// Captured result of one adb invocation.
#[derive(Debug, Clone)]
pub struct AdbRunResult {
    pub stdout: String,
    pub stderr: String,
    pub status: Option<i32>,
}

/// Device serials reported as ready by `adb devices`.
pub fn parse_adb_devices_output(output: &str) -> Vec<String> {
    let mut devices = Vec::new();
    for line in output.split('\n') {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 && parts[1] == "device" {
            devices.push(parts[0].to_string());
        }
    }
    devices
}

/// Resolve the device serial to use: the requested one, or the only connected
/// device. Missing devices raise `ADB_DEVICE_MISSING` and several connected
/// devices raise `ADB_DEVICE_AMBIGUOUS` so callers can report an actionable
/// error.
pub fn resolve_preferred_serial(output: &str, requested: Option<&str>) -> Result<String> {
    if let Some(serial) = requested.filter(|value| !value.is_empty()) {
        return Ok(serial.to_string());
    }
    let devices = parse_adb_devices_output(output);
    match devices.len() {
        0 => Err(Error::new("ADB_DEVICE_MISSING", "no connected device")),
        1 => Ok(devices[0].clone()),
        _ => Err(Error::new(
            "ADB_DEVICE_AMBIGUOUS",
            format!(
                "select a device with --serial (connected: {})",
                devices.join(", ")
            ),
        )),
    }
}

/// Parse one `service list` line: `<index>\t<name>: [<iface>, ...]`.
fn parse_service_line(line: &str) -> Option<SystemService> {
    let line = line.trim();
    let split = line.find(char::is_whitespace)?;
    let (index, rest) = line.split_at(split);
    if index.is_empty() || !index.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (name, interfaces) = rest.trim_start().split_once(": [")?;
    let raw_interfaces = interfaces.strip_suffix(']')?;
    if name.is_empty() || name.contains(':') {
        return None;
    }
    let interfaces = raw_interfaces
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect();
    Some(SystemService {
        index: index.parse().ok()?,
        name: name.to_string(),
        interfaces,
    })
}

/// Parse the `service list` shell output into structured service rows. When
/// `filter` is set, rows whose name or interface list does not contain it are
/// dropped and `total` counts only the kept rows (TypeScript behavior).
pub fn parse_system_services_output(output: &str, filter: Option<&str>) -> SystemServiceList {
    let normalized_filter = filter
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default();
    let mut services = Vec::new();
    for raw_line in output.split('\n') {
        let line = raw_line.trim();
        let Some(service) = parse_service_line(line) else {
            continue;
        };
        if !normalized_filter.is_empty() {
            let haystack = format!("{} {}", service.name, service.interfaces.join(", "));
            if !haystack.to_lowercase().contains(&normalized_filter) {
                continue;
            }
        }
        services.push(service);
    }
    SystemServiceList {
        total: services.len(),
        services,
    }
}

/// Filter a parsed service list by keyword (name or interfaces).
pub fn filter_system_services(
    result: SystemServiceList,
    keyword: Option<&str>,
) -> SystemServiceList {
    let normalized = keyword
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default();
    if normalized.is_empty() {
        return result;
    }
    let services: Vec<SystemService> = result
        .services
        .into_iter()
        .filter(|service| {
            service.name.to_lowercase().contains(&normalized)
                || service
                    .interfaces
                    .iter()
                    .any(|iface| iface.to_lowercase().contains(&normalized))
        })
        .collect();
    SystemServiceList {
        total: services.len(),
        services,
    }
}

/// POSIX shell single-quote escaping.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The device-side shell pipeline used for permission lookups.
pub fn build_permission_info_command(permission: &str) -> String {
    format!(
        "pm list permissions -f | grep -A 5 -F -- {} || true",
        shell_quote(permission)
    )
}

/// Extract one permission's metadata block: the lines following
/// `+ permission:<name>` until the next permission header. Returns `None`
/// when the permission is absent from the output. Values equal to `null` map
/// to JSON null.
pub fn parse_permission_info_output(output: &str, permission: &str) -> Option<Value> {
    let normalized = permission.trim();
    let header = format!("+ permission:{normalized}");
    let mut info: Option<Map<String, Value>> = None;

    for raw_line in output.split('\n') {
        let line = raw_line.trim();
        if line.starts_with("+ permission:") {
            if info.is_some() {
                break;
            }
            if line == header {
                let mut map = Map::new();
                map.insert("permission".into(), json!(normalized));
                info = Some(map);
            }
            continue;
        }
        let Some(map) = info.as_mut() else {
            continue;
        };
        let Some(separator) = line.find(':') else {
            continue;
        };
        let key = line[..separator].trim();
        if key.is_empty() {
            continue;
        }
        let value = line[separator + 1..].trim();
        let value = if value == "null" {
            Value::Null
        } else {
            json!(value)
        };
        map.insert(key.to_string(), value);
    }
    info.map(Value::Object)
}

/// Minimal adb client (synchronous spawns with a timeout, like `adb.ts`).
pub struct AdbClient {
    pub adb_path: String,
    requested_serial: Option<String>,
    selected_serial: Option<String>,
}

impl AdbClient {
    pub fn new(adb_path: Option<String>, serial: Option<String>) -> Self {
        Self {
            adb_path: adb_path
                .filter(|path| !path.is_empty())
                .unwrap_or_else(|| "adb".to_string()),
            requested_serial: serial.filter(|value| !value.is_empty()),
            selected_serial: None,
        }
    }

    /// Selected serial, falling back to the requested one.
    pub fn serial(&self) -> Option<&str> {
        self.selected_serial
            .as_deref()
            .or(self.requested_serial.as_deref())
    }

    /// `-s <serial>` prefix for every adb invocation.
    pub fn base_args(&self) -> Vec<String> {
        match self
            .requested_serial
            .as_deref()
            .or(self.selected_serial.as_deref())
        {
            Some(serial) => vec!["-s".to_string(), serial.to_string()],
            None => Vec::new(),
        }
    }

    /// Run an adb command, capturing stdout/stderr and the exit status.
    pub fn run(&self, args: &[&str], timeout: Duration) -> Result<AdbRunResult> {
        let mut command = Command::new(&self.adb_path);
        for arg in self.base_args() {
            command.arg(arg);
        }
        command.args(args);
        let output = crate::process::spawn_capture(command, timeout, None);
        if output.timed_out {
            return Err(Error::process(format!(
                "adb command timed out after {}s",
                timeout.as_secs()
            )));
        }
        if let Some(message) = output.spawn_error {
            return Err(Error::new(
                "ADB_NOT_FOUND",
                format!("Failed to execute adb: {message}"),
            ));
        }
        Ok(AdbRunResult {
            stdout: output.stdout,
            stderr: output.stderr,
            status: output.status,
        })
    }

    /// Run an adb command and fail on a non-zero exit status.
    pub fn run_checked(&self, args: &[&str], timeout: Duration) -> Result<String> {
        let result = self.run(args, timeout)?;
        if result.status != Some(0) {
            let message = if !result.stderr.trim().is_empty() {
                result.stderr.trim().to_string()
            } else if !result.stdout.trim().is_empty() {
                result.stdout.trim().to_string()
            } else {
                format!("adb {} failed", args.join(" "))
            };
            return Err(Error::process(message));
        }
        Ok(result.stdout)
    }

    pub fn ensure_available(&self) -> Result<()> {
        let result = self.run(&["version"], Duration::from_secs(10))?;
        if result.status != Some(0) {
            let message = if !result.stderr.trim().is_empty() {
                result.stderr.trim().to_string()
            } else if !result.stdout.trim().is_empty() {
                result.stdout.trim().to_string()
            } else {
                "adb is not available".to_string()
            };
            return Err(Error::process(message));
        }
        Ok(())
    }

    /// Select the device: explicit serial wins, otherwise the single connected
    /// device. Verifies the selection with `get-state`.
    pub fn select(&mut self) -> Result<()> {
        if self.requested_serial.is_none() && self.selected_serial.is_none() {
            let output = self.run_checked(&["devices"], Duration::from_secs(10))?;
            self.selected_serial = Some(resolve_preferred_serial(&output, None)?);
        }
        let state = self.run(&["get-state"], Duration::from_secs(10))?;
        if state.status != Some(0) {
            let message = if !state.stderr.trim().is_empty() {
                state.stderr.trim().to_string()
            } else if !state.stdout.trim().is_empty() {
                state.stdout.trim().to_string()
            } else {
                "selected device is not ready".to_string()
            };
            return Err(Error::new("ADB_DEVICE_MISSING", message));
        }
        if state.stdout.trim() != "device" {
            return Err(Error::new(
                "ADB_DEVICE_MISSING",
                "selected device is not ready",
            ));
        }
        Ok(())
    }

    pub fn shell(&self, command: &str, timeout: Duration) -> Result<String> {
        self.run_checked(&["shell", command], timeout)
    }

    pub fn list_system_services(&self, grep: Option<&str>) -> Result<SystemServiceList> {
        let output = self.shell("service list", Duration::from_secs(60))?;
        Ok(parse_system_services_output(&output, grep))
    }

    pub fn get_permission_info(&self, permission: &str) -> Result<Value> {
        let normalized = permission.trim();
        if normalized.is_empty() {
            return Err(Error::new(
                "INVALID_PARAMETER",
                "permission name is required",
            ));
        }
        let output = self.shell(
            &build_permission_info_command(normalized),
            Duration::from_secs(60),
        )?;
        parse_permission_info_output(&output, normalized).ok_or_else(|| {
            Error::new(
                "RESOURCE_NOT_FOUND",
                format!("permission \"{normalized}\" not found"),
            )
        })
    }

    pub fn get_prop(&self, name: &str) -> Result<String> {
        Ok(self
            .shell(&format!("getprop {name}"), Duration::from_secs(10))?
            .trim()
            .to_string())
    }

    /// Device brand used for the artifact OEM segment.
    pub fn oem(&self) -> Result<String> {
        for key in [
            "ro.product.vendor.brand",
            "ro.product.brand",
            "ro.product.manufacturer",
        ] {
            let value = self.get_prop(key)?;
            if !value.is_empty() {
                return Ok(value.to_lowercase());
            }
        }
        Ok("unknown".to_string())
    }

    /// Device model used for the artifact vendor segment.
    pub fn vendor(&self) -> Result<String> {
        self.get_prop("ro.product.model")
    }

    pub fn pull(&self, remote_path: &str, local_path: &str, timeout: Duration) -> Result<()> {
        self.run_checked(&["pull", remote_path, local_path], timeout)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_parsing() {
        let out = "List of devices attached\nABC123\tdevice\nXYZ\toffline\nDEF\tdevice\n";
        assert_eq!(parse_adb_devices_output(out), vec!["ABC123", "DEF"]);
    }

    #[test]
    fn serial_resolution() {
        assert_eq!(
            resolve_preferred_serial("X\tdevice\n", Some("X")).unwrap(),
            "X"
        );
        let missing = resolve_preferred_serial("", None).unwrap_err();
        assert_eq!(missing.code, "ADB_DEVICE_MISSING");
        assert_eq!(missing.message, "no connected device");
        let two = resolve_preferred_serial("A\tdevice\nB\tdevice\n", None).unwrap_err();
        assert_eq!(two.code, "ADB_DEVICE_AMBIGUOUS");
        assert!(two.message.contains("connected: A, B"));
        // An empty requested serial behaves like an absent one.
        assert_eq!(
            resolve_preferred_serial("A\tdevice\n", Some("")).unwrap(),
            "A"
        );
    }

    #[test]
    fn service_list_parsing_applies_the_filter() {
        let out = "Found 2 services:\n1\twifi: [android.net.wifi.IWifi, extra]\n2\tbattery: []\n";
        let all = parse_system_services_output(out, None);
        assert_eq!(all.total, 2);
        assert_eq!(all.services[0].name, "wifi");
        assert_eq!(
            all.services[0].interfaces,
            vec!["android.net.wifi.IWifi", "extra"]
        );
        assert!(all.services[1].interfaces.is_empty());

        let filtered = parse_system_services_output(out, Some("WIFI"));
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.services[0].name, "wifi");

        // Interface matches count too, and the total counts only kept rows.
        let by_iface = parse_system_services_output(out, Some("iwifi"));
        assert_eq!(by_iface.total, 1);
        assert_eq!(parse_system_services_output(out, Some("zzz")).total, 0);
    }

    #[test]
    fn service_line_shapes_are_strict() {
        // Missing bracket, colon in the name, non-numeric index: all ignored.
        let out = "1\twifi: [a.B]\nnot-a-service\n2\tweird: name: [x]\n3\tbroken: [x\n";
        let parsed = parse_system_services_output(out, None);
        assert_eq!(parsed.total, 1);
        assert_eq!(parsed.services[0].name, "wifi");
    }

    #[test]
    fn service_grep_filter_is_case_insensitive() {
        let list = parse_system_services_output("1\twifi: [a.B]\n2\tbattery: []\n", None);
        assert_eq!(
            filter_system_services(list.clone(), Some("BATTERY")).total,
            1
        );
        assert_eq!(filter_system_services(list.clone(), None).total, 2);
        assert_eq!(filter_system_services(list, Some("  ")).total, 2);
    }

    #[test]
    fn permission_command_quoting() {
        assert_eq!(
            build_permission_info_command("android.permission.INTERNET"),
            "pm list permissions -f | grep -A 5 -F -- 'android.permission.INTERNET' || true"
        );
        assert_eq!(
            build_permission_info_command("a'b"),
            "pm list permissions -f | grep -A 5 -F -- 'a'\\''b' || true"
        );
    }

    #[test]
    fn permission_block_parsing() {
        // `pm list permissions -f` only prefixes the `permission:` header line.
        let out = "+ permission:android.permission.INTERNET\npackage:android\nlabel:Network\ngroup:null\nfoo without colon\n+ permission:OTHER\n";
        let info = parse_permission_info_output(out, "android.permission.INTERNET").unwrap();
        assert_eq!(info["permission"], "android.permission.INTERNET");
        assert_eq!(info["package"], "android");
        assert_eq!(info["label"], "Network");
        assert!(info["group"].is_null());
        assert!(!info.as_object().unwrap().contains_key("foo without colon"));
    }

    #[test]
    fn permission_missing_returns_none() {
        assert!(parse_permission_info_output("no block here", "a.b").is_none());
        assert!(parse_permission_info_output("+ permission:other\n+ label:x\n", "a.b").is_none());
    }
}

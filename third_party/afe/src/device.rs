//! `afe device` flows: system services and permission metadata. Both return
//! the JSON objects the former TypeScript `device` commands printed.

use serde_json::Value;

use crate::adb::AdbClient;
use crate::error::{Error, Result, EX_USAGE};

/// Connection options shared by the device commands.
pub struct DeviceOptions {
    pub adb_path: String,
    pub serial: Option<String>,
}

impl DeviceOptions {
    pub fn client(&self) -> AdbClient {
        AdbClient::new(Some(self.adb_path.clone()), self.serial.clone())
    }

    /// `AdbClient.select()` after `ensureAvailable()`, i.e. the TS
    /// `requiredDevice()` helper: a hard error whenever adb or the device is
    /// missing.
    pub fn required_client(&self) -> Result<AdbClient> {
        let mut client = self.client();
        client.ensure_available()?;
        client.select()?;
        Ok(client)
    }
}

/// `afe device system-services [--grep FILTER]`.
pub fn system_services(options: &DeviceOptions, grep: Option<&str>) -> Result<Value> {
    let client = options.required_client()?;
    Ok(client.list_system_services(grep)?.to_json())
}

/// `afe device permission-info PERMISSION`.
pub fn permission_info(options: &DeviceOptions, permission: Option<&str>) -> Result<Value> {
    let permission = permission.unwrap_or("").trim();
    if permission.is_empty() {
        return Err(
            Error::new("INVALID_PARAMETER", "permission name is required").with_exit(EX_USAGE),
        );
    }
    let client = options.required_client()?;
    client.get_permission_info(permission)
}

//! Error type shared by every module.
//!
//! Port of the TypeScript `errors.ts` taxonomy: an error carries a stable,
//! machine-readable code plus optional structured details. The CLI serializes
//! it into the `{"ok":false,"error":{...}}` failure object on stdout and
//! prints the message to stderr.
//!
//! Codes used across the tool (same values the TypeScript extension returns):
//! `FILE_ERROR`, `PROCESS_ERROR`, `TOOL_NOT_FOUND`, `ADB_DEVICE_MISSING`,
//! `ADB_DEVICE_AMBIGUOUS`, `ADB_NOT_FOUND`, `INVALID_PARAMETER`,
//! `RESOURCE_NOT_FOUND`, `MISSING_OEM`, `INVALID_ARTIFACT`, `INVALID_LAYOUT`,
//! `PROCESS_FAILED`, `DECX_ERROR`, `INTERNAL_ERROR`.

use std::fmt;

use serde_json::{json, Map, Value};

/// Bad invocation (unknown flag, missing value). Matches clap's exit code so
/// hand-rolled and clap-parsed usage errors behave identically.
pub const EX_USAGE: i32 = 2;
/// Runtime failure: an operation could not be completed.
pub const EX_FAILURE: i32 = 1;

/// Base error carrying a machine-readable code and optional details.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: String,
    pub message: String,
    pub details: Option<Map<String, Value>>,
    /// Process exit code to use when this error reaches the CLI boundary.
    pub exit: i32,
}

impl Error {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
            exit: EX_FAILURE,
        }
    }

    /// Invalid invocation (bad flag/argument combination).
    pub fn usage(message: impl Into<String>) -> Self {
        Self::new("INVALID_REQUEST", message).with_exit(EX_USAGE)
    }

    /// File system or external file-tool failure.
    pub fn file(message: impl Into<String>, file_path: Option<&str>) -> Self {
        let mut err = Self::new("FILE_ERROR", message);
        if let Some(path) = file_path {
            let mut details = Map::new();
            details.insert("filePath".into(), json!(path));
            err.details = Some(details);
        }
        err
    }

    /// Child-process failure (adb, debugfs, erofs-utils, ...).
    pub fn process(message: impl Into<String>) -> Self {
        Self::new("PROCESS_ERROR", message)
    }

    /// A required external tool was not found.
    pub fn tool(message: impl Into<String>) -> Self {
        Self::new("TOOL_NOT_FOUND", message)
    }

    /// A looked-up resource (device, permission, file) does not exist.
    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL_ERROR", message)
    }

    pub fn with_exit(mut self, exit: i32) -> Self {
        self.exit = exit;
        self
    }

    pub fn with_details(mut self, details: Map<String, Value>) -> Self {
        self.details = Some(details);
        self
    }

    /// Add one detail key, creating the map when needed.
    pub fn detail(mut self, key: &str, value: Value) -> Self {
        self.details
            .get_or_insert_with(Map::new)
            .insert(key.to_string(), value);
        self
    }

    /// The `error` object of the failure response envelope.
    pub fn payload(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("code".into(), json!(self.code));
        obj.insert("message".into(), json!(self.message));
        if let Some(details) = &self.details {
            if !details.is_empty() {
                obj.insert("details".into(), Value::Object(details.clone()));
            }
        }
        Value::Object(obj)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, Error>;

/// Map an `std::io::Error` into a file error with an optional path context.
pub fn io_error(context: &str, err: std::io::Error) -> Error {
    Error::file(format!("{context}: {err}"), None)
}

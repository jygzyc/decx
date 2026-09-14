//! Route dispatch, flat-JSON parameter parsing and the DECX response envelope.
//!
//! Request bodies are flat JSON objects (the Go CLI's registry maps flat
//! fields); unknown fields are ignored, wrong types are `INVALID_PARAMETER`.
//! Every response is the standard DECX envelope:
//! `{"ok":true,"kind":…,"query":…,"summary":…,"items":…,"page":…}` or
//! `{"ok":false,"kind":…,"error":{"code":…,"message":…}}`.

use serde::Deserialize;
use serde_json::{json, Value};

use kuna_analysis::listing::xrefs::Xref;
use kuna_console::engine::FunctionEntry;
use kuna_console::project::decompile_targets;

use crate::engine::Engine;

/// Default page size for `get_functions`.
pub const DEFAULT_FUNCTIONS_LIMIT: usize = 100;

/// The xref kinds accepted by `get_function_xref`'s `kinds` filter.
pub const XREF_KINDS: [&str; 5] = ["call", "jump", "data", "read", "write"];

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            code: "INVALID_PARAMETER",
            message: message.into(),
        }
    }

    pub fn function_not_found(message: impl Into<String>) -> Self {
        Self {
            status: 404,
            code: "FUNCTION_NOT_FOUND",
            message: message.into(),
        }
    }

    pub fn unknown_endpoint(path: &str) -> Self {
        Self {
            status: 404,
            code: "UNKNOWN_ENDPOINT",
            message: format!("unknown endpoint {path:?}"),
        }
    }

    pub fn method_not_allowed(message: impl Into<String>) -> Self {
        Self {
            status: 405,
            code: "METHOD_NOT_ALLOWED",
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            status: 500,
            code: "INTERNAL_ERROR",
            message: message.into(),
        }
    }
}

fn success_body(kind: &str, query: Value, summary: Value, items: Value, page: Value) -> String {
    json!({
        "ok": true,
        "kind": kind,
        "query": query,
        "summary": summary,
        "items": items,
        "page": page,
    })
    .to_string()
}

pub fn error_body(kind: &str, error: &ApiError) -> String {
    json!({
        "ok": false,
        "kind": kind,
        "error": {"code": error.code, "message": error.message},
    })
    .to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    GetFunctions,
    GetFunctionSource,
    GetFunctionXref,
}

impl Route {
    fn kind(self) -> &'static str {
        match self {
            Self::GetFunctions => "functions",
            Self::GetFunctionSource => "function_source",
            Self::GetFunctionXref => "function_xref",
        }
    }

    fn from_path(path: &str) -> Option<Self> {
        match path {
            "/api/decx/get_functions" => Some(Self::GetFunctions),
            "/api/decx/get_function_source" => Some(Self::GetFunctionSource),
            "/api/decx/get_function_xref" => Some(Self::GetFunctionXref),
            _ => None,
        }
    }
}

/// Dispatch one request. Unknown routes and methods produce envelopes instead
/// of panics, so a malformed client cannot take the server down.
pub fn handle(engine: &mut Engine, method: &str, path: &str, body: &[u8]) -> (u16, String) {
    if path == "/health" {
        if method != "GET" {
            return error_response(
                "error",
                ApiError::method_not_allowed("use GET /health"),
            );
        }
        return (200, health_body(engine));
    }
    let Some(route) = Route::from_path(path) else {
        return error_response("error", ApiError::unknown_endpoint(path));
    };
    if method != "POST" {
        return error_response(
            route.kind(),
            ApiError::method_not_allowed(format!("use POST {path}")),
        );
    }
    let result = match route {
        Route::GetFunctions => get_functions(engine, body),
        Route::GetFunctionSource => get_function_source(engine, body),
        Route::GetFunctionXref => get_function_xref(engine, body),
    };
    match result {
        Ok(response) => (200, response),
        Err(error) => error_response(route.kind(), error),
    }
}

fn error_response(kind: &str, error: ApiError) -> (u16, String) {
    (error.status, error_body(kind, &error))
}

pub fn health_body(engine: &Engine) -> String {
    json!({
        "status": "running",
        "ok": true,
        "version": crate::VERSION,
        "binary": engine.binary,
        "mode": engine.mode,
        "language": engine.language,
        "functions": engine.entries.len(),
    })
    .to_string()
}

#[derive(Debug, Default, Deserialize)]
pub struct FunctionsParams {
    pub name_contains: Option<String>,
    pub includes: Option<Vec<String>>,
    pub excludes: Option<Vec<String>>,
    pub case_sensitive: Option<bool>,
    pub regex: Option<bool>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
pub struct SourceParams {
    pub name: Option<String>,
    pub address: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
pub struct XrefParams {
    pub name: Option<String>,
    pub address: Option<String>,
    pub direction: Option<String>,
    pub kinds: Option<Vec<String>>,
    pub limit: Option<i64>,
}

fn parse_json<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, ApiError> {
    let bytes = if body.is_empty() { b"{}".as_slice() } else { body };
    serde_json::from_slice(bytes)
        .map_err(|error| ApiError::invalid(format!("invalid JSON body: {error}")))
}

fn non_negative(value: Option<i64>, field: &str) -> Result<Option<usize>, ApiError> {
    match value {
        None => Ok(None),
        Some(value) if value < 0 => Err(ApiError::invalid(format!(
            "\"{field}\" must be >= 0 (got {value})"
        ))),
        Some(value) => Ok(Some(value as usize)),
    }
}

#[derive(Debug)]
enum Matcher {
    Substring(String),
    Regex(regex::Regex),
}

impl Matcher {
    /// `encoded` is the haystack in the matcher's case (lowercased for an
    /// insensitive substring matcher, the original name when sensitive);
    /// `original` is used for regex matching.
    fn matches(&self, encoded: &str, original: &str) -> bool {
        match self {
            Self::Substring(pattern) => encoded.contains(pattern.as_str()),
            Self::Regex(regex) => regex.is_match(original),
        }
    }
}

/// Name filter for `get_functions`. `regex=false` (the default) treats every
/// `includes`/`excludes`/`name_contains` value as a substring; `regex=true`
/// compiles `includes`/`excludes` as regular expressions. `case_sensitive`
/// defaults to `false` and applies to all three.
#[derive(Debug)]
pub struct NameFilter {
    name_contains: Option<String>,
    includes: Vec<Matcher>,
    excludes: Vec<Matcher>,
    case_sensitive: bool,
}

impl NameFilter {
    pub fn new(
        name_contains: Option<&str>,
        includes: &[String],
        excludes: &[String],
        case_sensitive: bool,
        regex: bool,
    ) -> Result<Self, ApiError> {
        let compile = |pattern: &str| -> Result<Matcher, ApiError> {
            if regex {
                regex::RegexBuilder::new(pattern)
                    .case_insensitive(!case_sensitive)
                    .build()
                    .map(Matcher::Regex)
                    .map_err(|error| ApiError::invalid(format!("invalid regex {pattern:?}: {error}")))
            } else if case_sensitive {
                Ok(Matcher::Substring(pattern.to_string()))
            } else {
                Ok(Matcher::Substring(pattern.to_lowercase()))
            }
        };
        let name_contains = name_contains
            .filter(|value| !value.is_empty())
            .map(|value| if case_sensitive { value.to_string() } else { value.to_lowercase() });
        let includes = includes
            .iter()
            .filter(|value| !value.is_empty())
            .map(|value| compile(value))
            .collect::<Result<Vec<_>, _>>()?;
        let excludes = excludes
            .iter()
            .filter(|value| !value.is_empty())
            .map(|value| compile(value))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            name_contains,
            includes,
            excludes,
            case_sensitive,
        })
    }

    pub fn matches(&self, name: &str) -> bool {
        let lowercase = if self.case_sensitive {
            String::new()
        } else {
            name.to_lowercase()
        };
        let haystack = if self.case_sensitive {
            name
        } else {
            lowercase.as_str()
        };
        if let Some(needle) = &self.name_contains {
            if !haystack.contains(needle.as_str()) {
                return false;
            }
        }
        if !self.includes.is_empty()
            && !self.includes.iter().any(|matcher| matcher.matches(haystack, name))
        {
            return false;
        }
        if self.excludes.iter().any(|matcher| matcher.matches(haystack, name)) {
            return false;
        }
        true
    }
}

fn object_location_json(location: Option<&kuna_console::engine::ObjectLocation>) -> Value {
    match location {
        Some(location) => json!({
            "section_index": location.section_index,
            "section": location.section,
            "offset": location.offset,
            "offset_hex": format!("0x{:x}", location.offset),
        }),
        None => Value::Null,
    }
}

fn function_item(entry: &FunctionEntry, kind: &'static str) -> Value {
    let address = entry.addr.get_offset();
    json!({
        "name": entry.name,
        "address": address,
        "address_hex": format!("0x{address:x}"),
        "aliases": entry.aliases,
        "size": entry.size,
        "kind": kind,
        "object_location": object_location_json(entry.object_location.as_ref()),
    })
}

fn get_functions(engine: &Engine, body: &[u8]) -> Result<String, ApiError> {
    let params: FunctionsParams = parse_json(body)?;
    let case_sensitive = params.case_sensitive.unwrap_or(false);
    let regex = params.regex.unwrap_or(false);
    let filter = NameFilter::new(
        params.name_contains.as_deref(),
        params.includes.as_deref().unwrap_or(&[]),
        params.excludes.as_deref().unwrap_or(&[]),
        case_sensitive,
        regex,
    )?;
    let limit = non_negative(params.limit, "limit")?.unwrap_or(DEFAULT_FUNCTIONS_LIMIT);
    let offset = non_negative(params.offset, "offset")?.unwrap_or(0);

    let matched: Vec<(usize, &FunctionEntry)> = engine
        .entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| filter.matches(&entry.name))
        .collect();
    let items: Vec<Value> = matched
        .iter()
        .skip(offset)
        .take(limit)
        .map(|(index, entry)| function_item(entry, engine.kinds[*index]))
        .collect();

    let query = json!({
        "name_contains": params.name_contains,
        "includes": params.includes,
        "excludes": params.excludes,
        "case_sensitive": case_sensitive,
        "regex": regex,
        "limit": limit,
        "offset": offset,
    });
    let summary = json!({
        "binary": engine.binary,
        "count": matched.len(),
        "total": engine.entries.len(),
    });
    let page = json!({"limit": limit, "offset": offset, "returned": items.len()});
    Ok(success_body(
        Route::GetFunctions.kind(),
        query,
        summary,
        json!(items),
        page,
    ))
}

/// Truncate `code` to at most `limit` lines (no marker appended). Returns the
/// possibly-truncated text, whether anything was dropped, and the line count of
/// the returned text.
pub fn truncate_code(code: Option<String>, limit: Option<usize>) -> (Option<String>, bool, usize) {
    let Some(code) = code else {
        return (None, false, 0);
    };
    let total = code.lines().count();
    match limit {
        Some(limit) if total > limit => {
            let kept: Vec<&str> = code.lines().take(limit).collect();
            (Some(kept.join("\n")), true, limit)
        }
        _ => (Some(code), false, total),
    }
}

fn get_function_source(engine: &mut Engine, body: &[u8]) -> Result<String, ApiError> {
    let params: SourceParams = parse_json(body)?;
    let limit = non_negative(params.limit, "limit")?;
    let entry = engine.resolve_entry(params.name.as_deref(), params.address.as_deref())?;

    let results = decompile_targets(&mut engine.program, vec![entry], false, false, false);
    let result = results.into_iter().next().ok_or_else(|| {
        ApiError::internal("the decompiler returned no result for the selected function")
    })?;
    let (code, truncated, lines) = truncate_code(result.code, limit);

    let address = result.address;
    let size = result.size;
    let variables: Vec<Value> = result
        .variables
        .iter()
        .map(|variable| {
            json!({
                "name": variable.name,
                "type": variable.type_name,
                "kind": if variable.is_param { "arg" } else { "stack" },
                "arg_index": variable.arg_index,
                "stack_offset": variable.stack_offset,
                "size": variable.size,
            })
        })
        .collect();
    let line_mappings: Vec<Value> = result
        .line_mappings
        .iter()
        .map(|mapping| {
            json!({
                "line_number": mapping.line_number,
                "addresses": mapping.addresses,
            })
        })
        .collect();

    let item = json!({
        "name": result.name,
        "address": address,
        "address_hex": format!("0x{address:x}"),
        "size": size,
        "code": code,
        "error": result.error,
        "variables": variables,
        "line_mappings": line_mappings,
        "aliases": result.aliases,
        "object_location": object_location_json(result.object_location.as_ref()),
    });
    let query = json!({"name": params.name, "address": params.address, "limit": limit});
    let summary = json!({
        "binary": engine.binary,
        "name": result.name,
        "address": address,
        "address_hex": format!("0x{address:x}"),
        "size": size,
        "language": engine.language,
        "mode": engine.mode,
        "lines": lines,
        "truncated": truncated,
    });
    let page = json!({"limit": limit, "offset": 0, "returned": 1});
    Ok(success_body(
        Route::GetFunctionSource.kind(),
        query,
        summary,
        json!([item]),
        page,
    ))
}

enum XrefDirection {
    Callers,
    Callees,
}

fn get_function_xref(engine: &mut Engine, body: &[u8]) -> Result<String, ApiError> {
    let params: XrefParams = parse_json(body)?;
    let limit = non_negative(params.limit, "limit")?;
    let direction = params
        .direction
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::invalid("missing \"direction\" (\"callers\" or \"callees\")")
        })?;
    let direction = match direction {
        "callers" => XrefDirection::Callers,
        "callees" => XrefDirection::Callees,
        other => {
            return Err(ApiError::invalid(format!(
                "unknown direction {other:?} (expected \"callers\" or \"callees\")"
            )))
        }
    };
    let kinds: Vec<&str> = match &params.kinds {
        None => Vec::new(),
        Some(kinds) => {
            let mut out = Vec::with_capacity(kinds.len());
            for kind in kinds {
                if !XREF_KINDS.contains(&kind.as_str()) {
                    return Err(ApiError::invalid(format!(
                        "unknown xref kind {kind:?} (known: {})",
                        XREF_KINDS.join(", ")
                    )));
                }
                out.push(kind.as_str());
            }
            out
        }
    };

    let entry = engine.resolve_entry(params.name.as_deref(), params.address.as_deref())?;
    let address = entry.addr.get_offset();
    let refs: Vec<&Xref> = match direction {
        XrefDirection::Callers => engine.xrefs.refs_to_unified(address),
        XrefDirection::Callees => {
            let is_function_entry =
                engine.xrefs.is_function_entry(address) || engine.program.find_entry_at(address).is_some();
            if is_function_entry {
                engine.xrefs.refs_from_function(address)
            } else {
                engine.xrefs.refs_from_instruction(address).iter().collect()
            }
        }
    };
    let filtered: Vec<&Xref> = refs
        .into_iter()
        .filter(|xref| kinds.is_empty() || kinds.contains(&xref.kind.as_str()))
        .collect();
    let count = filtered.len();
    let items: Vec<Value> = filtered
        .iter()
        .take(limit.unwrap_or(usize::MAX))
        .map(|xref| {
            let containing = engine.containing_function(xref.from);
            json!({
                "from": xref.from,
                "from_hex": format!("0x{:x}", xref.from),
                "to": xref.to,
                "to_hex": format!("0x{:x}", xref.to),
                "kind": xref.kind.as_str(),
                "instruction": xref.instruction,
                "from_function": containing.as_ref().map(|(name, _)| name.clone()),
                "from_function_hex": containing.as_ref().map(|(_, addr)| format!("0x{addr:x}")),
            })
        })
        .collect();

    let query = json!({
        "name": params.name,
        "address": params.address,
        "direction": params.direction,
        "kinds": params.kinds,
        "limit": limit,
    });
    let summary = json!({
        "binary": engine.binary,
        "name": entry.name,
        "address": address,
        "address_hex": format!("0x{address:x}"),
        "direction": params.direction,
        "count": count,
    });
    let page = json!({"limit": limit, "offset": 0, "returned": items.len()});
    Ok(success_body(
        Route::GetFunctionXref.kind(),
        query,
        summary,
        json!(items),
        page,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substring_filter_is_case_insensitive_by_default() {
        let filter = NameFilter::new(Some("get"), &[], &[], false, false).unwrap();
        assert!(filter.matches("getFoo"));
        assert!(filter.matches("GetFoo"));
        assert!(!filter.matches("setFoo"));
    }

    #[test]
    fn substring_filter_can_be_case_sensitive() {
        let filter = NameFilter::new(None, &["Get".to_string()], &[], true, false).unwrap();
        assert!(filter.matches("GetFoo"));
        assert!(!filter.matches("getFoo"));
    }

    #[test]
    fn includes_and_excludes_combine() {
        let filter = NameFilter::new(
            None,
            &["get".to_string()],
            &["danger".to_string()],
            false,
            false,
        )
        .unwrap();
        assert!(filter.matches("getFoo"));
        assert!(!filter.matches("getDanger"));
        assert!(!filter.matches("setFoo"));
    }

    #[test]
    fn regex_filter_applies() {
        let filter =
            NameFilter::new(None, &["^get_[a-z]+$".to_string()], &[], true, true).unwrap();
        assert!(filter.matches("get_value"));
        assert!(!filter.matches("get_Value"));
        assert!(!filter.matches("x_get_value"));
    }

    #[test]
    fn regex_filter_can_be_case_insensitive() {
        let filter =
            NameFilter::new(None, &["^GET_".to_string()], &[], false, true).unwrap();
        assert!(filter.matches("get_value"));
    }

    #[test]
    fn bad_regex_is_invalid_parameter() {
        let error = NameFilter::new(None, &["(".to_string()], &[], false, true).unwrap_err();
        assert_eq!(error.status, 400);
        assert_eq!(error.code, "INVALID_PARAMETER");
        assert!(error.message.contains("invalid regex"), "{}", error.message);
    }

    #[test]
    fn parses_flat_function_params() {
        let params: FunctionsParams =
            parse_json(br#"{"name_contains":"main","limit":5,"offset":1}"#).unwrap();
        assert_eq!(params.name_contains.as_deref(), Some("main"));
        assert_eq!(params.limit, Some(5));
        assert_eq!(params.offset, Some(1));
        assert_eq!(params.includes, None);
    }

    #[test]
    fn missing_fields_default_to_none() {
        let params: FunctionsParams = parse_json(b"{}").unwrap();
        assert!(params.name_contains.is_none());
        assert!(params.includes.is_none());
        assert!(params.limit.is_none());
        assert!(params.regex.is_none());
        assert!(params.case_sensitive.is_none());
    }

    #[test]
    fn empty_body_is_an_empty_object() {
        let params: FunctionsParams = parse_json(b"").unwrap();
        assert!(params.limit.is_none());
    }

    #[test]
    fn extra_fields_are_ignored() {
        let params: FunctionsParams =
            parse_json(br#"{"name_contains":"a","surprise":true}"#).unwrap();
        assert_eq!(params.name_contains.as_deref(), Some("a"));
    }

    #[test]
    fn wrong_field_types_are_invalid_parameter() {
        let error = parse_json::<FunctionsParams>(br#"{"limit":"abc"}"#).unwrap_err();
        assert_eq!(error.code, "INVALID_PARAMETER");
        assert!(error.message.contains("invalid JSON body"), "{}", error.message);

        let error = parse_json::<FunctionsParams>(br#"{"includes":"not-a-list"}"#).unwrap_err();
        assert_eq!(error.code, "INVALID_PARAMETER");
    }

    #[test]
    fn negative_limit_and_offset_are_rejected() {
        let error = non_negative(Some(-1), "limit").unwrap_err();
        assert_eq!(error.code, "INVALID_PARAMETER");
        assert_eq!(non_negative(None, "limit").unwrap(), None);
        assert_eq!(non_negative(Some(0), "limit").unwrap(), Some(0));
    }

    #[test]
    fn truncate_code_limits_lines_without_marker() {
        let code = Some("a\nb\nc".to_string());
        let (text, truncated, lines) = truncate_code(code.clone(), Some(2));
        assert_eq!(text.as_deref(), Some("a\nb"));
        assert!(truncated);
        assert_eq!(lines, 2);

        let (text, truncated, lines) = truncate_code(code.clone(), Some(10));
        assert_eq!(text, code);
        assert!(!truncated);
        assert_eq!(lines, 3);

        let (text, truncated, lines) = truncate_code(code, None);
        assert_eq!(text.as_deref(), Some("a\nb\nc"));
        assert!(!truncated);
        assert_eq!(lines, 3);
    }

    #[test]
    fn truncate_code_handles_none_and_zero() {
        let (text, truncated, lines) = truncate_code(None, Some(3));
        assert_eq!(text, None);
        assert!(!truncated);
        assert_eq!(lines, 0);

        let (text, truncated, lines) = truncate_code(Some("a\nb".to_string()), Some(0));
        assert_eq!(text.as_deref(), Some(""));
        assert!(truncated);
        assert_eq!(lines, 0);
    }

    #[test]
    fn success_envelope_has_all_fields() {
        let body = success_body(
            "functions",
            json!({"name_contains": null}),
            json!({"binary": "/tmp/x", "count": 1, "total": 2}),
            json!([{"name": "main"}]),
            json!({"limit": 100, "offset": 0, "returned": 1}),
        );
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["ok"], Value::Bool(true));
        assert_eq!(value["kind"], "functions");
        assert_eq!(value["summary"]["count"], 1);
        assert_eq!(value["items"][0]["name"], "main");
        assert_eq!(value["page"]["returned"], 1);
    }

    #[test]
    fn error_envelope_carries_code_and_message() {
        let body = error_body("function_source", &ApiError::function_not_found("nope"));
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["ok"], Value::Bool(false));
        assert_eq!(value["kind"], "function_source");
        assert_eq!(value["error"]["code"], "FUNCTION_NOT_FOUND");
        assert_eq!(value["error"]["message"], "nope");
    }

    #[test]
    fn envelope_json_escapes_special_characters() {
        let weird = "fn \"quoted\"\n\ttabbed \\ slash \u{4e2d}\u{6587}";
        let body = success_body("functions", Value::Null, json!({"name": weird}), Value::Null, Value::Null);
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["summary"]["name"], weird);
        assert!(!body.contains('\n') || value["summary"]["name"] == weird);
    }

    #[test]
    fn object_location_serializes_or_nulls() {
        let location = kuna_console::engine::ObjectLocation {
            section_index: 4,
            section: ".text.foo".to_string(),
            offset: 16,
        };
        let value = object_location_json(Some(&location));
        assert_eq!(value["section_index"], 4);
        assert_eq!(value["section"], ".text.foo");
        assert_eq!(value["offset_hex"], "0x10");
        assert_eq!(object_location_json(None), Value::Null);
    }
}

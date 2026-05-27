from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


class DecxCoreError(RuntimeError):
    pass


ENDPOINTS: dict[str, str] = {
    "health": "/health",
    "get_classes": "/api/decx/get_classes",
    "search_global_key": "/api/decx/search_global_key",
    "get_class_context": "/api/decx/get_class_context",
    "get_class_source": "/api/decx/get_class_source",
    "search_class_key": "/api/decx/search_class_key",
    "search_method": "/api/decx/search_method",
    "get_method_source": "/api/decx/get_method_source",
    "get_method_context": "/api/decx/get_method_context",
    "get_method_cfg": "/api/decx/get_method_cfg",
    "get_method_xref": "/api/decx/get_method_xref",
    "get_field_xref": "/api/decx/get_field_xref",
    "get_class_xref": "/api/decx/get_class_xref",
    "get_implement": "/api/decx/get_implement",
    "get_sub_classes": "/api/decx/get_sub_classes",
    "get_aidl": "/api/decx/get_aidl",
    "get_app_manifest": "/api/decx/get_app_manifest",
    "get_main_activity": "/api/decx/get_main_activity",
    "get_application": "/api/decx/get_application",
    "get_exported_components": "/api/decx/get_exported_components",
    "get_deep_links": "/api/decx/get_deep_links",
    "get_dynamic_receivers": "/api/decx/get_dynamic_receivers",
    "get_all_resources": "/api/decx/get_all_resources",
    "get_resource_file": "/api/decx/get_resource_file",
    "get_strings": "/api/decx/get_strings",
    "get_system_service_impl": "/api/decx/get_system_service_impl",
}


DEFAULT_PAYLOADS: dict[str, dict[str, Any]] = {
    "get_classes": {"filter": {"includes": [], "excludes": []}, "page": 1},
    "search_global_key": {
        "search": {"includes": [], "excludes": [], "caseSensitive": False, "regex": True},
        "page": 1,
    },
    "get_class_source": {"smali": False, "filter": {}, "page": 1},
    "search_class_key": {"grep": {"limit": 20, "caseSensitive": False, "regex": True}, "page": 1},
    "get_aidl": {"filter": {"includes": [], "excludes": []}, "page": 1},
    "get_exported_components": {"includes": [], "excludes": [], "page": 1},
    "get_dynamic_receivers": {"filter": {"includes": [], "excludes": []}, "page": 1},
    "get_all_resources": {"filter": {"includes": []}, "page": 1},
}


REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "search_global_key": ("key",),
    "get_class_context": ("cls",),
    "get_class_source": ("cls",),
    "search_class_key": ("cls", "key"),
    "search_method": ("mth",),
    "get_method_source": ("mth",),
    "get_method_context": ("mth",),
    "get_method_cfg": ("mth",),
    "get_method_xref": ("mth",),
    "get_field_xref": ("fld",),
    "get_class_xref": ("cls",),
    "get_implement": ("iface",),
    "get_sub_classes": ("cls",),
    "get_resource_file": ("res",),
    "get_system_service_impl": ("iface",),
}


def allowed_probe_names() -> list[str]:
    return [name for name in ENDPOINTS if name != "health"]


def build_payload(name: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if name not in ENDPOINTS:
        raise DecxCoreError(f"unknown DECX probe: {name}")
    if name == "health":
        return {}
    merged = dict(DEFAULT_PAYLOADS.get(name, {}))
    if payload:
        merged = merge_dicts(merged, payload)
    if "page" not in merged:
        merged["page"] = 1
    missing = [field for field in REQUIRED_FIELDS.get(name, ()) if not merged.get(field)]
    if missing:
        raise DecxCoreError(f"{name} missing required fields: {', '.join(missing)}")
    return merged


def merge_dicts(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = merge_dicts(merged[key], value)
        else:
            merged[key] = value
    return merged


@dataclass(slots=True)
class ProbeResult:
    name: str
    payload: dict[str, Any]
    ok: bool
    result: Any = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data = {"name": self.name, "payload": self.payload, "ok": self.ok}
        if self.ok:
            data["result"] = self.result
        else:
            data["error"] = self.error
        return data


class DecxCoreClient:
    def __init__(self, *, host: str = "127.0.0.1", port: int, timeout: float = 30.0):
        self.base_url = f"http://{host}:{port}"
        self.timeout = timeout

    def call(self, name: str, payload: dict[str, Any] | None = None) -> Any:
        request_payload = build_payload(name, payload)
        path = ENDPOINTS[name]
        if name == "health":
            return self._request("GET", path, None)
        return self._request("POST", path, request_payload)

    def probe(self, data: dict[str, Any]) -> ProbeResult:
        name = str(data.get("name") or data.get("endpoint") or "").strip()
        payload = data.get("payload") or {}
        if not isinstance(payload, dict):
            return ProbeResult(name=name or "<missing>", payload={}, ok=False, error="payload must be an object")
        try:
            request_payload = build_payload(name, payload)
            return ProbeResult(name=name, payload=request_payload, ok=True, result=self.call(name, request_payload))
        except Exception as exc:
            return ProbeResult(name=name or "<missing>", payload=payload, ok=False, error=str(exc))

    def _request(self, method: str, path: str, payload: dict[str, Any] | None) -> Any:
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise DecxCoreError(f"HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, socket.timeout) as exc:
            raise DecxCoreError(f"connection failed: {exc}") from exc

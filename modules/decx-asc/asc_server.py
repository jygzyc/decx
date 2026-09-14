#!/usr/bin/env python3
"""asc_server.py -- stdlib-only DECX HTTP adapter for ASC (Droid ASC).

ASC ships as a pure-Python APK analyzer (no server, no JVM).  DECX engines are
launched as ``<binary> <target-file> --port <port>`` and are expected to expose
``GET /health`` (JSON with ``"status": "running"``) plus JSON routes under
``/api/decx/``.  This file is the missing glue: it imports ASC's core API from
the pinned git submodule, keeps exactly one ``ApkHandler`` for the target APK,
and maps DECX requests to ASC's public Python API.

ASC source model (submodule, no vendoring):

* ``modules/decx-asc/asc`` is a git submodule of ``https://github.com/MG1937/ASC``
  pinned by the superproject gitlink (see ``.gitmodules``).  Nothing in the
  submodule is copied, patched or forked by DECX.
* This adapter imports ``src.asc_client.apk_handler`` / ``asc_handler`` from that
  tree after adding the submodule root to ``sys.path``.  The packaged archive
  keeps the same shape (``asc_server.py`` next to ``asc/``), so the server works
  both from a repo checkout and from ``$DECX_HOME/engines/asc``.
* The ASC root is resolved by :func:`discover_asc_root` (``--asc-root`` flag,
  ``ASC_ROOT`` env, sibling ``asc/`` directory, or an enclosing checkout).

Design constraints (see decx/docs/asc-server.md and README.md):

* stdlib only -- no Flask/FastAPI; ``http.server.ThreadingHTTPServer``.
* nothing from ASC is imported at module import time, so this file can be
  unit-tested (request validation / error mapping) without androguard.
* one shared, warmed handler instance; a server-level semaphore bounds
  concurrent ASC calls because ASC spawns thread/process pools per call.
* ASC output is passed through verbatim; nothing is fabricated.  A class miss
  or an empty findrefs result is reported as such.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
import threading
import time
import traceback
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ADAPTER_VERSION = "0.1.0"

DEFAULT_THREADS = 4
DEFAULT_CONCURRENCY = 2

MAX_BODY_BYTES = 1 << 20  # 1 MiB is far above any DECX request body
MAX_QUERY_LENGTH = 4096
MAX_CLASS_LENGTH = 1024
MAX_LIMIT = 100000

FIND_TYPES = ("string", "type", "method", "field")

FINDREF_LINE_RE = re.compile(
    r"^(?P<dex>.*) \| (?P<method>.*) \| matched=\((?P<matched>.*)\)$"
)
CLASS_NOT_FOUND_SUFFIX = "not found in the reconstructed DEX."

HEALTH_PATH = "/health"
API_CLASS_SOURCE = "/api/decx/get_class_source"
API_FIND_REFS = "/api/decx/find_refs"
API_PATHS = (API_CLASS_SOURCE, API_FIND_REFS)

# ASC submodule / checkout discovery.
ASC_SUBMODULE_DIR = "asc"
ASC_CORE_MARKER = os.path.join("src", "asc_client", "apk_handler.py")
ASC_ROOT_ENV = "ASC_ROOT"
ASC_ANCESTOR_LEVELS = 4


class ApiError(Exception):
    """An error that maps 1:1 onto a DECX error response."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = int(status)
        self.code = code
        self.message = message


class AscRootError(RuntimeError):
    """The pinned ASC submodule/checkout could not be located."""


# ---------------------------------------------------------------------------
# Request validation / response envelopes (pure helpers, unit-testable)
# ---------------------------------------------------------------------------


def error_body(kind: str, code: str, message: str) -> dict:
    return {"ok": False, "kind": kind, "error": {"code": code, "message": message}}


def success_body(kind: str, query: dict, summary: dict, items: list, page: dict) -> dict:
    return {
        "ok": True,
        "kind": kind,
        "query": query,
        "summary": summary,
        "items": items,
        "page": page,
    }


def map_exception(exc: BaseException) -> ApiError:
    """Translate an exception from ASC (or the transport) into an ApiError."""
    if isinstance(exc, ApiError):
        return exc
    if isinstance(exc, re.error):
        return ApiError(400, "INVALID_PARAMETER", f"invalid regex: {exc}")
    if isinstance(exc, FileNotFoundError):
        return ApiError(500, "INTERNAL_ERROR", f"target file not readable: {exc}")
    if isinstance(exc, ValueError) and "not found" in str(exc).lower():
        return ApiError(404, "CLASS_NOT_FOUND", str(exc))
    return ApiError(500, "INTERNAL_ERROR", f"{type(exc).__name__}: {exc}")


def format_class_name(name: str) -> str:
    """Mirror ASC's main.py ``_format_class_name`` (com.poc.Main -> Lcom/poc/Main;)."""
    if not isinstance(name, str) or not name.strip():
        raise ApiError(400, "INVALID_PARAMETER", "cls must be a non-empty string")
    if len(name) > MAX_CLASS_LENGTH:
        raise ApiError(
            400,
            "INVALID_PARAMETER",
            f"cls is too long ({len(name)} > {MAX_CLASS_LENGTH} characters)",
        )
    if name.startswith("L") and name.endswith(";") and "/" in name:
        return name
    name = name.replace(".", "/")
    if not name.startswith("L"):
        name = f"L{name}"
    if not name.endswith(";"):
        name = f"{name};"
    return name


def normalize_class_query(name, fuzzy: bool):
    """Mirror ASC's main.py ``_normalize_class_query``."""
    if name is None:
        return None
    if fuzzy:
        if "." in name and "/" not in name:
            return name.replace(".", "/")
        return name
    return format_class_name(name)


def build_member_find(key: str, clz, clz_fuzzy: bool, name):
    """Mirror ASC's main.py ``_build_member_find`` (bool is "class precise")."""
    if clz == "":
        clz = None
    if name == "":
        name = None
    if clz is None and name is None:
        raise ApiError(
            400, "INVALID_PARAMETER", f"{key} query needs at least one of class or {key} name"
        )
    if clz is None:
        return {key: {"class": None, key: name}}
    clz = normalize_class_query(clz, clz_fuzzy)
    return {key: {"class": [clz, not clz_fuzzy], key: name}}


def build_find_query(find_type: str, query: str, cls, fuzzy_class: bool) -> dict:
    """Build the ``find`` dict ASC's FindRefManager expects (see main.py)."""
    if find_type == "string":
        return {"string": query}
    if find_type == "type":
        return {"type": query}
    if find_type == "method":
        return build_member_find("method", cls, fuzzy_class, query)
    return build_member_find("field", cls, fuzzy_class, query)


def parse_limit(body: dict):
    """Extract ``filter.limit`` (or a top-level ``limit``) as a positive int."""
    limit = None
    filt = body.get("filter")
    if filt is not None:
        if not isinstance(filt, dict):
            raise ApiError(400, "INVALID_PARAMETER", "filter must be a JSON object")
        limit = filt.get("limit")
    if limit is None:
        limit = body.get("limit")
    if limit is None:
        return None
    if isinstance(limit, bool) or not isinstance(limit, int):
        raise ApiError(400, "INVALID_PARAMETER", "filter.limit must be a positive integer")
    if limit < 1:
        raise ApiError(400, "INVALID_PARAMETER", "filter.limit must be >= 1")
    return min(limit, MAX_LIMIT)


def parse_class_source_request(body: dict):
    if not isinstance(body, dict):
        raise ApiError(400, "INVALID_PARAMETER", "JSON body must be an object")
    cls = body.get("cls")
    if cls is None:
        cls = body.get("class")
    if not isinstance(cls, str) or not cls.strip():
        raise ApiError(400, "INVALID_PARAMETER", "cls is required and must be a non-empty string")
    if len(cls) > MAX_CLASS_LENGTH:
        raise ApiError(
            400,
            "INVALID_PARAMETER",
            f"cls is too long ({len(cls)} > {MAX_CLASS_LENGTH} characters)",
        )
    return cls, parse_limit(body)


def parse_find_refs_request(body: dict):
    if not isinstance(body, dict):
        raise ApiError(400, "INVALID_PARAMETER", "JSON body must be an object")

    find_type = body.get("type")
    if find_type not in FIND_TYPES:
        raise ApiError(
            400,
            "INVALID_PARAMETER",
            "type must be one of: " + ", ".join(FIND_TYPES),
        )

    query = body.get("query")
    if query is None:
        query = body.get("value")
    if query is None:
        query = ""
    if not isinstance(query, str):
        raise ApiError(400, "INVALID_PARAMETER", "query must be a string")
    if len(query) > MAX_QUERY_LENGTH:
        raise ApiError(
            400,
            "INVALID_PARAMETER",
            f"query is too long ({len(query)} > {MAX_QUERY_LENGTH} characters)",
        )

    cls = body.get("cls")
    if cls is None:
        cls = body.get("class")
    if cls is not None and not isinstance(cls, str):
        raise ApiError(400, "INVALID_PARAMETER", "cls must be a string")

    fuzzy_class = body.get("fuzzy_class", False)
    if not isinstance(fuzzy_class, bool):
        raise ApiError(400, "INVALID_PARAMETER", "fuzzy_class must be a boolean")

    if find_type in ("string", "type"):
        if cls:
            raise ApiError(400, "INVALID_PARAMETER", "cls is only valid for method/field queries")
        if query == "":
            raise ApiError(400, "INVALID_PARAMETER", "query must be a non-empty string")
        try:
            # ASC compiles the pattern as a bytes regex over MUTF-8 string data.
            re.compile(query.encode("utf-8"))
        except re.error as exc:
            raise ApiError(400, "INVALID_PARAMETER", f"invalid {find_type} regex: {exc}") from exc
    else:
        if query == "" and not cls:
            raise ApiError(
                400,
                "INVALID_PARAMETER",
                f"{find_type} query needs at least one of cls or query",
            )

    return {
        "type": find_type,
        "query": query,
        "cls": cls,
        "fuzzy_class": fuzzy_class,
        "limit": parse_limit(body),
    }


def truncate_lines(text: str, limit):
    """Cap ``text`` to ``limit`` lines; return (text, total, returned, truncated)."""
    total = len(text.splitlines())
    if limit is None or total <= limit:
        return text, total, total, False
    kept = "\n".join(text.splitlines()[:limit])
    if kept and not kept.endswith("\n"):
        kept += "\n"
    return kept, total, limit, True


def parse_findref_line(line: str, dex_name=None) -> dict:
    """Parse one ASC findrefs output line into its real fields.

    Upstream format (src/asc_client/asc_handler.py):
        {dex_name} | {class}->{method} | matched=({name}; {name}; ...)
    """
    match = FINDREF_LINE_RE.match(line)
    if match is None:
        return {"dex": dex_name, "method": None, "matched": [], "line": line}
    matched = [part for part in match.group("matched").split("; ") if part]
    return {
        "dex": match.group("dex"),
        "method": match.group("method"),
        "matched": matched,
        "line": line,
    }


# ---------------------------------------------------------------------------
# ASC submodule discovery and import
# ---------------------------------------------------------------------------


def _looks_like_asc_root(path) -> bool:
    return bool(path) and os.path.isfile(os.path.join(path, ASC_CORE_MARKER))


def _asc_root_candidates(script_path: str, explicit=None, env=None) -> list:
    """Candidate ASC roots, most explicit first."""
    candidates = []

    def add(path):
        if path:
            abspath = os.path.abspath(path)
            if abspath not in candidates:
                candidates.append(abspath)

    add(explicit)
    if not explicit:
        add((env if env is not None else os.environ.get(ASC_ROOT_ENV, "")).strip() or None)

    script_dir = os.path.dirname(os.path.abspath(script_path))
    add(os.path.join(script_dir, ASC_SUBMODULE_DIR))  # packaged archive: <root>/asc
    add(script_dir)  # dev: this file placed inside an ASC checkout

    parent = script_dir
    for _ in range(ASC_ANCESTOR_LEVELS):
        ancestor = os.path.dirname(parent)
        if not ancestor or ancestor == parent:
            break
        parent = ancestor
        add(os.path.join(parent, ASC_SUBMODULE_DIR))
    return candidates


def discover_asc_root(script_path: str, explicit=None, env=None) -> str:
    """Locate the pinned ASC tree (the ``modules/decx-asc/asc`` submodule).

    ``explicit`` (``--asc-root``) and ``$ASC_ROOT`` are honored first and are
    hard requirements when set: a bad explicit path is an error, not a reason to
    silently fall back to another checkout.
    """
    if explicit:
        abspath = os.path.abspath(explicit)
        if not _looks_like_asc_root(abspath):
            raise AscRootError(
                f"--asc-root {abspath} does not look like an ASC checkout "
                f"(missing {ASC_CORE_MARKER})"
            )
        return abspath

    env_value = (env if env is not None else os.environ.get(ASC_ROOT_ENV, "")) or ""
    if env_value.strip():
        abspath = os.path.abspath(env_value.strip())
        if not _looks_like_asc_root(abspath):
            raise AscRootError(
                f"{ASC_ROOT_ENV}={abspath} does not look like an ASC checkout "
                f"(missing {ASC_CORE_MARKER})"
            )
        return abspath

    candidates = _asc_root_candidates(script_path, explicit=None, env="")
    for candidate in candidates:
        if _looks_like_asc_root(candidate):
            return candidate
    raise AscRootError(
        "ASC sources not found. Initialize the pinned submodule with\n"
        "  git submodule update --init modules/decx-asc/asc\n"
        "or point the server at a checkout with --asc-root <dir> / $ASC_ROOT.\n"
        "Looked in:\n  " + "\n  ".join(candidates)
    )


def _preload_process_stdlib() -> None:
    """Load the real multiprocessing stack before ASC's stub installer runs.

    ``src/asc_core/utils/decompiler.py`` puts ``DummyModule`` placeholders in
    ``sys.modules`` for modules it wants to skip importing at startup, including
    ``multiprocessing``.  ``DummyModule.__path__`` is an empty list, so once the
    stub is installed a later ``import multiprocessing.connection`` (performed by
    ``concurrent.futures.ProcessPoolExecutor``, which backs ASC findrefs) fails
    with ``ModuleNotFoundError: No module named 'multiprocessing.connection'``.
    ASC's installer only stubs modules that are not already loaded, so touching
    the real module here first keeps findrefs working.  See also
    ``_process_pool_context`` in ``src/asc_client/apk_handler.py``.
    """
    import multiprocessing  # noqa: F401
    import multiprocessing.connection  # noqa: F401
    import multiprocessing.context  # noqa: F401
    import multiprocessing.reduction  # noqa: F401


class AscApi:
    """ASC's core API, imported from the submodule at startup.

    The imports live behind this class (never at module import time) so the
    adapter's validation and transport layers stay testable without androguard.
    """

    def __init__(self, asc_root: str, apk_handler_cls, asc_handler_cls, asc_handler_module):
        self.root = asc_root
        self.ApkHandler = apk_handler_cls
        self.AscHandler = asc_handler_cls
        self.asc_handler_module = asc_handler_module

    @classmethod
    def load(cls, asc_root: str) -> "AscApi":
        """Add ``asc_root`` to ``sys.path`` and import ASC's public client API."""
        os.chdir(asc_root)
        if asc_root not in sys.path:
            sys.path.insert(0, asc_root)
        _preload_process_stdlib()
        try:
            from src.asc_client import asc_handler as asc_handler_module
            from src.asc_client.apk_handler import ApkHandler
            from src.asc_client.asc_handler import AscHandler
        except Exception as exc:  # noqa: BLE001
            raise AscRootError(
                f"failed to import ASC from {asc_root}: {type(exc).__name__}: {exc}"
            ) from exc
        return cls(asc_root, ApkHandler, AscHandler, asc_handler_module)

    def warm(self, asc_handler) -> str:
        """Run ASC's lazy import so the first request does not pay for it.

        Upstream keeps the lazy import as a module-level function
        (``asc_handler._lazy_import``); the handler method check is kept for
        forward compatibility.  A failure here means the androguard/ASC core
        stack is unusable, which must not be reported as a healthy engine.
        """
        warm = getattr(asc_handler, "_lazy_import", None)
        if not callable(warm):
            warm = getattr(self.asc_handler_module, "_lazy_import", None)
        if not callable(warm):
            return "skipped"
        started = time.perf_counter()
        warm()  # androguard DAD + ASC core imports
        return f"{(time.perf_counter() - started) * 1000:.0f}ms"


# ---------------------------------------------------------------------------
# Application layer
# ---------------------------------------------------------------------------


class AscApp:
    """Shared, warm state for one target APK plus the two DECX route handlers."""

    def __init__(self, target: str, apk_handler, asc_handler, concurrency: int = DEFAULT_CONCURRENCY):
        self.target = target
        self.apk_handler = apk_handler
        self.asc_handler = asc_handler
        self.semaphore = threading.BoundedSemaphore(max(1, concurrency))

    def health(self) -> dict:
        return {
            "ok": True,
            "status": "running",
            "engine": "asc",
            "version": ADAPTER_VERSION,
            "target": self.target,
        }

    def get_class_source(self, cls_raw: str, limit) -> dict:
        dalvik_class = format_class_name(cls_raw)
        hit = self.apk_handler.get_class_dex(dalvik_class)
        if hit is None:
            raise ApiError(
                404, "CLASS_NOT_FOUND", f"class {dalvik_class} not found in {self.target}"
            )
        dex_name, dex_buf = hit
        source = self.asc_handler.getclass(dex_buf, dalvik_class)
        if not isinstance(source, str):
            raise ApiError(500, "INTERNAL_ERROR", "ASC returned a non-string class source")
        if source.startswith("Error: Class ") and source.endswith(CLASS_NOT_FOUND_SUFFIX):
            raise ApiError(
                404, "CLASS_NOT_FOUND", f"class {dalvik_class} not found in reconstructed dex"
            )

        code, total, returned, truncated = truncate_lines(source, limit)
        return success_body(
            "class_source",
            {"cls": cls_raw},
            {
                "dex": dex_name,
                "total_lines": total,
                "returned_lines": returned,
                "truncated": truncated,
            },
            [{"name": dalvik_class, "code": code, "error": None}],
            {"index": 1, "size": returned, "has_next": truncated},
        )

    def find_refs(self, req: dict) -> dict:
        find = build_find_query(req["type"], req["query"], req["cls"], req["fuzzy_class"])
        items = []
        for dex_name, lines in self.apk_handler.for_each_findrefs(req["type"], find):
            if not lines:
                continue
            for line in lines:
                items.append(parse_findref_line(line, dex_name))

        limit = req["limit"]
        truncated = limit is not None and len(items) > limit
        if truncated:
            items = items[:limit]
        return success_body(
            "find_refs",
            {
                "query": req["query"],
                "type": req["type"],
                "cls": req["cls"],
                "fuzzy_class": req["fuzzy_class"],
            },
            {"count": len(items)},
            items,
            {"index": 1, "size": len(items), "has_next": truncated},
        )


# ---------------------------------------------------------------------------
# HTTP transport
# ---------------------------------------------------------------------------


class AscHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, app: AscApp, debug: bool = False, quiet: bool = False):
        self.app = app
        self.debug = debug
        self.quiet = quiet
        super().__init__(address, DecxRequestHandler)


class DecxRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"asc-server/{ADAPTER_VERSION}"

    # -- logging ------------------------------------------------------------

    def log_message(self, fmt, *args):
        if getattr(self.server, "quiet", False):
            return
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        sys.stderr.write(f"[{stamp}] {self.address_string()} {fmt % args}\n")
        sys.stderr.flush()

    def log_error(self, fmt, *args):
        self.log_message(fmt, *args)

    # -- routing ------------------------------------------------------------

    def do_GET(self):  # noqa: N802 (http.server API)
        path = urlsplit(self.path).path
        if path == HEALTH_PATH:
            self._send_json(200, self.server.app.health())
        elif path in API_PATHS:
            self._send_error(405, "METHOD_NOT_ALLOWED", f"use POST for {path}", kind="error")
        else:
            self._send_error(404, "UNKNOWN_ENDPOINT", f"unknown route: {path}", kind="error")

    def do_POST(self):  # noqa: N802 (http.server API)
        path = urlsplit(self.path).path
        if path == API_CLASS_SOURCE:
            self._handle_class_source()
        elif path == API_FIND_REFS:
            self._handle_find_refs()
        elif path == HEALTH_PATH:
            self._send_error(405, "METHOD_NOT_ALLOWED", "use GET for /health", kind="error")
        else:
            self._send_error(404, "UNKNOWN_ENDPOINT", f"unknown route: {path}", kind="error")

    # -- route handlers -----------------------------------------------------

    def _handle_class_source(self):
        kind = "class_source"
        try:
            body = self._read_json()
            cls, limit = parse_class_source_request(body)
            with self.server.app.semaphore:
                payload = self.server.app.get_class_source(cls, limit)
        except BaseException as exc:  # noqa: BLE001 -- map everything into the envelope
            self._report_exception(kind, exc)
            return
        self._send_json(200, payload)

    def _handle_find_refs(self):
        kind = "find_refs"
        try:
            body = self._read_json()
            request = parse_find_refs_request(body)
            with self.server.app.semaphore:
                payload = self.server.app.find_refs(request)
        except BaseException as exc:  # noqa: BLE001
            self._report_exception(kind, exc)
            return
        self._send_json(200, payload)

    # -- helpers ------------------------------------------------------------

    def _read_json(self) -> dict:
        header = self.headers.get("Content-Length")
        if header is None:
            raise ApiError(400, "INVALID_PARAMETER", "missing Content-Length header")
        try:
            length = int(header)
        except ValueError as exc:
            raise ApiError(400, "INVALID_PARAMETER", "invalid Content-Length header") from exc
        if length < 0:
            raise ApiError(400, "INVALID_PARAMETER", "invalid Content-Length header")
        if length > MAX_BODY_BYTES:
            raise ApiError(
                400,
                "INVALID_PARAMETER",
                f"request body too large ({length} > {MAX_BODY_BYTES} bytes)",
            )
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ApiError(400, "INVALID_PARAMETER", "incomplete request body")
        if not raw:
            return {}
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, "INVALID_PARAMETER", f"invalid JSON body: {exc}") from exc
        if not isinstance(body, dict):
            raise ApiError(400, "INVALID_PARAMETER", "JSON body must be an object")
        return body

    def _report_exception(self, kind: str, exc: BaseException):
        error = map_exception(exc)
        if self.server.debug or error.status >= 500:
            sys.stderr.write(
                f"[asc-server] {kind} failed: {type(exc).__name__}: {exc}\n"
            )
            if self.server.debug:
                traceback.print_exc(file=sys.stderr)
            sys.stderr.flush()
        self._send_error(error.status, error.code, error.message, kind=kind)

    def _send_error(self, status: int, code: str, message: str, kind: str = "error"):
        self._send_json(status, error_body(kind, code, message), close=True)

    def _send_json(self, status: int, payload: dict, close: bool = False):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            if close or status >= 500 or status == 400:
                # an error response may leave the request body unread; do not
                # risk desynchronizing a keep-alive connection
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):  # client vanished
            self.close_connection = True


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="asc-server",
        description="DECX HTTP adapter for the ASC APK analyzer (stdlib only).",
    )
    parser.add_argument("target", help="path to the APK to analyze")
    parser.add_argument("--port", type=int, required=True, help="TCP port to bind on 127.0.0.1")
    parser.add_argument(
        "--asc-root",
        help=f"ASC checkout/submodule root (default: ${ASC_ROOT_ENV} or the bundled asc/ tree)",
    )
    parser.add_argument(
        "--threads",
        "--thread",
        dest="threads",
        type=int,
        default=DEFAULT_THREADS,
        help=f"ASC worker threads per call (default {DEFAULT_THREADS})",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=DEFAULT_CONCURRENCY,
        help=f"max concurrent ASC calls (default {DEFAULT_CONCURRENCY})",
    )
    parser.add_argument("--debug", action="store_true", help="verbose logging + ASC debug output")
    args = parser.parse_args(argv)
    if not (1 <= args.port <= 65535):
        parser.error("--port must be in 1..65535")
    if args.threads < 1:
        parser.error("--threads must be >= 1")
    if args.concurrency < 1:
        parser.error("--concurrency must be >= 1")
    return args


def _fail(message: str, code: int = 1):
    sys.stderr.write(f"asc-server: error: {message}\n")
    sys.stderr.flush()
    raise SystemExit(code)


def _target_has_dex(target: str) -> bool:
    try:
        with zipfile.ZipFile(target) as zf:
            return any(name.endswith(".dex") for name in zf.namelist())
    except (zipfile.BadZipFile, OSError):
        return False


def main(argv=None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)

    try:
        asc_root = discover_asc_root(__file__, explicit=args.asc_root)
    except AscRootError as exc:
        _fail(str(exc))

    target = os.path.abspath(args.target)
    if not os.path.isfile(target):
        _fail(f"target file not found: {target}")
    if not zipfile.is_zipfile(target) or not _target_has_dex(target):
        _fail(f"cannot load target as an APK/zip with .dex entries: {target}")

    started = time.perf_counter()
    try:
        api = AscApi.load(asc_root)
        apk_handler = api.ApkHandler(target, debug=args.debug, max_workers=args.threads)
        asc_handler = api.AscHandler(debug=args.debug)
        warmup = api.warm(asc_handler)  # androguard DAD + ASC core imports
    except AscRootError as exc:
        _fail(str(exc))
    except Exception as exc:  # noqa: BLE001
        _fail(f"failed to initialize ASC from {asc_root}: {type(exc).__name__}: {exc}")

    app = AscApp(target, apk_handler, asc_handler, concurrency=args.concurrency)
    try:
        httpd = AscHTTPServer(("127.0.0.1", args.port), app, debug=args.debug)
    except OSError as exc:
        _fail(f"failed to bind 127.0.0.1:{args.port}: {exc}")

    def _shutdown(_signum, _frame):
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _shutdown)
        except (ValueError, OSError):
            pass

    sys.stderr.write(
        f"[asc-server] version={ADAPTER_VERSION} target={target} asc={asc_root} "
        f"threads={args.threads} concurrency={args.concurrency} "
        f"warmup={warmup} total={(time.perf_counter() - started) * 1000:.0f}ms\n"
    )
    sys.stderr.flush()
    print(f"asc-server listening on port {args.port}", flush=True)
    try:
        httpd.serve_forever(poll_interval=0.25)
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Unit tests for asc_server.py.

These tests exercise request parsing, validation, error mapping and the HTTP
envelope without importing androguard or ASC: ``asc_server`` performs all ASC
imports inside ``main()``, and the HTTP tests drive ``AscApp`` with duck-typed
fake handlers.

Run from ``decx/servers/asc``:

    python3 -m unittest discover -s tests -v
    # or
    python3 tests/test_asc_server.py
"""

import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "asc_server.py"
_SPEC = importlib.util.spec_from_file_location("asc_server", MODULE_PATH)
asc_server = importlib.util.module_from_spec(_SPEC)
sys.modules["asc_server"] = asc_server
_SPEC.loader.exec_module(asc_server)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeApkHandler:
    def __init__(self, hit=("classes.dex", b""), lines=None, exc=None):
        self.hit = hit
        self.lines = lines if lines is not None else []
        self.exc = exc
        self.calls = []

    def get_class_dex(self, dalvik_class):
        self.calls.append(("get_class_dex", dalvik_class))
        if self.exc is not None:
            raise self.exc
        return self.hit

    def for_each_findrefs(self, find_type, find):
        self.calls.append(("for_each_findrefs", find_type, find))
        if self.exc is not None:
            raise self.exc
        yield "classes.dex", self.lines


class FakeAscHandler:
    def __init__(self, source="public class X {\n    int a = 1;\n}\n", exc=None):
        self.source = source
        self.exc = exc

    def getclass(self, dex_buf, dalvik_class):
        if self.exc is not None:
            raise self.exc
        return self.source


class ServerFixture:
    def __init__(self, app):
        self.app = app
        self.httpd = None
        self.thread = None
        self.base = None

    def __enter__(self):
        self.httpd = asc_server.AscHTTPServer(("127.0.0.1", 0), self.app, quiet=True)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        return self

    def __exit__(self, *exc_info):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=10)


def request_json(url, body=None, method="GET"):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def api_app(apk=None, asc=None, concurrency=2):
    return asc_server.AscApp(
        "/tmp/fake.apk",
        apk if apk is not None else FakeApkHandler(),
        asc if asc is not None else FakeAscHandler(),
        concurrency=concurrency,
    )


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class TestClassNames(unittest.TestCase):
    def test_format_class_name(self):
        self.assertEqual(asc_server.format_class_name("com.example.Foo"), "Lcom/example/Foo;")
        self.assertEqual(asc_server.format_class_name("Lcom/example/Foo;"), "Lcom/example/Foo;")
        self.assertEqual(asc_server.format_class_name("Foo"), "LFoo;")

    def test_format_class_name_rejects_empty_and_long(self):
        for bad in ("", "   ", None, 42):
            with self.assertRaises(asc_server.ApiError) as ctx:
                asc_server.format_class_name(bad)
            self.assertEqual(ctx.exception.status, 400)
            self.assertEqual(ctx.exception.code, "INVALID_PARAMETER")
        too_long = "a" * (asc_server.MAX_CLASS_LENGTH + 1)
        with self.assertRaises(asc_server.ApiError):
            asc_server.format_class_name(too_long)

    def test_build_member_find_matches_upstream_shapes(self):
        self.assertEqual(
            asc_server.build_member_find("method", "com.poc.Main", False, "onCreate"),
            {"method": {"class": ["Lcom/poc/Main;", True], "method": "onCreate"}},
        )
        self.assertEqual(
            asc_server.build_member_find("method", None, False, "onCreate"),
            {"method": {"class": None, "method": "onCreate"}},
        )
        self.assertEqual(
            asc_server.build_member_find("field", "MainActivity", True, "apiKey"),
            {"field": {"class": ["MainActivity", False], "field": "apiKey"}},
        )
        with self.assertRaises(asc_server.ApiError):
            asc_server.build_member_find("field", None, False, None)

    def test_build_find_query(self):
        self.assertEqual(
            asc_server.build_find_query("string", "token", None, False), {"string": "token"}
        )
        self.assertEqual(
            asc_server.build_find_query("type", "com.example.Foo", None, False),
            {"type": "com.example.Foo"},
        )
        self.assertEqual(
            asc_server.build_find_query("method", "notify", "MainActivity", True),
            {"method": {"class": ["MainActivity", False], "method": "notify"}},
        )


class TestRequestParsing(unittest.TestCase):
    def test_class_source_ok(self):
        cls, limit = asc_server.parse_class_source_request({"cls": "com.example.Foo"})
        self.assertEqual(cls, "com.example.Foo")
        self.assertIsNone(limit)

    def test_class_source_limit(self):
        _, limit = asc_server.parse_class_source_request(
            {"cls": "X", "filter": {"limit": 25}}
        )
        self.assertEqual(limit, 25)
        self.assertEqual(asc_server.parse_class_source_request({"cls": "X", "limit": 7})[1], 7)

    def test_class_source_invalid(self):
        for body in ({}, {"cls": ""}, {"cls": 5}, {"cls": "X", "filter": 3}):
            with self.assertRaises(asc_server.ApiError) as ctx:
                asc_server.parse_class_source_request(body)
            self.assertEqual(ctx.exception.status, 400)
            self.assertEqual(ctx.exception.code, "INVALID_PARAMETER")

    def test_limit_invalid(self):
        for limit in (0, -1, "5", 1.5, True):
            with self.assertRaises(asc_server.ApiError):
                asc_server.parse_limit({"filter": {"limit": limit}})

    def test_find_refs_string_ok(self):
        req = asc_server.parse_find_refs_request({"query": "token", "type": "string"})
        self.assertEqual(req["type"], "string")
        self.assertEqual(req["query"], "token")
        self.assertIsNone(req["cls"])
        self.assertFalse(req["fuzzy_class"])
        self.assertIsNone(req["limit"])

    def test_find_refs_valid_regex_problem(self):
        with self.assertRaises(asc_server.ApiError) as ctx:
            asc_server.parse_find_refs_request({"query": "(", "type": "string"})
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.code, "INVALID_PARAMETER")
        # ASC compiles the pattern as a bytes regex; (?u) must be rejected here too
        with self.assertRaises(asc_server.ApiError):
            asc_server.parse_find_refs_request({"query": "(?u)x", "type": "type"})

    def test_find_refs_rejects_bad_type_and_missing_query(self):
        for body in (
            {"query": "x", "type": "banana"},
            {"query": "", "type": "string"},
            {"query": 5, "type": "string"},
            {"query": "x" * (asc_server.MAX_QUERY_LENGTH + 1), "type": "string"},
            {"query": "x", "type": "string", "cls": "com.example.Foo"},
            {"query": "x", "type": "string", "fuzzy_class": "yes"},
            {"query": "", "type": "method"},
        ):
            with self.assertRaises(asc_server.ApiError) as ctx:
                asc_server.parse_find_refs_request(body)
            self.assertEqual(ctx.exception.status, 400)

    def test_find_refs_method_with_class_only(self):
        req = asc_server.parse_find_refs_request(
            {"query": "", "type": "method", "cls": "com.example.Foo", "fuzzy_class": True}
        )
        self.assertEqual(req["query"], "")
        self.assertEqual(req["cls"], "com.example.Foo")
        self.assertTrue(req["fuzzy_class"])

    def test_parse_find_refs_value_alias(self):
        req = asc_server.parse_find_refs_request({"value": "abc", "type": "string"})
        self.assertEqual(req["query"], "abc")


class TestTruncateAndParse(unittest.TestCase):
    def test_truncate_lines_noop(self):
        text = "a\nb\nc\n"
        self.assertEqual(asc_server.truncate_lines(text, None), (text, 3, 3, False))
        self.assertEqual(asc_server.truncate_lines(text, 3), (text, 3, 3, False))

    def test_truncate_lines_caps(self):
        code, total, returned, truncated = asc_server.truncate_lines("a\nb\nc\nd\n", 2)
        self.assertEqual(code, "a\nb\n")
        self.assertEqual((total, returned, truncated), (4, 2, True))

    def test_parse_findref_line(self):
        line = "classes.dex | Lcom/x/Y;->z() | matched=(foo; bar)"
        item = asc_server.parse_findref_line(line)
        self.assertEqual(item["dex"], "classes.dex")
        self.assertEqual(item["method"], "Lcom/x/Y;->z()")
        self.assertEqual(item["matched"], ["foo", "bar"])
        self.assertEqual(item["line"], line)

    def test_parse_findref_line_unknown_format(self):
        item = asc_server.parse_findref_line("junk", "classes2.dex")
        self.assertEqual(item["dex"], "classes2.dex")
        self.assertIsNone(item["method"])
        self.assertEqual(item["matched"], [])
        self.assertEqual(item["line"], "junk")


class TestExceptionMapping(unittest.TestCase):
    def test_map_exception(self):
        self.assertEqual(asc_server.map_exception(asc_server.ApiError(418, "X", "y")).status, 418)
        mapped = asc_server.map_exception(asc_server.re.error("bad"))
        self.assertEqual((mapped.status, mapped.code), (400, "INVALID_PARAMETER"))
        mapped = asc_server.map_exception(ValueError("Class Lx; not found in DEX."))
        self.assertEqual((mapped.status, mapped.code), (404, "CLASS_NOT_FOUND"))
        mapped = asc_server.map_exception(RuntimeError("boom"))
        self.assertEqual((mapped.status, mapped.code), (500, "INTERNAL_ERROR"))


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


class TestHTTP(unittest.TestCase):
    def setUp(self):
        self.apk = FakeApkHandler()
        self.asc = FakeAscHandler()
        self.fixture = ServerFixture(api_app(self.apk, self.asc))
        self.fixture.__enter__()
        self.addCleanup(self.fixture.__exit__)

    def post(self, path, body):
        return request_json(self.fixture.base + path, body=body, method="POST")

    def test_health(self):
        status, body = request_json(self.fixture.base + "/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["status"], "running")
        self.assertEqual(body["engine"], "asc")
        self.assertEqual(body["version"], asc_server.ADAPTER_VERSION)
        self.assertEqual(body["target"], "/tmp/fake.apk")

    def test_class_source_success(self):
        status, body = self.post(
            "/api/decx/get_class_source", {"cls": "com.example.Foo"}
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["kind"], "class_source")
        self.assertEqual(body["query"], {"cls": "com.example.Foo"})
        self.assertEqual(body["items"][0]["name"], "Lcom/example/Foo;")
        self.assertIn("public class X", body["items"][0]["code"])
        self.assertIsNone(body["items"][0]["error"])
        self.assertEqual(body["summary"]["dex"], "classes.dex")
        self.assertFalse(body["summary"]["truncated"])
        self.assertEqual(self.apk.calls, [("get_class_dex", "Lcom/example/Foo;")])

    def test_class_source_limit(self):
        status, body = self.post(
            "/api/decx/get_class_source", {"cls": "com.example.Foo", "filter": {"limit": 1}}
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["items"][0]["code"], "public class X {\n")
        self.assertTrue(body["summary"]["truncated"])
        self.assertEqual(body["summary"]["returned_lines"], 1)
        self.assertTrue(body["page"]["has_next"])

    def test_class_not_found(self):
        apk = FakeApkHandler(hit=None)
        with ServerFixture(api_app(apk, self.asc)) as fixture:
            status, body = request_json(
                fixture.base + "/api/decx/get_class_source",
                body={"cls": "com.example.Missing"},
                method="POST",
            )
        self.assertEqual(status, 404)
        self.assertFalse(body["ok"])
        self.assertEqual(body["kind"], "class_source")
        self.assertEqual(body["error"]["code"], "CLASS_NOT_FOUND")

    def test_asc_not_found_value_error_maps_404(self):
        asc = FakeAscHandler(exc=ValueError("Class Lcom/example/Foo; not found in DEX."))
        with ServerFixture(api_app(self.apk, asc)) as fixture:
            status, body = request_json(
                fixture.base + "/api/decx/get_class_source",
                body={"cls": "com.example.Foo"},
                method="POST",
            )
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "CLASS_NOT_FOUND")

    def test_asc_error_string_maps_404(self):
        asc = FakeAscHandler(
            source="Error: Class Lcom/example/Foo; not found in the reconstructed DEX."
        )
        with ServerFixture(api_app(self.apk, asc)) as fixture:
            status, body = request_json(
                fixture.base + "/api/decx/get_class_source",
                body={"cls": "com.example.Foo"},
                method="POST",
            )
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "CLASS_NOT_FOUND")

    def test_internal_error(self):
        apk = FakeApkHandler(exc=RuntimeError("boom"))
        with ServerFixture(api_app(apk, self.asc)) as fixture:
            status, body = request_json(
                fixture.base + "/api/decx/get_class_source",
                body={"cls": "com.example.Foo"},
                method="POST",
            )
        self.assertEqual(status, 500)
        self.assertEqual(body["error"]["code"], "INTERNAL_ERROR")

    def test_invalid_json(self):
        req = urllib.request.Request(
            self.fixture.base + "/api/decx/get_class_source",
            data=b"{not json",
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            urllib.request.urlopen(req, timeout=15)
            self.fail("expected HTTPError")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 400)
            body = json.loads(exc.read().decode())
        self.assertEqual(body["error"]["code"], "INVALID_PARAMETER")
        self.assertEqual(body["kind"], "class_source")

    def test_oversized_body(self):
        # send headers only: the server must reject on Content-Length alone and
        # not block waiting for a body it already refused to read
        import re
        import socket

        sock = socket.create_connection(
            ("127.0.0.1", self.fixture.httpd.server_address[1]), timeout=10
        )
        try:
            sock.sendall(
                b"POST /api/decx/find_refs HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: 2000000\r\n\r\n"
            )
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
            header, _, rest = data.partition(b"\r\n\r\n")
            match = re.search(rb"Content-Length: (\d+)", header, re.I)
            remaining = int(match.group(1)) - len(rest) if match else 0
            while remaining > 0:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                rest += chunk
                remaining -= len(chunk)
        finally:
            sock.close()
        status_line = header.partition(b"\r\n")[0]
        self.assertIn(b" 400 ", status_line)
        self.assertIn(b"INVALID_PARAMETER", rest)

    def test_unknown_route(self):
        status, body = request_json(self.fixture.base + "/api/decx/nope")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "UNKNOWN_ENDPOINT")
        self.assertFalse(body["ok"])

    def test_method_not_allowed(self):
        status, body = request_json(self.fixture.base + "/api/decx/find_refs")
        self.assertEqual(status, 405)
        self.assertEqual(body["error"]["code"], "METHOD_NOT_ALLOWED")

    def test_find_refs_success_and_limit(self):
        lines = [
            "classes.dex | Lcom/x/Y;->a() | matched=(token)",
            "classes.dex | Lcom/x/Z;->b() | matched=(token; other)",
            "classes.dex | Lcom/x/W;->c() | matched=(token)",
        ]
        apk = FakeApkHandler(lines=lines)
        with ServerFixture(api_app(apk, self.asc)) as fixture:
            status, body = request_json(
                fixture.base + "/api/decx/find_refs",
                body={"query": "token", "type": "string"},
                method="POST",
            )
            self.assertEqual(status, 200)
            self.assertTrue(body["ok"])
            self.assertEqual(body["kind"], "find_refs")
            self.assertEqual(body["summary"], {"count": 3})
            self.assertEqual(body["query"], {"query": "token", "type": "string", "cls": None, "fuzzy_class": False})
            self.assertEqual(body["items"][1]["method"], "Lcom/x/Z;->b()")
            self.assertEqual(body["items"][1]["matched"], ["token", "other"])
            self.assertEqual(body["items"][1]["line"], lines[1])
            self.assertFalse(body["page"]["has_next"])

            status, body = request_json(
                fixture.base + "/api/decx/find_refs",
                body={"query": "token", "type": "string", "filter": {"limit": 2}},
                method="POST",
            )
            self.assertEqual(body["summary"], {"count": 2})
            self.assertTrue(body["page"]["has_next"])

        self.assertEqual(apk.calls[-1][1], "string")
        self.assertEqual(apk.calls[-1][2], {"string": "token"})

    def test_find_refs_method_query_passthrough(self):
        apk = FakeApkHandler(lines=[])
        with ServerFixture(api_app(apk, self.asc)) as fixture:
            status, body = request_json(
                fixture.base + "/api/decx/find_refs",
                body={
                    "query": "notify",
                    "type": "method",
                    "cls": "MainActivity",
                    "fuzzy_class": True,
                },
                method="POST",
            )
        self.assertEqual(status, 200)
        self.assertEqual(body["summary"], {"count": 0})
        self.assertEqual(body["items"], [])
        self.assertEqual(
            apk.calls[-1][2],
            {"method": {"class": ["MainActivity", False], "method": "notify"}},
        )

    def test_find_refs_invalid_regex(self):
        status, body = self.post(
            "/api/decx/find_refs", {"query": "(", "type": "string"}
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "INVALID_PARAMETER")
        self.assertEqual(body["kind"], "find_refs")

    def test_concurrent_requests_are_semaphore_bounded(self):
        import time as _time

        class SlowApk(FakeApkHandler):
            def __init__(self):
                super().__init__()
                self.active = 0
                self.max_active = 0
                self.lock = threading.Lock()

            def get_class_dex(self, dalvik_class):
                with self.lock:
                    self.active += 1
                    self.max_active = max(self.max_active, self.active)
                try:
                    _time.sleep(0.2)
                    return self.hit
                finally:
                    with self.lock:
                        self.active -= 1

        apk = SlowApk()
        app = api_app(apk, self.asc, concurrency=2)
        with ServerFixture(app) as fixture:
            results = []

            def call(i):
                results.append(
                    request_json(
                        fixture.base + "/api/decx/get_class_source",
                        body={"cls": f"com.example.C{i}"},
                        method="POST",
                    )[0]
                )

            threads = [threading.Thread(target=call, args=(i,)) for i in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=30)
        self.assertEqual(results, [200, 200, 200, 200])
        self.assertLessEqual(apk.max_active, 2)


class TestAscRootDiscovery(unittest.TestCase):
    """The pinned submodule layout must resolve without any environment help."""

    def make_asc_root(self, root: pathlib.Path) -> pathlib.Path:
        marker = root / "src" / "asc_client" / "apk_handler.py"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("# upstream ASC\n", encoding="utf-8")
        return root

    def test_packaged_layout_uses_sibling_asc_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            asc = self.make_asc_root(root / "asc")
            script = root / "asc_server.py"
            script.write_text("", encoding="utf-8")
            self.assertEqual(asc_server.discover_asc_root(str(script), env=""), str(asc))

    def test_repo_layout_resolves_submodule_next_to_the_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            asc = self.make_asc_root(root / "decx" / "asc-server" / "asc")
            script = root / "decx" / "asc-server" / "asc_server.py"
            script.write_text("", encoding="utf-8")
            self.assertEqual(asc_server.discover_asc_root(str(script), env=""), str(asc))

    def test_server_inside_a_checkout_uses_that_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            asc = self.make_asc_root(pathlib.Path(tmp) / "ASC")
            script = asc / "asc_server.py"
            script.write_text("", encoding="utf-8")
            self.assertEqual(asc_server.discover_asc_root(str(script), env=""), str(asc))

    def test_explicit_root_and_env_are_hard_requirements(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(asc_server.AscRootError):
                asc_server.discover_asc_root("/nonexistent/asc_server.py", explicit=tmp)
            with self.assertRaises(asc_server.AscRootError):
                asc_server.discover_asc_root("/nonexistent/asc_server.py", env=tmp)

    def test_missing_submodule_reports_the_init_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = pathlib.Path(tmp) / "asc_server.py"
            script.write_text("", encoding="utf-8")
            with self.assertRaises(asc_server.AscRootError) as ctx:
                asc_server.discover_asc_root(str(script), env="")
            self.assertIn("git submodule update --init", str(ctx.exception))

    def test_configured_root_is_reported_before_failing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            asc = self.make_asc_root(root / "custom-asc")
            script = root / "asc_server.py"
            script.write_text("", encoding="utf-8")
            self.assertEqual(
                asc_server.discover_asc_root(str(script), explicit=str(asc)), str(asc)
            )
            self.assertEqual(asc_server.discover_asc_root(str(script), env=str(asc)), str(asc))


if __name__ == "__main__":
    unittest.main(verbosity=2)

/**
 * DECX API integration tests (mock-based).
 *
 * Validates every DecxClient API endpoint's response structure against
 * the known server response format. Uses mock fetch — no real server needed.
 *
 * Mock data sourced from real Sieve APK (com.withsecure.example.sieve) via decx-server.
 */

import { DecxClient } from "../src/core/client.js";

let mockFetchImpl: (url: string | URL | Request) => Promise<Response>;
function mockFetch(url: string | URL | Request): Promise<Response> {
    return mockFetchImpl(url);
}

// ── Mock fetch helpers ───────────────────────────────────────────────────

type MockMapping = { path: string; body: unknown };

const mappings: MockMapping[] = [];

function mockResponse(path: string, body: unknown) {
    mappings.push({ path, body });
}

function setupMockFetch() {
    mockFetchImpl = async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        const match = mappings.find((m) => urlStr.includes(m.path));
        if (match) {
            return {
                ok: true,
                status: 200,
                json: async () => match.body,
            } as Response;
        }
        return {
            ok: false,
            status: 404,
            json: async () => ({ ok: false, kind: "unknown", query: {}, error: { code: "NOT_FOUND", message: "Not found" } }),
        } as Response;
    };
}

function teardownMockFetch() {
    mockFetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) } as Response);
    mappings.length = 0;
}

// ── Shared assertion helpers ─────────────────────────────────────────────

/** Assert a standard { ok, kind, query, summary, items, page } envelope. */
function expectSuccessEnvelope(res: Record<string, unknown>) {
    expect(res).toHaveProperty("ok", true);
    expect(res).toHaveProperty("kind");
    expect(res).toHaveProperty("summary");
    expect(res).toHaveProperty("items");
    expect(res).toHaveProperty("page");
    expect(Array.isArray(res.items)).toBe(true);
}

/** Assert each item has the standard { id, kind, title, content, meta } shape. */
function expectItemShape(items: unknown[]) {
    for (const item of items) {
        const i = item as Record<string, unknown>;
        expect(i).toHaveProperty("id");
        expect(i).toHaveProperty("kind");
        expect(i).toHaveProperty("title");
        expect(i).toHaveProperty("content");
        expect(i).toHaveProperty("meta");
    }
}

// ── Test suite ───────────────────────────────────────────────────────────

describe("DECX API integration (Sieve APK)", () => {
    let client: DecxClient;

    beforeAll(() => {
        client = new DecxClient("127.0.0.1", 25419, 10, mockFetch);
    });

    afterAll(() => {
        teardownMockFetch();
    });

    // ── Health ─────────────────────────────────────────────────────────

    describe("health", () => {
        beforeAll(() => {
            mockResponse("/health", {
                status: "running",
                url: "http://198.18.0.1:25419",
                port: 25419,
                timestamp: 1775567879734,
            });
            setupMockFetch();
        });

        it("healthCheck returns { status: 'running' }", async () => {
            const res = await client.healthCheck();
            expect(res).toHaveProperty("status", "running");
        });

        it("isHealthy returns true", async () => {
            const res = await client.isHealthy();
            expect(res).toBe(true);
        });
    });

    // ── CommonService ──────────────────────────────────────────────────

    describe("CommonService", () => {
        // getClasses
        describe("getClasses", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_classes", {
                    ok: true,
                    kind: "classes",
                    query: { includes: ["com.withsecure.example.sieve"] },
                    summary: { total: 6588, returned: 5, truncated: true },
                    items: [
                        { id: "android.support.v4.app.INotificationSideChannel", kind: "symbol", title: "android.support.v4.app.INotificationSideChannel", content: "android.support.v4.app.INotificationSideChannel", meta: {} },
                        { id: "android.support.v4.app.INotificationSideChannel.Default", kind: "symbol", title: "android.support.v4.app.INotificationSideChannel.Default", content: "android.support.v4.app.INotificationSideChannel.Default", meta: {} },
                        { id: "android.support.v4.app.INotificationSideChannel.Stub", kind: "symbol", title: "android.support.v4.app.INotificationSideChannel.Stub", content: "android.support.v4.app.INotificationSideChannel.Stub", meta: {} },
                        { id: "android.support.v4.app.INotificationSideChannel.Stub.Proxy", kind: "symbol", title: "android.support.v4.app.INotificationSideChannel.Stub.Proxy", content: "android.support.v4.app.INotificationSideChannel.Stub.Proxy", meta: {} },
                        { id: "android.support.v4.app.INotificationSideChannel._Parcel", kind: "symbol", title: "android.support.v4.app.INotificationSideChannel._Parcel", content: "android.support.v4.app.INotificationSideChannel._Parcel", meta: {} },
                    ],
                    page: { index: 1, size: 5, has_next: true },
                });
                setupMockFetch();
            });

            it("returns success envelope with items array", async () => {
                const res = await client.getClasses({
                    filter: { includes: [], excludes: [] },
                });
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("classes");
                expectItemShape(res.items as unknown[]);
            });
        });

        // searchGlobalKey
        describe("searchGlobalKey", () => {
            beforeAll(() => {
                mockResponse("/api/decx/search_global_key", {
                    ok: true,
                    kind: "search_global",
                    query: { target: "Crypto" },
                    summary: { total: 2, returned: 2, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.service.CryptoService", kind: "symbol", title: "com.withsecure.example.sieve.service.CryptoService", content: "com.withsecure.example.sieve.service.CryptoService", meta: { category: "class" } },
                        { id: "com.withsecure.example.sieve.service.CryptoServiceConnector", kind: "symbol", title: "com.withsecure.example.sieve.service.CryptoServiceConnector", content: "com.withsecure.example.sieve.service.CryptoServiceConnector", meta: { category: "class" } },
                    ],
                    page: { index: 1, size: 2, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with class items", async () => {
                const res = await client.searchGlobalKey("Crypto", {
                    search: {
                        limit: 20,
                        includes: [],
                        excludes: [],
                        caseSensitive: false,
                        regex: true,
                    },
                });
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("search_global");
                expect((res.query as Record<string, unknown>).target).toBe("Crypto");
            });
        });

        // getClassContext
        describe("getClassContext", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_class_context", {
                    ok: true,
                    kind: "class_context",
                    query: { target: "com.withsecure.example.sieve.activity.WelcomeActivity" },
                    summary: { total: 20, returned: 20, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.activity.WelcomeActivity", kind: "symbol", title: "com.withsecure.example.sieve.activity.WelcomeActivity", content: "com.withsecure.example.sieve.activity.WelcomeActivity", meta: { category: "class", method_count: 12, field_count: 10 } },
                        { id: "com.withsecure.example.sieve.activity.WelcomeActivity.login(android.view.View):void", kind: "symbol", title: "com.withsecure.example.sieve.activity.WelcomeActivity.login(android.view.View):void", content: "com.withsecure.example.sieve.activity.WelcomeActivity.login(android.view.View):void", meta: { owner: "com.withsecure.example.sieve.activity.WelcomeActivity", category: "method" } },
                        { id: "com.withsecure.example.sieve.activity.WelcomeActivity.entry :android.widget.EditText", kind: "symbol", title: "com.withsecure.example.sieve.activity.WelcomeActivity.entry :android.widget.EditText", content: "com.withsecure.example.sieve.activity.WelcomeActivity.entry :android.widget.EditText", meta: { owner: "com.withsecure.example.sieve.activity.WelcomeActivity", category: "field" } },
                    ],
                    page: { index: 1, size: 20, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with class symbol + method/field items", async () => {
                const res = await client.getClassContext("com.withsecure.example.sieve.activity.WelcomeActivity");
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("class_context");
                const items = res.items as Record<string, unknown>[];
                const classItem = items.find(i => (i.meta as Record<string, unknown>).category === "class");
                expect(classItem).toBeDefined();
                expect(typeof (classItem!.meta as Record<string, unknown>).method_count).toBe("number");
            });
        });

        // getClassSource
        describe("getClassSource", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_class_source", {
                    ok: true,
                    kind: "class_source",
                    query: { target: "com.withsecure.example.sieve.activity.WelcomeActivity", smali: false },
                    summary: { total: 1, returned: 1, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.activity.WelcomeActivity", kind: "code", title: "com.withsecure.example.sieve.activity.WelcomeActivity", content: "package com.withsecure.example.sieve.activity;\n\npublic class WelcomeActivity extends Activity { }", meta: { language: "java", total_lines: 3, returned_lines: 3 } },
                    ],
                    page: { index: 1, size: 1, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with code item", async () => {
                const res = await client.getClassSource(
                    "com.withsecure.example.sieve.activity.WelcomeActivity",
                    false,
                    { filter: { limit: 120 } },
                );
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("class_source");
                const items = res.items as Record<string, unknown>[];
                expect(items[0].kind).toBe("code");
                expect(typeof items[0].content).toBe("string");
            });
        });

        // getMethodSource
        describe("getMethodSource", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_method_source", {
                    ok: true,
                    kind: "method_source",
                    query: { target: "com.withsecure.example.sieve.activity.WelcomeActivity.login(android.view.View):void", smali: false },
                    summary: { total: 1, returned: 1, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.activity.WelcomeActivity.login(android.view.View):void", kind: "code", title: "com.withsecure.example.sieve.activity.WelcomeActivity.login(android.view.View):void", content: "public void login(View view) { this.workingPassword = this.entry.getText().toString(); }", meta: { language: "java" } },
                    ],
                    page: { index: 1, size: 1, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with code item", async () => {
                const res = await client.getMethodSource(
                    "com.withsecure.example.sieve.activity.WelcomeActivity.login(android.view.View):void",
                );
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("method_source");
                const items = res.items as Record<string, unknown>[];
                expect(items[0].kind).toBe("code");
            });
        });

        // searchClassKey
        describe("searchClassKey", () => {
            beforeAll(() => {
                mockResponse("/api/decx/search_class_key", {
                    ok: true,
                    kind: "search_class",
                    query: { target: "Crypto", class: "com.withsecure.example.sieve.service.CryptoService" },
                    summary: { total: 2, returned: 2, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]#3", kind: "code", title: "3: com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]", content: "return runCrypto(value);", meta: { class: "com.withsecure.example.sieve.service.CryptoService", method: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]", line: 3 } },
                        { id: "com.withsecure.example.sieve.service.CryptoService.decrypt(java.lang.String):java.lang.String#5", kind: "code", title: "5: com.withsecure.example.sieve.service.CryptoService.decrypt(java.lang.String):java.lang.String", content: "return runCrypto(value);", meta: { class: "com.withsecure.example.sieve.service.CryptoService", method: "com.withsecure.example.sieve.service.CryptoService.decrypt(java.lang.String):java.lang.String", line: 5 } },
                    ],
                    page: { index: 1, size: 2, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with grep line items", async () => {
                const res = await client.searchClassKey("com.withsecure.example.sieve.service.CryptoService", "Crypto", {
                    grep: {
                        limit: 20,
                        caseSensitive: false,
                        regex: true,
                    },
                });
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("search_class");
                const items = res.items as Record<string, unknown>[];
                expect((items[0].meta as Record<string, unknown>).method).toBeDefined();
                expect((items[0].meta as Record<string, unknown>).line).toBeDefined();
            });
        });

        // searchMethod
        describe("searchMethod", () => {
            beforeAll(() => {
                mockResponse("/api/decx/search_method", {
                    ok: true,
                    kind: "search_method",
                    query: { target: "encrypt" },
                    summary: { total: 6, returned: 3, truncated: true },
                    items: [
                        { id: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]", kind: "symbol", title: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]", content: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]", meta: {} },
                        { id: "com.withsecure.example.sieve.service.CryptoService.runNDKencrypt(java.lang.String, java.lang.String):byte[]", kind: "symbol", title: "com.withsecure.example.sieve.service.CryptoService.runNDKencrypt(java.lang.String, java.lang.String):byte[]", content: "com.withsecure.example.sieve.service.CryptoService.runNDKencrypt(java.lang.String, java.lang.String):byte[]", meta: {} },
                        { id: "com.withsecure.example.sieve.service.CryptoServiceConnector.sendForEncryption(java.lang.String, java.lang.String, int):void", kind: "symbol", title: "com.withsecure.example.sieve.service.CryptoServiceConnector.sendForEncryption(java.lang.String, java.lang.String, int):void", content: "com.withsecure.example.sieve.service.CryptoServiceConnector.sendForEncryption(java.lang.String, java.lang.String, int):void", meta: {} },
                    ],
                    page: { index: 1, size: 3, has_next: true },
                });
                setupMockFetch();
            });

            it("returns success envelope with method items", async () => {
                const res = await client.searchMethod("encrypt");
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("search_method");
            });
        });

        // getMethodContext
        describe("getMethodContext", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_method_context", {
                    ok: true,
                    kind: "method_context",
                    query: { target: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]" },
                    summary: { total: 3, returned: 3, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]", kind: "symbol", title: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]", content: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]", meta: { owner: "com.withsecure.example.sieve.service.CryptoService", category: "method_signature", return_type: "byte[]", argument_count: 2, caller_count: 1, callee_count: 1 } },
                        { id: "com.withsecure.example.sieve.service.CryptoService.MessageHandler.handleMessage#43", kind: "xref", title: "Caller: com.withsecure.example.sieve.service.CryptoService.MessageHandler.handleMessage", content: "recievedBundle.putByteArray(CryptoService.RESULT, CryptoService.this.encrypt(recievedKey, recievedString));", meta: { owner: "com.withsecure.example.sieve.service.CryptoService", member: "com.withsecure.example.sieve.service.CryptoService.MessageHandler.handleMessage", line: 43, category: "caller" } },
                        { id: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]#callee-0", kind: "xref", title: "Callee: com.withsecure.example.sieve.service.CryptoService.runNDKencrypt(java.lang.String, java.lang.String):byte[]", content: "com.withsecure.example.sieve.service.CryptoService.runNDKencrypt(java.lang.String, java.lang.String):byte[]", meta: { owner: "com.withsecure.example.sieve.service.CryptoService", category: "callee", signature: "com.withsecure.example.sieve.service.CryptoService.runNDKencrypt(java.lang.String, java.lang.String):byte[]", call_count: 1, invoke_types: ["DIRECT"] } },
                    ],
                    page: { index: 1, size: 3, has_next: false },
                });
                setupMockFetch();
            });

            it("returns method signature, caller, and callee items", async () => {
                const res = await client.getMethodContext(
                    "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]",
                );
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("method_context");
                const items = res.items as Record<string, unknown>[];
                expect(items.length).toBe(3);
                expect(items[0].kind).toBe("symbol");
                expect((items[0].meta as Record<string, unknown>).category).toBe("method_signature");
                expect((items[1].meta as Record<string, unknown>).category).toBe("caller");
                expect((items[2].meta as Record<string, unknown>).category).toBe("callee");
            });
        });

        // getMethodCfg
        describe("getMethodCfg", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_method_cfg", {
                    ok: true,
                    kind: "method_cfg",
                    query: { target: "com.withsecure.example.sieve.service.AuthService.checkPinExists():boolean" },
                    summary: { total: 1, returned: 1, truncated: false },
                    items: [
                        {
                            id: "com.withsecure.example.sieve.service.AuthService.checkPinExists():boolean#cfg-dot",
                            kind: "code",
                            title: "CFG DOT: com.withsecure.example.sieve.service.AuthService.checkPinExists():boolean",
                            content: "digraph \"CFG forcom.withsecure.example.sieve.service.AuthService.checkPinExists():boolean\" {\n  Node_0 [shape=record,label=\"{0\\:\\ 0x0000}\"];\n  MethodNode -> Node_0;\n}",
                            meta: { language: "dot" },
                        },
                    ],
                    page: { index: 1, size: 1, has_next: false },
                });
                setupMockFetch();
            });

            it("returns a DOT code item", async () => {
                const res = await client.getMethodCfg(
                    "com.withsecure.example.sieve.service.AuthService.checkPinExists():boolean",
                );
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("method_cfg");
                const items = res.items as Record<string, unknown>[];
                expect(items).toHaveLength(1);
                expect(items[0].kind).toBe("code");
                expect(items[0].content).toContain("digraph \"CFG for");
                expect((items[0].meta as Record<string, unknown>).language).toBe("dot");
            });
        });

        // getMethodXref
        describe("getMethodXref", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_method_xref", {
                    ok: true,
                    kind: "method_xref",
                    query: { target: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]" },
                    summary: { total: 1, returned: 1, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.service.CryptoService.MessageHandler.handleMessage#43", kind: "xref", title: "Caller: com.withsecure.example.sieve.service.CryptoService.MessageHandler.handleMessage", content: "recievedBundle.putByteArray(CryptoService.RESULT, CryptoService.this.encrypt(recievedKey, recievedString));", meta: { owner: "com.withsecure.example.sieve.service.CryptoService", member: "com.withsecure.example.sieve.service.CryptoService.MessageHandler.handleMessage", line: 43 } },
                    ],
                    page: { index: 1, size: 1, has_next: false },
                });
                setupMockFetch();
            });

            it("returns xref items with caller details", async () => {
                const res = await client.getMethodXref(
                    "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]",
                );
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("method_xref");
                const items = res.items as Record<string, unknown>[];
                expect(items[0].kind).toBe("xref");
                expect((items[0].meta as Record<string, unknown>).line).toBe(43);
            });
        });

        // getFieldXref
        describe("getFieldXref", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_field_xref", {
                    ok: true,
                    kind: "field_xref",
                    query: { target: "com.withsecure.example.sieve.activity.WelcomeActivity.entry :android.widget.EditText" },
                    summary: { total: 1, returned: 1, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.activity.WelcomeActivity.login(android.view.View):void#10", kind: "xref", title: "Caller: com.withsecure.example.sieve.activity.WelcomeActivity.login(android.view.View):void", content: "this.workingPassword = this.entry.getText().toString();", meta: { owner: "com.withsecure.example.sieve.activity.WelcomeActivity", member: "com.withsecure.example.sieve.activity.WelcomeActivity.login(android.view.View):void", line: 10 } },
                    ],
                    page: { index: 1, size: 1, has_next: false },
                });
                setupMockFetch();
            });

            it("returns xref items with caller details", async () => {
                const res = await client.getFieldXref("com.withsecure.example.sieve.activity.WelcomeActivity.entry :android.widget.EditText");
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("field_xref");
                const items = res.items as Record<string, unknown>[];
                expect(items[0].kind).toBe("xref");
            });
        });

        // getClassXref
        describe("getClassXref", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_class_xref", {
                    ok: true,
                    kind: "class_xref",
                    query: { target: "com.withsecure.example.sieve.service.CryptoService" },
                    summary: { total: 2, returned: 2, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.service.CryptoService.MessageHandler#70", kind: "xref", title: "Caller: com.withsecure.example.sieve.service.CryptoService.MessageHandler", content: "Log.e(CryptoService.TAG, \"Unable to send message: \" + command);", meta: { owner: "com.withsecure.example.sieve.service.CryptoService", member: "com.withsecure.example.sieve.service.CryptoService.MessageHandler", line: 70 } },
                        { id: "com.withsecure.example.sieve.activity.PWList#236", kind: "xref", title: "Caller: com.withsecure.example.sieve.activity.PWList", content: "bindService(new Intent(this, (Class<?>) CryptoService.class), this.serviceConnection, 1);", meta: { owner: "com.withsecure.example.sieve.activity.PWList", member: "com.withsecure.example.sieve.activity.PWList", line: 236 } },
                    ],
                    page: { index: 1, size: 2, has_next: false },
                });
                setupMockFetch();
            });

            it("returns xref items with caller details", async () => {
                const res = await client.getClassXref("com.withsecure.example.sieve.service.CryptoService");
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("class_xref");
                expectItemShape(res.items as unknown[]);
            });
        });

        // getImplement
        describe("getImplement", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_implement", {
                    ok: true,
                    kind: "implementations",
                    query: { target: "android.content.ContentProvider" },
                    summary: { total: 1, returned: 1, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.provider.DBContentProvider", kind: "symbol", title: "com.withsecure.example.sieve.provider.DBContentProvider", content: "com.withsecure.example.sieve.provider.DBContentProvider", meta: {} },
                    ],
                    page: { index: 1, size: 1, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with implementation items", async () => {
                const res = await client.getImplement("android.content.ContentProvider");
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("implementations");
            });
        });

        // getSubClasses
        describe("getSubClasses", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_sub_classes", {
                    ok: true,
                    kind: "sub_classes",
                    query: { target: "android.app.Activity" },
                    summary: { total: 2, returned: 2, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.activity.WelcomeActivity", kind: "symbol", title: "com.withsecure.example.sieve.activity.WelcomeActivity", content: "com.withsecure.example.sieve.activity.WelcomeActivity", meta: {} },
                        { id: "com.withsecure.example.sieve.activity.FileSelectActivity", kind: "symbol", title: "com.withsecure.example.sieve.activity.FileSelectActivity", content: "com.withsecure.example.sieve.activity.FileSelectActivity", meta: {} },
                    ],
                    page: { index: 1, size: 2, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with subclass items", async () => {
                const res = await client.getSubClasses("android.app.Activity");
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("sub_classes");
            });
        });
    });

    // ── AndroidService ─────────────────────────────────────────────────

    describe("AndroidService", () => {
        // getAppManifest
        describe("getAppManifest", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_app_manifest", {
                    ok: true,
                    kind: "app_manifest",
                    query: { includes: ["androidx"] },
                    summary: { total: 1, returned: 1, truncated: false },
                    items: [
                        { id: "AndroidManifest.xml", kind: "code", title: "AndroidManifest.xml", content: '<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    package="com.withsecure.example.sieve">\n</manifest>', meta: { language: "xml" } },
                    ],
                    page: { index: 1, size: 1, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with code item for manifest", async () => {
                const res = await client.getAppManifest();
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("app_manifest");
                const items = res.items as Record<string, unknown>[];
                expect(items[0].kind).toBe("code");
            });
        });

        // getMainActivity
        describe("getMainActivity", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_main_activity", {
                    ok: true,
                    kind: "main_activity",
                    query: {},
                    summary: { total: 1, returned: 1, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.activity.WelcomeActivity", kind: "symbol", title: "com.withsecure.example.sieve.activity.WelcomeActivity", content: "com.withsecure.example.sieve.activity.WelcomeActivity", meta: { category: "activity", entry: "main" } },
                    ],
                    page: { index: 1, size: 1, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with activity symbol", async () => {
                const res = await client.getMainActivity();
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("main_activity");
            });
        });

        // getApplication
        describe("getApplication", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_application", {
                    ok: false,
                    kind: "application",
                    query: {},
                    error: { code: "NO_APPLICATION", message: "Application class not found" },
                });
                setupMockFetch();
            });

            it("returns error when no Application class found", async () => {
                const res = await client.getApplication();
                expect(res).toHaveProperty("ok", false);
                expect(res).toHaveProperty("error");
            });
        });

        // getExportedComponents
        describe("getExportedComponents", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_exported_components", {
                    ok: true,
                    kind: "exported_components",
                    query: { includes: ["activity", "service"] },
                    summary: { total: 8, returned: 3, truncated: true },
                    items: [
                        { id: "com.withsecure.example.sieve.activity.WelcomeActivity", kind: "symbol", title: "Exported activity: com.withsecure.example.sieve.activity.WelcomeActivity", content: "activity", meta: { name: "com.withsecure.example.sieve.activity.WelcomeActivity", type: "activity", launchMode: "singleTask" } },
                        { id: "com.withsecure.example.sieve.service.AuthService", kind: "symbol", title: "Exported service: com.withsecure.example.sieve.service.AuthService", content: "service", meta: { name: "com.withsecure.example.sieve.service.AuthService", type: "service" } },
                        { id: "com.withsecure.example.sieve.provider.DBContentProvider", kind: "symbol", title: "Exported provider: com.withsecure.example.sieve.provider.DBContentProvider", content: "provider", meta: { name: "com.withsecure.example.sieve.provider.DBContentProvider", type: "provider", authorities: "com.withsecure.example.sieve.provider.DBContentProvider" } },
                    ],
                    page: { index: 1, size: 3, has_next: true },
                });
                setupMockFetch();
            });

            it("returns success envelope with component items", async () => {
                const res = await client.getExportedComponents({ includes: ["activity", "service"] });
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("exported_components");
                const items = res.items as Record<string, unknown>[];
                for (const item of items) {
                    const meta = item.meta as Record<string, unknown>;
                    expect(typeof meta.name).toBe("string");
                    expect(typeof meta.type).toBe("string");
                }
            });
        });

        // getDeepLinks
        describe("getDeepLinks", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_deep_links", {
                    ok: true,
                    kind: "deep_links",
                    query: {},
                    summary: { total: 0, returned: 0, truncated: false },
                    items: [],
                    page: { index: 1, size: 0, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with empty items for no deep links", async () => {
                const res = await client.getDeepLinks();
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("deep_links");
                expect((res.items as unknown[]).length).toBe(0);
            });
        });

        // getDynamicReceivers
        describe("getDynamicReceivers", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_dynamic_receivers", {
                    ok: true,
                    kind: "dynamic_receivers",
                    query: { includes: ["androidx"] },
                    summary: { total: 2, returned: 2, truncated: false },
                    items: [
                        { id: "androidx.appcompat.app.AppCompatDelegateImpl.AutoNightModeManager#cleanup", kind: "code", title: "Dynamic receiver: cleanup", content: "void cleanup() { if (this.mReceiver != null) { try { AppCompatDelegateImpl.this.mContext.unregisterReceiver(this.mReceiver); } catch (IllegalArgumentException e) { } this.mReceiver = null; } }", meta: { class: "androidx.appcompat.app.AppCompatDelegateImpl.AutoNightModeManager", method: "void cleanup()", total_lines: 6 } },
                        { id: "androidx.core.content.ContextCompat#registerReceiver", kind: "code", title: "Dynamic receiver: registerReceiver", content: "public static Intent registerReceiver(Context context, BroadcastReceiver receiver, IntentFilter filter, int flags) { return registerReceiver(context, receiver, filter, null, null, flags); }", meta: { class: "androidx.core.content.ContextCompat", method: "registerReceiver", total_lines: 2 } },
                    ],
                    page: { index: 1, size: 2, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with code items for receivers", async () => {
                const res = await client.getDynamicReceivers({
                    filter: { includes: ["androidx"], excludes: [] },
                });
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("dynamic_receivers");
                const items = res.items as Record<string, unknown>[];
                for (const item of items) {
                    const meta = item.meta as Record<string, unknown>;
                    expect(typeof meta.class).toBe("string");
                }
            });
        });

        // getAllResources
        describe("getAllResources", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_all_resources", {
                    ok: true,
                    kind: "all_resources",
                    query: {},
                    summary: { total: 1174, returned: 4, truncated: true },
                    items: [
                        { id: "lib/x86_64/libsieve.so", kind: "symbol", title: "lib/x86_64/libsieve.so", content: "lib/x86_64/libsieve.so", meta: {} },
                        { id: "lib/arm64-v8a/libc++_shared.so", kind: "symbol", title: "lib/arm64-v8a/libc++_shared.so", content: "lib/arm64-v8a/libc++_shared.so", meta: {} },
                        { id: "lib/x86_64/libc++_shared.so", kind: "symbol", title: "lib/x86_64/libc++_shared.so", content: "lib/x86_64/libc++_shared.so", meta: {} },
                        { id: "META-INF/com/android/build/gradle/app-metadata.properties", kind: "symbol", title: "META-INF/com/android/build/gradle/app-metadata.properties", content: "META-INF/com/android/build/gradle/app-metadata.properties", meta: {} },
                    ],
                    page: { index: 1, size: 4, has_next: true },
                });
                setupMockFetch();
            });

            it("returns success envelope with resource items", async () => {
                const res = await client.getAllResources({
                    filter: { includes: ["res/layout"], regex: false },
                });
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("all_resources");
            });
        });

        // getResourceFile
        describe("getResourceFile", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_resource_file", {
                    ok: true,
                    kind: "resource_file",
                    query: { target: "res/layout/activity_main_login.xml" },
                    summary: { total: 1, returned: 1, truncated: false },
                    items: [
                        { id: "res/layout/activity_main_login.xml", kind: "code", title: "res/layout/activity_main_login.xml", content: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<RelativeLayout xmlns:android=\"http://schemas.android.com/apk/res/android\">\n    <Button android:id=\"@+id/mainlogin_button_login\" />\n</RelativeLayout>", meta: {} },
                    ],
                    page: { index: 1, size: 1, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with code item for resource", async () => {
                const res = await client.getResourceFile("res/layout/activity_main_login.xml");
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("resource_file");
                const items = res.items as Record<string, unknown>[];
                expect(items[0].kind).toBe("code");
            });
        });

        // getStrings
        describe("getStrings", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_strings", {
                    ok: true,
                    kind: "strings",
                    query: {},
                    summary: { total: 1, returned: 1, truncated: false },
                    items: [
                        { id: "res/values/strings.xml#app_name", kind: "symbol", title: "app_name", content: "Sieve", meta: { file: "res/values/strings.xml", category: "string" } },
                    ],
                    page: { index: 1, size: 1, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with string items", async () => {
                const res = await client.getStrings();
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("strings");
                const items = res.items as Record<string, unknown>[];
                expect(items[0].kind).toBe("symbol");
                expect((items[0].meta as Record<string, unknown>).category).toBe("string");
            });
        });

        // getAidlInterfaces
        describe("getAidlInterfaces", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_aidl", {
                    ok: true,
                    kind: "aidl_interfaces",
                    query: {},
                    summary: { total: 1, returned: 1, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.service.IAuth", kind: "symbol", title: "AIDL: IAuth", content: "", meta: { stub: "com.withsecure.example.sieve.service.IAuth.Stub", implementations: ["com.withsecure.example.sieve.service.AuthService", "com.withsecure.example.sieve.service.AuthServiceProxy"] } },
                    ],
                    page: { index: 1, size: 1, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with AIDL items", async () => {
                const res = await client.getAidlInterfaces({
                    filter: { includes: ["com.withsecure.example.sieve"], excludes: [] },
                });
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("aidl_interfaces");
            });
        });

        // getSystemServiceImpl
        describe("getSystemServiceImpl", () => {
            beforeAll(() => {
                mockResponse("/api/decx/get_system_service_impl", {
                    ok: true,
                    kind: "system_service_impl",
                    query: { target: "android.content.ServiceConnection" },
                    summary: { total: 5, returned: 5, truncated: false },
                    items: [
                        { id: "com.withsecure.example.sieve.service.CryptoService", kind: "symbol", title: "com.withsecure.example.sieve.service.CryptoService", content: "com.withsecure.example.sieve.service.CryptoService", meta: { category: "service_impl", interface: "android.content.ServiceConnection", method_count: 4, field_count: 2 } },
                        { id: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]", kind: "symbol", title: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]", content: "com.withsecure.example.sieve.service.CryptoService.encrypt(java.lang.String, java.lang.String):byte[]", meta: { class: "com.withsecure.example.sieve.service.CryptoService", category: "method" } },
                    ],
                    page: { index: 1, size: 5, has_next: false },
                });
                setupMockFetch();
            });

            it("returns success envelope with service impl items", async () => {
                const res = await client.getSystemServiceImpl("android.content.ServiceConnection");
                expectSuccessEnvelope(res);
                expect(res.kind).toBe("system_service_impl");
            });
        });
    });
});

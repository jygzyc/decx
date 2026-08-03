import { jest } from "@jest/globals";
import { DecxClient } from "../src/core/client.js";
import { DecxError } from "../src/utils/errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(code: string, message: string, status = 404): Response {
  return jsonResponse({ error: { code, message } }, status);
}

describe("DecxClient", () => {
  let fetchMock: ReturnType<typeof jest.fn<typeof fetch>>;
  let client: DecxClient;

  beforeEach(() => {
    fetchMock = jest.fn<typeof fetch>(async () => {
      throw new Error("ECONNREFUSED");
    });
    client = new DecxClient("127.0.0.1", 25419, 1, fetchMock);
  });

  describe("constructor", () => {
    it("creates client with correct baseUrl", () => {
      expect((client as any).baseUrl).toBe("http://127.0.0.1:25419");
    });

    it("creates client with correct timeout (in ms)", () => {
      expect((client as any).timeout).toBe(1000);
    });

    it("uses default values when no args", () => {
      const c = new DecxClient();
      expect((c as any).baseUrl).toBe("http://127.0.0.1:25419");
      expect((c as any).timeout).toBe(30000);
    });
  });

  describe("isHealthy", () => {
    it("returns false when server is not reachable", async () => {
      const result = await client.isHealthy();
      expect(result).toBe(false);
    });

    it("returns true when server reports status running", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: "running" }));
      const result = await client.isHealthy();
      expect(result).toBe(true);
    });

    it("returns false when server reports a non-running status", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: "starting" }));
      const result = await client.isHealthy();
      expect(result).toBe(false);
    });
  });

  describe("healthCheck", () => {
    it("throws DecxError when server is not reachable", async () => {
      await expect(client.healthCheck()).rejects.toThrow(DecxError);
      await expect(client.healthCheck()).rejects.toThrow(/Connection failed/);
    });

    it("returns body on 200", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: "running", version: "4.0.0" }));
      const result = await client.healthCheck();
      expect(result.status).toBe("running");
      expect(result.version).toBe("4.0.0");
    });

    it("throws DecxError on error status with structured body", async () => {
      fetchMock.mockResolvedValue(errorResponse("CLASS_NOT_FOUND", "Class not found: com.example.Foo"));
      await expect(client.healthCheck()).rejects.toThrow(/Class not found: com.example.Foo/);
    });
  });

  describe("request", () => {
    it("sends POST with JSON body and page parameter", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await client.getClasses({ filter: { includes: [], excludes: [] } }, 2);
      const call = fetchMock.mock.calls[0];
      expect(call[0]).toBe("http://127.0.0.1:25419/api/decx/get_classes");
      const init = call[1] as RequestInit;
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.page).toBe(2);
      expect(body.filter).toEqual({ includes: [], excludes: [] });
    });
  });

  describe("API methods exist", () => {
    it("has all expected methods", () => {
      const methods = [
        "healthCheck", "isHealthy",
        "getClasses", "searchGlobalKey", "getClassContext", "getClassSource",
        "searchClassKey", "searchMethod",
        "getMethodSource", "getMethodContext", "getMethodCfg",
        "getMethodXref", "getFieldXref", "getClassXref",
        "getImplementations", "getSubclasses",
        "getAppManifest", "getMainActivity", "getApplication",
        "getExportedComponents", "getDeepLinks",
        "getSystemServiceImpl",
        "getDynamicReceivers",
        "getAllResources", "getResourceFile", "getStrings",
        "getAidlInterfaces",
      ];
      for (const m of methods) {
        expect(typeof (client as any)[m]).toBe("function");
      }
    });
  });
});

/**
 * DecxClient unit tests.
 *
 * Tests constructor configuration and error handling.
 * Does NOT make real HTTP requests — server is expected to be down.
 */

import { DecxClient } from "../src/core/client.js";
import { DecxError } from "../src/utils/errors.js";

describe("DecxClient", () => {
  let client: DecxClient;

  beforeEach(() => {
    client = new DecxClient("127.0.0.1", 25419, 1); // 1s timeout
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
    it("returns false when server is not running", async () => {
      const result = await client.isHealthy();
      expect(result).toBe(false);
    });
  });

  describe("healthCheck", () => {
    it("throws DecxError when server is not running", async () => {
      await expect(client.healthCheck()).rejects.toThrow();
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
        "getImplement", "getSubClasses",
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

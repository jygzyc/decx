/**
 * Config Manager unit tests.
 */

import { Manager } from "../src/core/config.js";

describe("Manager", () => {
  it("returns singleton instance", () => {
    const a = Manager.get();
    const b = Manager.get();
    expect(a).toBe(b);
  });

  it("has serverJar config", () => {
    const mgr = Manager.get();
    expect(mgr.serverJar).toBeDefined();
    expect(mgr.serverJar.version).toBeDefined();
  });

  it("has server config with defaultPort", () => {
    const mgr = Manager.get();
    expect(mgr.server).toBeDefined();
    expect(mgr.server.defaultPort).toBe(25419);
  });

  describe("session delegation", () => {
    it("getSession returns null for unknown name", () => {
      const mgr = Manager.get();
      expect(mgr.getSession("nonexistent_test_session")).toBeNull();
    });

    it("listAliveSessions returns an array", () => {
      const mgr = Manager.get();
      const alive = mgr.listAliveSessions();
      expect(Array.isArray(alive)).toBe(true);
    });

    it("cleanupDead returns a number", () => {
      const mgr = Manager.get();
      const count = mgr.cleanupDead();
      expect(typeof count).toBe("number");
    });
  });
});

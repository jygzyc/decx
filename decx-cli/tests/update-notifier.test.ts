/**
 * Update notifier unit tests.
 */

import { jest } from "@jest/globals";
import { existsSync, writeFileSync } from "fs";
import * as path from "path";
import { compareSemver, fetchLatestStableVersion } from "../src/core/installer.js";
import {
  formatUpdateNotice,
  maybeNotifyUpdate,
  readUpdateCheckCache,
  runUpdateCheck,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateCheckCache,
} from "../src/core/update-notifier.js";
import { resetTestDir } from "./test-paths.js";

function makeSpawn() {
  const unref = jest.fn();
  const spawnImpl = jest.fn(() => ({ unref })) as unknown as typeof import("child_process").spawn;
  return { spawnImpl, unref };
}

function makeLogger() {
  return { error: jest.fn() };
}

describe("compareSemver", () => {
  it("orders plain versions", () => {
    expect(compareSemver("4.2.0", "4.1.9")).toBeGreaterThan(0);
    expect(compareSemver("4.1.9", "4.2.0")).toBeLessThan(0);
    expect(compareSemver("4.2.0", "4.2.0")).toBe(0);
  });

  it("ignores prerelease suffixes", () => {
    expect(compareSemver("4.2.0-rc.1", "4.2.0")).toBe(0);
  });
});

describe("fetchLatestStableVersion", () => {
  it("returns the version from the npm registry", async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ version: "4.2.0" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    await expect(fetchLatestStableVersion(fetchImpl)).resolves.toBe("4.2.0");
  });

  it("returns null on HTTP errors", async () => {
    const fetchImpl = jest.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(fetchLatestStableVersion(fetchImpl)).resolves.toBeNull();
  });

  it("returns null on network failures", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchLatestStableVersion(fetchImpl)).resolves.toBeNull();
  });
});

describe("readUpdateCheckCache", () => {
  const dir = resetTestDir("update-notifier-read");
  const cacheFile = path.join(dir, "update-check.json");

  it("returns null when the file is missing", () => {
    expect(readUpdateCheckCache(path.join(dir, "nope.json"))).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    writeFileSync(cacheFile, "{ not json", "utf-8");
    expect(readUpdateCheckCache(cacheFile)).toBeNull();
  });

  it("returns null on the wrong shape", () => {
    writeFileSync(cacheFile, JSON.stringify({ lastCheck: "soon" }), "utf-8");
    expect(readUpdateCheckCache(cacheFile)).toBeNull();
  });

  it("parses a valid cache", () => {
    const cache: UpdateCheckCache = { lastCheck: 123, latestVersion: "4.2.0" };
    writeFileSync(cacheFile, JSON.stringify(cache), "utf-8");
    expect(readUpdateCheckCache(cacheFile)).toEqual(cache);
  });
});

describe("maybeNotifyUpdate", () => {
  const dir = resetTestDir("update-notifier");
  const cacheFile = path.join(dir, "update-check.json");

  function writeCache(cache: UpdateCheckCache): void {
    writeFileSync(cacheFile, JSON.stringify(cache), "utf-8");
  }

  it("prints a notice when the cache knows of a newer version", () => {
    const logger = makeLogger();
    const { spawnImpl } = makeSpawn();
    writeCache({ lastCheck: 1_000_000, latestVersion: "9.9.9" });

    maybeNotifyUpdate({ env: {}, now: 1_001_000, version: "4.1.0", cacheFile, logger, spawnImpl });

    expect(logger.error).toHaveBeenCalledWith(formatUpdateNotice("9.9.9", "4.1.0"));
  });

  it("stays silent when the cached version is not newer", () => {
    const logger = makeLogger();
    writeCache({ lastCheck: 1_000_000, latestVersion: "4.1.0" });

    maybeNotifyUpdate({ env: {}, now: 1_001_000, version: "4.1.0", cacheFile, logger });

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does nothing for non-release (dev) versions", () => {
    const logger = makeLogger();
    const { spawnImpl } = makeSpawn();
    writeCache({ lastCheck: 0, latestVersion: "9.9.9" });

    maybeNotifyUpdate({ env: {}, version: "dev", cacheFile, logger, spawnImpl });

    expect(logger.error).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does nothing when DECX_NO_UPDATE_CHECK is set", () => {
    const logger = makeLogger();
    const { spawnImpl } = makeSpawn();
    writeCache({ lastCheck: 0, latestVersion: "9.9.9" });

    maybeNotifyUpdate({ env: { DECX_NO_UPDATE_CHECK: "1" }, version: "4.1.0", cacheFile, logger, spawnImpl });

    expect(logger.error).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does nothing inside the background child itself", () => {
    const logger = makeLogger();
    const { spawnImpl } = makeSpawn();
    writeCache({ lastCheck: 0, latestVersion: "9.9.9" });

    maybeNotifyUpdate({ env: { DECX_UPDATE_CHECK_CHILD: "1" }, version: "4.1.0", cacheFile, logger, spawnImpl });

    expect(logger.error).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does not refresh while the cache is fresh", () => {
    const { spawnImpl } = makeSpawn();
    writeCache({ lastCheck: 1_000_000, latestVersion: "4.1.0" });

    maybeNotifyUpdate({
      env: {},
      now: 1_000_000 + UPDATE_CHECK_INTERVAL_MS - 1,
      version: "4.1.0",
      cacheFile,
      spawnImpl,
    });

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("spawns a detached refresh when the cache is stale", () => {
    const { spawnImpl, unref } = makeSpawn();
    writeCache({ lastCheck: 1_000_000, latestVersion: "4.1.0" });

    maybeNotifyUpdate({
      env: {},
      now: 1_000_000 + UPDATE_CHECK_INTERVAL_MS + 1,
      version: "4.1.0",
      cacheFile,
      entryFile: "/cli/dist/index.js",
      spawnImpl,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [execPath, args, opts] = (spawnImpl as jest.Mock).mock.calls[0] as unknown as [string, string[], { detached: boolean; stdio: string; env: NodeJS.ProcessEnv }];
    expect(execPath).toBe(process.execPath);
    expect(args).toEqual(["/cli/dist/index.js", "__update-check"]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(opts.env.DECX_UPDATE_CHECK_CHILD).toBe("1");
    expect(unref).toHaveBeenCalled();
  });

  it("spawns a refresh when no cache exists yet", () => {
    const { spawnImpl } = makeSpawn();
    const missingCache = path.join(dir, "missing.json");

    maybeNotifyUpdate({ env: {}, version: "4.1.0", cacheFile: missingCache, entryFile: "/cli/dist/index.js", spawnImpl });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("swallows spawn failures instead of breaking the command", () => {
    const throwingSpawn = jest.fn(() => {
      throw new Error("spawn EACCES");
    }) as unknown as typeof import("child_process").spawn;

    expect(() => maybeNotifyUpdate({ env: {}, version: "4.1.0", cacheFile: path.join(dir, "missing2.json"), spawnImpl: throwingSpawn })).not.toThrow();
  });
});

describe("runUpdateCheck", () => {
  it("writes the cache after a successful lookup", async () => {
    const dir = resetTestDir("update-notifier-run");
    const cacheFile = path.join(dir, "update-check.json");
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ version: "4.2.0" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    await runUpdateCheck({ fetchImpl, cacheFile });

    const cache = readUpdateCheckCache(cacheFile);
    expect(cache).not.toBeNull();
    expect(cache!.latestVersion).toBe("4.2.0");
    expect(Date.now() - cache!.lastCheck).toBeLessThan(60_000);
  });

  it("leaves no cache behind when the lookup fails", async () => {
    const dir = resetTestDir("update-notifier-run-fail");
    const cacheFile = path.join(dir, "update-check.json");
    const fetchImpl = jest.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await runUpdateCheck({ fetchImpl, cacheFile });

    expect(existsSync(cacheFile)).toBe(false);
  });
});

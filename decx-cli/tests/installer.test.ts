import { jest } from "@jest/globals";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { deflateRawSync } from "node:zlib";
import {
  checkForServerUpdate,
  findDecxServerJar,
  installDecxServer,
  readJarVersionProperty,
  selectDecxServerAsset,
  type ReleaseAsset,
} from "../src/core/installer.js";
import { DECX_TEST_SERVER_JAR, resetTestDir } from "./test-paths.js";

/**
 * Minimal stored/deflated zip writer so jar-version tests need no zip
 * dependency: local header + central directory + EOCD.
 */
function buildTestZip(entries: Record<string, string>, deflate = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const data = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const crc = 0; // unused by the reader

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 4); // flags
    local.writeUInt16LE(method, 6);
    local.writeUInt16LE(0, 8); // time
    local.writeUInt16LE(0, 10); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from decx</title>
  <entry><title>v4.2.0-rc.1</title></entry>
  <entry><title>v4.1.0</title></entry>
</feed>`;

const ATOM_FEED_STABLE_ONLY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from decx</title>
  <entry><title>v4.1.0</title></entry>
</feed>`;

describe("checkForServerUpdate", () => {
  it("reports a newer available version from the npm registry", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ version: "4.2.0" })) as typeof fetch;

    await expect(checkForServerUpdate("4.0.2", false, { fetchImpl })).resolves.toEqual({
      available: true,
      latestVersion: "4.2.0",
    });
  });

  it("reports the npm failure instead of claiming the server is up to date", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse("rate limit", 403)) as typeof fetch;

    await expect(checkForServerUpdate("4.0.2", false, { fetchImpl })).resolves.toEqual({
      available: false,
      latestVersion: "4.0.2",
      error: "Failed to fetch latest version from the npm registry (HTTP 403)",
    });
  });

  it("reports network failures instead of throwing", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await expect(checkForServerUpdate("4.0.2", false, { fetchImpl })).resolves.toEqual({
      available: false,
      latestVersion: "4.0.2",
      error: "Failed to reach npm registry: fetch failed",
    });
  });

  it("reports no update when versions match", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ version: "4.1.0" })) as typeof fetch;

    await expect(checkForServerUpdate("4.1.0", false, { fetchImpl })).resolves.toEqual({
      available: false,
      latestVersion: "4.1.0",
    });
  });

  it("finds the newest prerelease from the releases atom feed", async () => {
    const fetchImpl = jest.fn(async () => new Response(ATOM_FEED, {
      status: 200,
      headers: { "content-type": "application/atom+xml" },
    })) as typeof fetch;

    await expect(checkForServerUpdate("4.1.0", true, { fetchImpl })).resolves.toEqual({
      available: true,
      latestVersion: "4.2.0-rc.1",
    });
  });

  it("reports no prerelease when the feed has only stable releases", async () => {
    const fetchImpl = jest.fn(async () => new Response(ATOM_FEED_STABLE_ONLY, {
      status: 200,
      headers: { "content-type": "application/atom+xml" },
    })) as typeof fetch;

    await expect(checkForServerUpdate("4.1.0", true, { fetchImpl })).resolves.toEqual({
      available: false,
      latestVersion: "4.1.0",
      error: "No prerelease found",
    });
  });
});

describe("installer", () => {
  it("uses the test decx-server jar installed from the DECX dist output", () => {
    expect(findDecxServerJar()).toBe(DECX_TEST_SERVER_JAR);
  });

  it("selects the jar asset instead of similarly named non-jar assets", () => {
    const assets: ReleaseAsset[] = [
      { name: "decx-server.sha256", browser_download_url: "https://example.invalid/sha" },
      { name: "decx-server-0.0.0.jar", browser_download_url: "https://example.invalid/jar" },
    ];

    expect(selectDecxServerAsset(assets)).toEqual(assets[1]);
  });

  it("skips the download when the installed version matches the latest release", async () => {
    const installDir = resetTestDir("install", "installer-skip");
    const installPath = path.join(installDir, "decx-server.jar");
    const logger = { error: jest.fn() };

    writeFileSync(installPath, "existing-jar", "utf-8");

    const fetchImpl = jest.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("registry.npmjs.org")) {
        return jsonResponse({ version: "2.6.0" });
      }
      throw new Error("download should not be attempted");
    }) as typeof fetch;

    try {
      const result = await installDecxServer(false, {
        installDir,
        installPath,
        fetchImpl,
        logger,
        currentVersion: "2.6.0",
      });

      expect(result).toEqual({
        ok: true,
        version: "2.6.0",
        path: installPath,
        message: "decx-server is already up to date (v2.6.0)",
      });
      expect(readFileSync(installPath, "utf-8")).toBe("existing-jar");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  it("reads the version baked into a jar's version.properties (stored and deflated)", () => {
    const dir = resetTestDir("install", "jar-version");
    try {
      const stored = path.join(dir, "stored.jar");
      writeFileSync(stored, buildTestZip({ "version.properties": "version=4.2.0\n" }));
      expect(readJarVersionProperty(stored)).toBe("4.2.0");

      const deflated = path.join(dir, "deflated.jar");
      writeFileSync(
        deflated,
        buildTestZip(
          {
            "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
            "version.properties": "version=4.2.0-rc.1\n",
          },
          true,
        ),
      );
      expect(readJarVersionProperty(deflated)).toBe("4.2.0-rc.1");

      expect(readJarVersionProperty(path.join(dir, "missing.jar"))).toBeNull();

      const garbage = path.join(dir, "garbage.jar");
      writeFileSync(garbage, "not a zip", "utf-8");
      expect(readJarVersionProperty(garbage)).toBeNull();

      const noVersion = path.join(dir, "noversion.jar");
      writeFileSync(noVersion, buildTestZip({ "other.txt": "hi" }));
      expect(readJarVersionProperty(noVersion)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the download when the jar's own version matches, even without a config record", async () => {
    const installDir = resetTestDir("install", "installer-jar-skip");
    const installPath = path.join(installDir, "decx-server.jar");
    const logger = { error: jest.fn() };

    // No currentVersion: the decision must come from the jar itself.
    writeFileSync(installPath, buildTestZip({ "version.properties": "version=2.6.0\n" }));

    const fetchImpl = jest.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("registry.npmjs.org")) {
        return jsonResponse({ version: "2.6.0" });
      }
      throw new Error("download should not be attempted");
    }) as typeof fetch;

    try {
      const result = await installDecxServer(false, { installDir, installPath, fetchImpl, logger });

      expect(result).toEqual({
        ok: true,
        version: "2.6.0",
        path: installPath,
        message: "decx-server is already up to date (v2.6.0)",
      });
      expect(readJarVersionProperty(installPath)).toBe("2.6.0");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  it("re-downloads when the jar is older than a stale config record claims", async () => {
    const installDir = resetTestDir("install", "installer-jar-stale");
    const installPath = path.join(installDir, "decx-server.jar");
    const logger = { error: jest.fn() };

    // Config record claims 2.6.0, but the jar on disk is actually 2.5.0 —
    // the jar is ground truth and must be replaced.
    writeFileSync(installPath, buildTestZip({ "version.properties": "version=2.5.0\n" }));

    const fetchImpl = jest.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("registry.npmjs.org")) {
        return jsonResponse({ version: "2.6.0" });
      }
      return new Response("jar-bytes", {
        status: 200,
        headers: { "content-length": "9" },
      });
    }) as typeof fetch;

    const downloadWithProgressImpl = jest.fn(async (_body, filePath: string) => {
      writeFileSync(filePath, "new-jar", "utf-8");
      return 7;
    });

    try {
      const result = await installDecxServer(false, {
        installDir,
        installPath,
        fetchImpl,
        downloadWithProgressImpl,
        logger,
        currentVersion: "2.6.0",
      });

      expect(result).toMatchObject({ ok: true, version: "2.6.0" });
      expect(readFileSync(installPath, "utf-8")).toBe("new-jar");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  it("overwrites an existing installed jar and returns normalized version/path metadata", async () => {
    const installDir = resetTestDir("install", "installer");
    const installPath = path.join(installDir, "decx-server.jar");
    const logger = { error: jest.fn() };

    writeFileSync(installPath, "old-jar", "utf-8");

    const fetchImpl = jest.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("registry.npmjs.org")) {
        return jsonResponse({ version: "2.6.0" });
      }
      return new Response("jar-bytes", {
        status: 200,
        headers: { "content-length": "9" },
      });
    }) as typeof fetch;

    const downloadWithProgressImpl = jest.fn(async (_body, filePath: string) => {
      writeFileSync(filePath, "new-jar", "utf-8");
      return 7;
    });

    try {
      const result = await installDecxServer(false, {
        installDir,
        installPath,
        fetchImpl,
        downloadWithProgressImpl,
        logger,
      });

      expect(result).toEqual({
        ok: true,
        version: "2.6.0",
        path: installPath,
        message: `Installed decx-server v2.6.0 to ${installPath}`,
      });
      expect(readFileSync(installPath, "utf-8")).toBe("new-jar");
      expect(existsSync(`${installPath}.bak`)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect((fetchImpl as unknown as jest.Mock).mock.calls[1][0]).toBe(
        "https://github.com/jygzyc/decx/releases/download/v2.6.0/decx-server-2.6.0.jar",
      );
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });
});

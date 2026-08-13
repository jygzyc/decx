import { jest } from "@jest/globals";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import {
  checkForServerUpdate,
  findDecxServerJar,
  installDecxServer,
  selectDecxServerAsset,
  type ReleaseAsset,
} from "../src/core/installer.js";
import { DECX_TEST_SERVER_JAR, resetTestDir } from "./test-paths.js";

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

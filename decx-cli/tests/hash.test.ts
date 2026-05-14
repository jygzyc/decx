/**
 * Tests for async file hashing utility.
 */

import { hashFile } from "../src/utils/hash.js";
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { testPath } from "./test-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const SIEVE_APK = path.join(FIXTURES_DIR, "sieve.apk");
const TMP_DIR = testPath("tmp", "hash");

describe("hashFile", () => {
  beforeAll(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("should exist in fixtures", () => {
    expect(existsSync(SIEVE_APK)).toBe(true);
  });

  it("returns first 16 hex chars of SHA-256", async () => {
    const hash = await hashFile(SIEVE_APK);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces deterministic results for sieve.apk", async () => {
    const hash1 = await hashFile(SIEVE_APK);
    const hash2 = await hashFile(SIEVE_APK);
    expect(hash1).toBe(hash2);
  });

  /**
   * Expected hash: 85fe7a89866728e3
   * Computed from sieve.apk (com.mwr.example.sieve, 7,512,398 bytes)
   * If you regenerate the fixture, update this value.
   */
  it("matches known hash for sieve.apk", async () => {
    const hash = await hashFile(SIEVE_APK);
    expect(hash).toBe("85fe7a89866728e3");
  });

  it("hashes a small test file correctly", async () => {
    const testFile = path.join(TMP_DIR, "small.txt");
    writeFileSync(testFile, "hello world\n");

    const hash = await hashFile(testFile);
    // SHA-256 of "hello world\n" = a948904f2f0f479b8f8197694b30184b...
    // first 16 hex = a948904f2f0f479b
    expect(hash).toBe("a948904f2f0f479b");

    unlinkSync(testFile);
  });

  it("produces different hashes for different files", async () => {
    const f1 = path.join(TMP_DIR, "a.txt");
    const f2 = path.join(TMP_DIR, "b.txt");
    writeFileSync(f1, "content A");
    writeFileSync(f2, "content B");

    const h1 = await hashFile(f1);
    const h2 = await hashFile(f2);
    expect(h1).not.toBe(h2);

    unlinkSync(f1);
    unlinkSync(f2);
  });
});

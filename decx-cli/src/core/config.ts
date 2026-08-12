/**
 * Configuration management for DECX CLI.
 */

import { existsSync, readFileSync } from "fs";
import * as path from "path";
import type { Config } from "./types.js";
import * as session from "./session.js";
import { decxHome, decxPath, userHome } from "./paths.js";
import { atomicWriteJson } from "../utils/fs.js";

const HOME = userHome();
const CONFIG_DIR = decxHome();
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") return path.join(HOME, p.slice(1));
  return p;
}

function defaultConfig(): Config {
  return {
    serverJar: { path: null, version: "1.0.0", installDir: decxPath("bin") },
    server: { defaultPort: 25419, timeout: 30 },
    output: { defaultDir: decxPath("output"), decompileDir: decxPath("decompiled") },
  };
}

function readConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return defaultConfig();
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    return { ...defaultConfig(), ...data };
  } catch {
    return defaultConfig();
  }
}

function writeConfig(config: Config): void {
  atomicWriteJson(CONFIG_FILE, config);
}

export class Manager {
  private static _instance: Manager | null = null;
  private config: Config;

  private constructor() {
    this.config = readConfig();
  }

  static get(): Manager {
    if (!Manager._instance) Manager._instance = new Manager();
    return Manager._instance;
  }

  static reset(): void {
    Manager._instance = null;
  }

  get serverJar() { return this.config.serverJar; }
  get server() { return this.config.server; }
  get output() { return this.config.output; }

  // --- Session delegates ---

  async createSession(name: string, hash: string, apkPath: string, pid: number, port: number, scripts?: string[]) {
    return session.createSession(name, hash, apkPath, pid, port, scripts);
  }

  getSession(name: string) { return session.readSession(name); }

  removeSession(name: string) { session.deleteSession(name); }

  autoSelectSession() { return session.autoSelectSession(); }

  listSessions() { return session.listAllSessions(); }

  listAliveSessions() {
    return session.listAllSessions().filter(s => session.isSessionAlive(s));
  }

  cleanupDead() { return session.cleanupDead(); }

  updateServerVersion(version: string): void {
    this.config.serverJar.version = version;
    writeConfig(this.config);
  }
}

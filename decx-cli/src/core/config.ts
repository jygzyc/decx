/**
 * Configuration management for DECX CLI.
 */

import { existsSync, readFileSync } from "fs";
import * as path from "path";
import type { Config } from "./types.js";
import * as session from "./session.js";
import { decxHome } from "./paths.js";
import { atomicWriteJson } from "../utils/fs.js";

const CONFIG_FILE = path.join(decxHome(), "config.json");

function defaultConfig(): Config {
  return {
    serverJar: { version: "1.0.0" },
    server: { defaultPort: 25419 },
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

  // --- Session delegates ---

  createSession(name: string, hash: string, apkPath: string, pid: number, port: number, scripts?: string[]) {
    return session.createSession(name, hash, apkPath, pid, port, scripts);
  }

  getSession(name: string) { return session.readSession(name); }

  removeSession(name: string) { session.deleteSession(name); }

  autoSelectSession() { return session.autoSelectSession(); }

  listAliveSessions() {
    return session.listAllSessions().filter(s => session.isSessionAlive(s));
  }

  cleanupDead() { return session.cleanupDead(); }

  updateServerVersion(version: string): void {
    this.config.serverJar.version = version;
    writeConfig(this.config);
  }
}

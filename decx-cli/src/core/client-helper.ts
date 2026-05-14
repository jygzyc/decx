/**
 * Shared client resolution helper for commands.
 */

import type { Command } from "commander";
import { DecxClient } from "./client.js";
import { Formatter } from "../utils/formatter.js";
import { Manager } from "./config.js";

export function resolveClient(
  opts: Record<string, unknown>
): { fmt: Formatter; client: DecxClient } {
  const fmt = new Formatter();
  const mgr = Manager.get();

  if (opts.session && opts.port) {
    fmt.error("Cannot specify both --session and --port");
    process.exit(1);
  }

  let port: number;
  let sessionName: string | undefined;
  if (opts.port) {
    port = parseInt(opts.port as string);
  } else if (opts.session) {
    const s = mgr.getSession(opts.session as string);
    if (!s) {
      fmt.error(`Session not found: ${opts.session}`);
      process.exit(1);
    }
    port = s.port;
    sessionName = s.name;
  } else {
    // Auto-select: if exactly one alive session, use it; otherwise default port
    const auto = mgr.autoSelectSession();
    if (auto) {
      port = auto.port;
      sessionName = auto.name;
    } else {
      port = mgr.server.defaultPort;
    }
  }

  const client = new DecxClient("127.0.0.1", port, 30, undefined, sessionName);

  // Sync server version in background (non-blocking)
  client.healthCheck().then((health) => {
    const serverVersion = (health as Record<string, string>)?.version;
    if (serverVersion && serverVersion !== mgr.serverJar.version) {
      mgr.updateServerVersion(serverVersion);
    }
  }).catch(() => {});

  return { fmt, client };
}

export function resolveCommandClient(
  opts: Record<string, unknown>,
  command: Command,
): { fmt: Formatter; client: DecxClient } {
  return resolveClient({ ...command.optsWithGlobals(), ...opts });
}

import { Command } from "commander";
import { DecxClient } from "../core/client.js";
import { Formatter } from "../utils/formatter.js";
import { Manager } from "../core/config.js";
import { DecxError, ProcessError, handleCliError } from "../utils/errors.js";
import { findDecxServerJar } from "../core/installer.js";
import { parseServerPort } from "../core/ports.js";
import {
  openAnalysisTarget,
  checkServer,
  isServerPortAvailable,
  killProcessGroup,
  extractPassthroughArgs,
} from "../core/launcher.js";
import { logCliEvent } from "../utils/logger.js";

export function makeProcessCommand(): Command {
  const cmd = new Command("process");
  cmd.description("Start, inspect, list, and stop DECX analysis server sessions");

  // check
  cmd
    .command("check")
    .summary("Check installed server jar, port availability, and server health")
    .description("Check whether decx-server.jar is installed, whether a DECX server responds on the selected port, and whether that port is available.")
    .option("-P, --port <port>", "DECX HTTP server port to check", String)
    .action(async (opts) => {
      const fmt = new Formatter();
      try {
        const mgr = Manager.get();
        const port = parseServerPort(opts.port ?? mgr.server.defaultPort);

        // Check decx-server.jar
        const jarPath = findDecxServerJar();
        const jarOk = jarPath !== null;
        const jarInfo = jarOk ? jarPath! : "Not found. Use 'decx self install' to install.";

        // Check running server
        const [serverOk, serverInfo] = await checkServer(port);

        // Check port availability
        const portAvailable = await isServerPortAvailable(port);

        const results = {
          server: { ok: serverOk, info: serverInfo },
          jar: { ok: jarOk, info: jarInfo },
          port: { ok: portAvailable, info: portAvailable ? `Port ${port} is available` : `Port ${port} is already in use` },
        };

        logCliEvent({ command: "process", action: "check", serverPort: port, ...results });
        fmt.output(results);
      } catch (err) { handleCliError(err, fmt); }
    });

  // open
  cmd
    .command("open <file>")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .summary("Start a DECX server session for an APK, DEX, JAR, AAR, or framework jar")
    .description("Start decx-server.jar for a target file and record a reusable session. Unknown options after this command are forwarded to jadx-cli.")
    .option("-P, --port <port>", "DECX HTTP server port to bind")
    .option("--mcp", "Also start MCP Streamable HTTP server on port + 1")
    .option("--force", "Start a new server even when a matching file/session already exists")
    .option("-n, --name <name>", "Session name used by -s/--session (default: input filename without extension)")
    .option("--tai-e", "Enable Tai-e static analysis engine (call graph + pointer analysis + evidence collection)")
    .option("--tai-e-rules <dir>", "Directory with investigation rule YAML files (default: ~/.decx/rules/)")
    .option("--tai-e-android-jars <dir>", "Path to Android platform jars directory for Tai-e Android mode")
    .action(async (filePath: string, opts) => {
      const fmt = new Formatter();
      try {
      fmt.output(await openAnalysisTarget(filePath, {
        port: opts.port,
        force: opts.force ?? false,
        name: opts.name,
        mcp: opts.mcp ?? false,
        passthroughArgs: extractPassthroughArgs(),
      }));
      } catch (err) { handleCliError(err, fmt); }
    });

  // close
  cmd
    .command("close [name]")
    .summary("Stop one or more recorded DECX server sessions")
    .description("Stop a DECX server by session name, by --port, the only running session, or every running session with --all.")
    .option("-a, --all", "Stop all recorded running DECX sessions")
    .option("-P, --port <port>", "Stop the session bound to this DECX HTTP server port")
    .action(async (name: string | undefined, opts) => {
      const fmt = new Formatter();
      try {
      const mgr = Manager.get();

      // Cleanup stale sessions on every close invocation
      const cleaned = mgr.cleanupDead();

      if (opts.all) {
        if (name || opts.port) {
          throw new ProcessError("Cannot combine --all with session name or --port");
        }
        const sessions = mgr.listAliveSessions();
        const killed: string[] = [], dead: string[] = [];
        for (const s of sessions) {
          const alive = await killProcessGroup(s.pid);
          mgr.removeSession(s.name);
          (alive ? killed : dead).push(s.name);
        }
        logCliEvent({ command: "process", action: "close", mode: "all", killed, dead });
        fmt.output({ cleaned, killed, dead });
        return;
      }

      if (name && opts.port) {
        throw new ProcessError("Cannot specify both session name and --port");
      }

      if (!name) {
        if (opts.port) {
          const port = parseServerPort(opts.port);
          const session = mgr.listAliveSessions().find((s) => s.port === port);
          if (!session) {
            throw new ProcessError(`Session not found on port: ${port}`);
          }
          name = session.name;
        } else {
          const alive = mgr.listAliveSessions();
          if (alive.length === 1) {
            name = alive[0].name;
          } else {
            throw new ProcessError(
              alive.length === 0
                ? "No running sessions"
                : "Specify session name, --port, or use --all"
            );
          }
        }
      }

      const session = mgr.getSession(name);
      if (!session) {
        throw new ProcessError(`Session not found: ${name}`);
      }

      const alive = await killProcessGroup(session.pid);
      mgr.removeSession(name);
      logCliEvent({ command: "process", action: "close", session: name, alive });
      fmt.output({ cleaned, killed: alive ? [name] : [], dead: alive ? [] : [name] });
      } catch (err) { handleCliError(err, fmt); }
    });

  // list
  cmd
    .command("list")
    .summary("List recorded DECX sessions that are still alive")
    .description("List active DECX process sessions, cleaning up stale session records before printing.")
    .action(() => {
      const fmt = new Formatter();
      const mgr = Manager.get();

      // Cleanup stale sessions
      const cleaned = mgr.cleanupDead();
      const sessions = mgr.listAliveSessions();

      logCliEvent({ command: "process", action: "list", sessionCount: sessions.length, cleaned });
      fmt.output({ cleaned, sessions });
    });

  // status
  cmd
    .command("status [name]")
    .summary("Check health for one session or server port")
    .description("Call the DECX /health endpoint for a named session, a specific --port, or the configured default port.")
    .option("-P, --port <port>", "DECX HTTP server port to query", String)
    .action(async (name: string | undefined, opts) => {
      const fmt = new Formatter();
      try {
      const mgr = Manager.get();
      let port: number;

      if (name) {
        const session = mgr.getSession(name);
        if (!session) throw new ProcessError(`Session not found: ${name}`);
        port = session.port;
      } else if (opts.port) {
        port = parseServerPort(opts.port);
      } else {
        port = parseServerPort(mgr.server.defaultPort);
      }

      const client = new DecxClient("127.0.0.1", port);
      try {
        const health = await client.healthCheck();
        logCliEvent({ command: "process", action: "status", session: name, port, ok: true });
        fmt.output({ ok: true, port, health });
      } catch (err) {
        throw new DecxError(String(err), "SERVER_ERROR", { port });
      }
      } catch (err) { handleCliError(err, fmt); }
    });

  return cmd;
}

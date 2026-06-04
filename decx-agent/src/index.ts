#!/usr/bin/env node
import { Command } from "commander";
import { loadTaskConfigInput } from "./core/task-config.js";
import { VERSION } from "./core/version.js";
import { knownWorkers, WORKERS } from "./workers/registry.js";

type Options = Record<string, unknown> & {
  db?: string;
  session?: string;
  worker?: string;
  maxSteps?: string;
  host?: string;
  port?: string;
  dispatch?: boolean;
};

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
  if (process.env.DECX_AGENT_ACTIVE === "1") {
    throw new Error("Refusing recursive decx-agent invocation.");
  }
  await program().parseAsync(["node", "decx-agent", ...argv]);
}

function program(): Command {
  const command = new Command();
  command
    .name("decx-agent")
    .version(VERSION)
    .description("Generic DECX agent framework")
    .showHelpAfterError();

  command
    .command("run")
    .description("Run a configured agent task.")
    .argument("<config>", "task.json path or session directory containing task.json")
    .option("--db <path>", "SQLite state database", defaultDbPath())
    .option("--session <name>", "session name override")
    .option("--worker <name>", "default worker backend: noop, codex, claude-code, opencode, api")
    .option("--max-steps <n>", "maximum dispatcher steps")
    .action(async (configPath: string, options: Options) => {
      printJson(await (await server(options)).start({
        configPath,
        session: options.session,
        worker: options.worker,
      }, { maxSteps: parseMaxSteps(options.maxSteps) }));
    });

  command
    .command("resume")
    .description("Resume an existing project or session.")
    .argument("<session-or-project>", "project id or session name")
    .option("--db <path>", "SQLite state database", defaultDbPath())
    .option("--max-steps <n>", "maximum dispatcher steps")
    .action(async (id: string, options: Options) => {
      printJson(await (await server(options)).resume(id, { maxSteps: parseMaxSteps(options.maxSteps) }));
    });

  command
    .command("status")
    .description("Print an existing project or session.")
    .argument("<session-or-project>", "project id or session name")
    .option("--db <path>", "SQLite state database", defaultDbPath())
    .action(async (id: string, options: Options) => {
      printJson((await server(options)).status(id));
    });

  command
    .command("workers")
    .description("List available worker backends.")
    .argument("[config]", "optional task.json path or session directory containing task.json")
    .action((configPath: string | undefined) => {
      const configured = configPath ? loadTaskConfigInput(configPath).config.workers : undefined;
      printJson({ workers: configPath ? knownWorkers(configured) : WORKERS });
    });

  command
    .command("serve")
    .description("Start the DECX agent API and audit UI.")
    .option("--db <path>", "SQLite state database", defaultDbPath())
    .option("--host <host>", "bind host", "127.0.0.1")
    .option("--port <port>", "bind port", "25429")
    .option("--no-dispatch", "disable dispatcher loop")
    .action(async (options: Options) => {
      await (await server(options)).serve({
        host: options.host ?? "127.0.0.1",
        port: parsePort(options.port),
        dispatch: options.dispatch !== false,
      });
    });

  return command;
}

async function server(options: Options) {
  const { DecxAgentServer } = await import("./server/agent-server.js");
  return new DecxAgentServer(options.db);
}

function defaultDbPath(): string {
  return ".decx/agent_tasks/agent.sqlite";
}

function parseMaxSteps(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "25429", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25429;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

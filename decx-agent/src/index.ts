#!/usr/bin/env node
import { Command } from "commander";
import { loadTaskConfigInput } from "./core/task-config.js";
import { VERSION } from "./core/version.js";
import { knownWorkers, workerCapabilities } from "./workers/registry.js";
import {
  defaultProvidersPath,
  findProvider,
  initProvidersFile,
  listKnownProviders,
  loadProvidersFile,
} from "./core/providers-config.js";

type Options = Record<string, unknown> & {
  db?: string;
  session?: string;
  worker?: string;
  maxSteps?: string;
  host?: string;
  port?: string;
  dispatch?: boolean;
  path?: string;
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
    .description("Generic configured agent framework")
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
      printJson(await (await runtime(options)).start({
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
      printJson(await (await runtime(options)).resume(id, { maxSteps: parseMaxSteps(options.maxSteps) }));
    });

  command
    .command("status")
    .description("Print an existing project or session.")
    .argument("<session-or-project>", "project id or session name")
    .option("--db <path>", "SQLite state database", defaultDbPath())
    .action(async (id: string, options: Options) => {
      printJson((await runtime(options)).status(id));
    });

  command
    .command("workers")
    .description("List available worker backends.")
    .argument("[config]", "optional task.json path or session directory containing task.json")
    .action((configPath: string | undefined) => {
      const configured = configPath ? loadTaskConfigInput(configPath).config.workers : undefined;
      printJson({ ...workerCapabilities(), workers: knownWorkers(configured) });
    });

  const providers = command
    .command("providers")
    .description("Manage model provider configurations (~/.decx/agent/providers.json).");

  providers
    .command("init")
    .description("Create ~/.decx/agent/providers.json seeded with built-in presets if it does not exist.")
    .option("--path <file>", "custom providers file path")
    .action((options: Options) => {
      const result = initProvidersFile(options.path);
      console.log(result.created ? `Created ${result.path} with built-in presets.` : `${result.path} already exists.`);
    });

  providers
    .command("list")
    .description("List all known providers (user-defined + presets).")
    .option("--path <file>", "custom providers file path")
    .action((options: Options) => {
      const entries = listKnownProviders(loadProvidersFile(options.path));
      const rows = entries.map((e) => ({
        id: e.id,
        name: e.name,
        source: e.source,
        baseURL: e.baseURL,
        apiKeyEnv: e.apiKeyEnv,
        model: e.model,
        apiKeySet: Boolean(process.env[e.apiKeyEnv]),
      }));
      printJson(rows);
    });

  providers
    .command("show <id>")
    .description("Show a single provider configuration.")
    .option("--path <file>", "custom providers file path")
    .action((id: string, options: Options) => {
      const match = findProvider(id, loadProvidersFile(options.path));
      if (!match) {
        console.error(`Unknown provider: ${id}`);
        process.exitCode = 1;
        return;
      }
      printJson({ id, source: match.source, ...match.config, apiKeySet: Boolean(process.env[match.config.apiKeyEnv]) });
    });

  providers
    .command("path")
    .description("Print the providers file path in use.")
    .action(() => {
      console.log(defaultProvidersPath());
    });

  command
    .command("serve")
    .description("Start the agent API and audit UI.")
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

async function runtime(options: Options) {
  const { AgentRuntime } = await import("./agent-runtime.js");
  return new AgentRuntime(options.db);
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

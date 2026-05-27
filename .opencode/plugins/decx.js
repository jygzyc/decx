import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const agentRoot = path.join(repoRoot, "decx-agent");

function fallbackTool(definition) {
  return definition;
}

fallbackTool.schema = {
  string: () => ({ optional() { return this; } }),
  number: () => ({ optional() { return this; } }),
  boolean: () => ({ optional() { return this; } }),
};

async function loadTool() {
  try {
    return (await import("@opencode-ai/plugin")).tool;
  } catch {
    return fallbackTool;
  }
}

function stripJsonComments(input) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function loadConfig() {
  const configPath = path.join(repoRoot, ".opencode", "decx.jsonc");
  if (!fs.existsSync(configPath)) {
    return { defaultWorker: "noop", maxSteps: 8 };
  }
  const parsed = JSON.parse(stripJsonComments(fs.readFileSync(configPath, "utf8")));
  return {
    defaultWorker: parsed.decx?.defaultWorker ?? parsed.defaultWorker ?? "noop",
    maxSteps: parsed.decx?.maxSteps ?? parsed.maxSteps ?? 8,
  };
}

async function runDecxAgent(args) {
  const { stdout } = await execFileAsync("uv", ["run", "decx-agent", "--project-root", repoRoot, "--json", ...args], {
    cwd: agentRoot,
    maxBuffer: 1024 * 1024 * 10,
  });
  return stdout;
}

export const DecxPlugin = async () => {
  const tool = await loadTool();

  return {
    tool: {
      decx_run: tool({
        description: "Run a configured DECX fact/intent agent task.",
        args: {
          target: tool.schema.string(),
          mode: tool.schema.string().optional(),
          port: tool.schema.number().optional(),
          worker: tool.schema.string().optional(),
          dryRun: tool.schema.boolean().optional(),
          maxSteps: tool.schema.number().optional(),
        },
        async execute(args) {
          const config = loadConfig();
          const command = ["--worker", args.worker ?? config.defaultWorker, "run", args.target];
          if (args.mode) command.push("--mode", args.mode);
          if (args.port) command.push("--port", String(args.port));
          if (args.dryRun) command.push("--dry-run");
          command.push("--max-steps", String(args.maxSteps ?? config.maxSteps));
          return runDecxAgent(command);
        },
      }),

      decx_resume: tool({
        description: "Resume a DECX fact/intent exploration project.",
        args: {
          runPath: tool.schema.string(),
          worker: tool.schema.string().optional(),
          dryRun: tool.schema.boolean().optional(),
          maxSteps: tool.schema.number().optional(),
        },
        async execute(args) {
          const config = loadConfig();
          const command = ["--worker", args.worker ?? config.defaultWorker, "resume", args.runPath];
          if (args.dryRun) command.push("--dry-run");
          command.push("--max-steps", String(args.maxSteps ?? config.maxSteps));
          return runDecxAgent(command);
        },
      }),

      decx_status: tool({
        description: "Read a DECX fact/intent run state.",
        args: {
          runPath: tool.schema.string(),
        },
        async execute(args) {
          return runDecxAgent(["status", args.runPath]);
        },
      }),

      decx_hint: tool({
        description: "Append a human hint to a DECX fact/intent board.",
        args: {
          runPath: tool.schema.string(),
          content: tool.schema.string(),
          creator: tool.schema.string().optional(),
        },
        async execute(args) {
          const command = ["hint", args.runPath, args.content];
          if (args.creator) command.push("--creator", args.creator);
          return runDecxAgent(command);
        },
      }),
    },
  };
};

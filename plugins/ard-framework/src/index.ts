/**
 * DECX framework plugin entry point.
 *
 * Exposes the in-process plugin contract documented in plugins/README.md:
 * `handle(request)` validates, dispatches on the full command path and always
 * returns the response envelope (stderr carries diagnostics). With
 * `node dist/src/index.js` the same entry point reads one JSON request from
 * stdin and writes the response to stdout for manual debugging; the embedded
 * engine calls `handle()` directly and never executes that path.
 */
import type {
  FrameworkLayout,
  PluginArgs,
  PluginRequest,
  PluginResponse,
} from "./types";

const { readFileSync } = require("fs");
const { RequestError, errorPayload } = require("./errors.js");
const { collectFramework } = require("./framework-collector.js");
const {
  cleanFrameworkOutputs,
  countFrameworkFiles,
  processFramework,
} = require("./framework-processor.js");
const { packFrameworkJar } = require("./framework-packer.js");
const {
  argFlag,
  argValue,
  frameworkDevice,
  readFrameworkArtifact,
  requiredDevice,
  resolveFrameworkLayout,
  summarizeArtifact,
} = require("./framework.js");

const PROTOCOL_VERSION = 1;

type CommandHandler = (
  request: PluginRequest,
  args: PluginArgs,
  positionals: string[],
) => unknown;

function log(message: string): void {
  process.stderr.write(`[framework] ${message}\n`);
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RequestError(`failed to read the request from stdin: ${message}`);
  }
}

function requireHome(request: PluginRequest): string {
  const home = request.context?.home;
  if (typeof home !== "string" || home === "") {
    throw new RequestError("request.context.home is required");
  }
  return home;
}

/** Layout for the commands that accept --oem/--source-dir/--out-dir. */
function layoutFor(
  request: PluginRequest,
  args: PluginArgs,
  adb: unknown,
  device: boolean,
): FrameworkLayout {
  return resolveFrameworkLayout({
    home: requireHome(request),
    oem: argValue(args, "oem"),
    sourceDir: argValue(args, "source-dir", "input"),
    outDir: argValue(args, "out-dir", "output"),
    device,
    serialRequested: argValue(args, "serial") !== undefined,
    adb,
  });
}

function cleanSourceRequested(args: PluginArgs): boolean {
  return argFlag(args, "clean-source") || argFlag(args, "clean");
}

// ── Commands ───────────────────────────────────────────────────────────────

function deviceSystemServices(args: PluginArgs): unknown {
  const adb = requiredDevice(args, process.env);
  const services = adb.listSystemServices(argValue(args, "grep"));
  return services;
}

function devicePermissionInfo(
  args: PluginArgs,
  positionals: string[],
): unknown {
  const permission = (positionals[0] ?? argValue(args, "permission") ?? "").trim();
  if (permission === "") throw new RequestError("permission name is required");
  const adb = requiredDevice(args, process.env);
  const info = adb.getPermissionInfo(permission);
  return info;
}

function frameworkCollect(request: PluginRequest, args: PluginArgs): unknown {
  const adb = requiredDevice(args, process.env);
  const layout = layoutFor(request, args, adb, true);
  const collection = collectFramework(adb, layout);
  return { artifact: summarizeArtifact(layout), layout, collection };
}

function frameworkProcess(
  request: PluginRequest,
  args: PluginArgs,
): unknown {
  const layout = layoutFor(request, args, frameworkDevice(args, process.env, false), false);
  const processResult = processFramework(layout);
  const jarPath = packFrameworkJar(layout);
  const fileCount = countFrameworkFiles(layout.outTmpDir);
  cleanFrameworkOutputs(layout, cleanSourceRequested(args));
  return {
    artifact: summarizeArtifact(layout),
    layout,
    process: processResult,
    pack: { jarPath, fileCount },
  };
}

const COMMANDS: Record<string, CommandHandler> = {
  "device system-services": (_request, args) => deviceSystemServices(args),
  "device permission-info": (_request, args, positionals) =>
    devicePermissionInfo(args, positionals),
  "framework collect": (request, args) => frameworkCollect(request, args),
  "framework process": (request, args) => frameworkProcess(request, args),
};

function dispatch(request: PluginRequest): unknown {
  if (request.protocol !== PROTOCOL_VERSION) {
    throw new RequestError(
      `unsupported protocol version ${String(request.protocol)} (expected ${PROTOCOL_VERSION})`,
    );
  }
  if (!Array.isArray(request.command) || request.command.length === 0) {
    throw new RequestError("request.command is required");
  }
  const commandPath = request.command.join(" ").trim();
  const handler = COMMANDS[commandPath];
  if (!handler) {
    throw new RequestError(`unsupported command: ${commandPath}`);
  }
  requireHome(request);
  const args = request.args ?? {};
  const positionals = Array.isArray(request.positionals) ? request.positionals : [];
  return handler(request, args, positionals);
}

/**
 * Runs one request and always returns the response envelope. Diagnostics go to
 * stderr; nothing is written to stdout so the embedded engine can use the
 * returned object as the command result.
 */
function handle(request: PluginRequest): PluginResponse {
  let commandPath = "";
  try {
    commandPath = Array.isArray(request.command) ? request.command.join(" ") : "";
    const data = dispatch(request);
    log(commandPath);
    return { ok: true, data };
  } catch (error) {
    const payload = errorPayload(error);
    log(`${commandPath || "request"} failed: ${payload.code}: ${payload.message}`);
    return { ok: false, error: payload };
  }
}

module.exports = { protocol: PROTOCOL_VERSION, handle };

if (require.main === module) {
  let response: PluginResponse;
  try {
    response = handle(JSON.parse(readStdin()) as PluginRequest);
  } catch (error) {
    const payload = errorPayload(error);
    log(`request failed: ${payload.code}: ${payload.message}`);
    response = { ok: false, error: payload };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

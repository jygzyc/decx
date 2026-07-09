/**
 * Self-management commands for decx-cli.
 */

import { Command } from "commander";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { Formatter } from "../utils/formatter.js";
import { Manager } from "../core/config.js";
import { checkForServerUpdate, installDecxServer, type InstallDecxServerResult } from "../core/installer.js";
import { DecxError, ServerError, withErrorHandler } from "../utils/errors.js";
import { VERSION } from "../core/version.js";

interface CliPackageMetadata {
  name: string;
  version: string;
}

function readCliPackageJson(startDir: string = path.dirname(fileURLToPath(import.meta.url))): Partial<CliPackageMetadata> {
  let dir: string | undefined = startDir;
  while (dir) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        return JSON.parse(readFileSync(pkgPath, "utf-8")) as Partial<CliPackageMetadata>;
      } catch {
        return {};
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return {};
}

export function getCliPackageMetadata(
  env: NodeJS.ProcessEnv = process.env,
  startDir?: string,
): CliPackageMetadata {
  const pkg = readCliPackageJson(startDir);
  return {
    name: env.npm_package_name ?? pkg.name ?? "unknown",
    version: VERSION,
  };
}

export function buildCliUpdateArgs(packageName: string, tag: string = "latest"): string[] {
  return ["install", "-g", `${packageName}@${tag}`];
}

interface NpmCommandDeps {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
}

export interface NpmUpdateCommand {
  command: string;
  args: string[];
  display: string;
  env: NodeJS.ProcessEnv;
  /**
   * Whether the command must be spawned through a shell.
   *
   * Invoking npm via its JS entrypoint (`node .../npm-cli.js`) needs no shell
   * and works everywhere. The shim fallback resolves to `npm.cmd` on Windows,
   * which is a batch file; spawning a batch file without a shell throws EINVAL
   * on Node 20.12+/22+/24+ (post CVE-2024-27980), so it requires `shell: true`.
   */
  shell: boolean;
}

function withPathPrefix(env: NodeJS.ProcessEnv, dirs: string[], platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const pathKey = platform === "win32" ? "Path" : "PATH";
  const currentPath = env.PATH ?? env.Path ?? "";
  const prefix = dirs.filter(Boolean).join(path.delimiter);
  return {
    ...env,
    [pathKey]: prefix ? `${prefix}${path.delimiter}${currentPath}` : currentPath,
  };
}

export function resolveNpmUpdateCommand(
  packageName: string,
  deps: NpmCommandDeps = {},
): NpmUpdateCommand {
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const updateArgs = buildCliUpdateArgs(packageName);
  const nodeDir = path.dirname(execPath);

  // Preferred: invoke npm's JS entrypoint directly with the current node.
  // This sidesteps the Windows `npm`→`npm.cmd` ENOENT bug and the EINVAL that
  // spawning a batch file without a shell raises on modern Node, and it avoids
  // the DEP0190 shell+args deprecation warning. `npm_execpath` (set when npm
  // invokes us) already points here; otherwise we probe the standard layouts:
  //   <nodeDir>/node_modules/npm/bin/npm-cli.js            (Windows installer, nvm-windows)
  //   <nodeDir>/../lib/node_modules/npm/bin/npm-cli.js     (Unix homebrew/apt/nvm)
  const npmEntryCandidates = [
    env.npm_execpath,
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npmEntry = npmEntryCandidates.find((candidate) => candidate && exists(candidate));
  if (npmEntry) {
    const args = [npmEntry, ...updateArgs];
    return {
      command: execPath,
      args,
      display: `${path.basename(execPath)} ${args.join(" ")}`,
      env: withPathPrefix(env, [nodeDir], platform),
      shell: false,
    };
  }

  // Last-resort fallback: the npm shim on PATH. On Windows this resolves to
  // npm.cmd (a batch file) and therefore MUST be spawned through a shell.
  const npmBinName = platform === "win32" ? "npm.cmd" : "npm";
  const candidates = [
    path.join(nodeDir, npmBinName),
    platform === "win32" ? path.join(nodeDir, "npm") : undefined,
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
    "/usr/bin/npm",
  ].filter((candidate): candidate is string => Boolean(candidate));

  const command = candidates.find((candidate) => exists(candidate)) ?? npmBinName;
  return {
    command,
    args: updateArgs,
    display: `${command} ${updateArgs.join(" ")}`,
    env: withPathPrefix(env, [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"], platform),
    shell: platform === "win32",
  };
}

type ServerVersionManager = Pick<Manager, "updateServerVersion">;

export async function executeSelfInstall(
  prerelease: boolean,
  deps: {
    installDecxServerFn?: (prerelease?: boolean) => Promise<InstallDecxServerResult>;
    manager?: ServerVersionManager;
  } = {}
): Promise<{ ok: true; version: string; path: string; message: string }> {
  const installDecxServerFn = deps.installDecxServerFn ?? installDecxServer;
  const manager = deps.manager ?? Manager.get();
  const result = await installDecxServerFn(prerelease);

  if (!result.ok) {
    throw new ServerError(result.message);
  }

  manager.updateServerVersion(result.version);
  return {
    ok: true,
    version: result.version,
    path: result.path,
    message: result.message,
  };
}

export function makeSelfCommand(): Command {
  const cmd = new Command("self");
  cmd.description("Install and update the bundled decx-server.jar and npm CLI package");

  cmd
    .command("install")
    .summary("Download or replace the local decx-server.jar")
    .description("Install the decx-server.jar used by process open and framework open/run. The file is stored under DECX_HOME when set, otherwise ~/.decx.")
    .option("-p, --prerelease", "Install the latest prerelease server artifact instead of the latest stable release")
    .action(withErrorHandler(async (opts) => {
      const fmt = new Formatter();
      fmt.output(await executeSelfInstall(opts.prerelease));
    }));

  cmd
    .command("update")
    .summary("Update both decx-server.jar and the globally installed npm CLI")
    .description("Check for a newer decx-server.jar, install it when available, then run npm install -g for the current CLI package.")
    .option("-p, --prerelease", "Allow prerelease server artifacts when checking for server updates")
    .action(withErrorHandler(async (opts) => {
      const fmt = new Formatter();
      const mgr = Manager.get();
      const currentVersion = mgr.serverJar.version;
      const cliPackage = getCliPackageMetadata();

      // Update server
      console.error(`  Updating decx-server (current: v${currentVersion})...`);

      const updateInfo = await checkForServerUpdate(currentVersion, opts.prerelease);
      if (updateInfo.available) {
        console.error(`  New version available: v${updateInfo.latestVersion}`);
        const result = await installDecxServer(opts.prerelease);
        if (result.ok) {
          mgr.updateServerVersion(result.version);
          console.error(`  ${result.message}`);
        } else {
          throw new DecxError(result.message, "UPDATE_ERROR");
        }
      } else {
        console.error("  Server already up to date");
      }

      // Update CLI
      if (cliPackage.name === "unknown") {
        throw new DecxError("Unable to determine CLI package name from package.json", "UPDATE_ERROR");
      }
      console.error(`  Updating ${cliPackage.name} (current: v${cliPackage.version})...`);
      const npmCommand = resolveNpmUpdateCommand(cliPackage.name);
      console.error(`  Running: ${npmCommand.display} ...`);

      const result = spawnSync(npmCommand.command, npmCommand.args, {
        stdio: "inherit",
        timeout: 120_000,
        env: npmCommand.env,
        shell: npmCommand.shell,
      });

      if (result.error) {
        const nodeDir = path.dirname(process.execPath);
        const hint = result.error.message.includes("ENOENT")
          ? ` (npm was not found; checked ${nodeDir}\\node_modules\\npm, PATH, and common install locations)`
          : result.error.message.includes("EINVAL")
            ? " (spawning npm on Windows requires a shell; this may be an outdated Node.js)"
            : "";
        throw new DecxError(`CLI update failed: ${result.error.message}${hint}`, "UPDATE_ERROR");
      }
      if (result.signal) {
        throw new DecxError(`CLI update failed: npm exited with signal ${result.signal}`, "UPDATE_ERROR");
      }
      if (result.status !== 0) {
        throw new DecxError("CLI update failed. Check npm output above.", "UPDATE_ERROR");
      }

      fmt.output({ ok: true, message: "Update complete. Restart your shell to use the new version." });
    }));

  return cmd;
}

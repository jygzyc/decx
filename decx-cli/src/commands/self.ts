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
import { checkForServerUpdate, installDecxServer, type InstallDecxServerResult } from "../server/installer.js";
import { DecxError, ServerError, withErrorHandler } from "../utils/errors.js";

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
    version: env.npm_package_version ?? pkg.version ?? "unknown",
  };
}

export function buildCliUpdateArgs(packageName: string, tag: string = "latest"): string[] {
  return ["install", "-g", `${packageName}@${tag}`];
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
  cmd.description("Self-management commands (update, install, etc.)");

  cmd
    .command("install")
    .description("Install or update decx-server.jar")
    .option("-p, --prerelease", "Install prerelease version")
    .action(withErrorHandler(async (opts) => {
      const fmt = new Formatter();
      fmt.output(await executeSelfInstall(opts.prerelease));
    }));

  cmd
    .command("update")
    .description("Update decx-server and/or decx-cli")
    .option("-p, --prerelease", "Install prerelease server version")
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
      console.error(`  Running: npm ${buildCliUpdateArgs(cliPackage.name).join(" ")} ...`);

      const result = spawnSync("npm", buildCliUpdateArgs(cliPackage.name), {
        stdio: "inherit",
        timeout: 120_000,
      });

      if (result.error) {
        throw new DecxError(`CLI update failed: ${result.error.message}`, "UPDATE_ERROR");
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

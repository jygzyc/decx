import { Command } from "commander";
import { AdbClient, filterSystemServices } from "../android/adb.js";
import { Formatter } from "../utils/formatter.js";
import { withErrorHandler } from "../utils/errors.js";
import { logCliEvent } from "../utils/logger.js";
import { addAdbDeviceOptions } from "./ard-shared.js";

export function registerArdDeviceCommands(cmd: Command): void {
  addAdbDeviceOptions(
    cmd
      .command("system-services")
      .summary("List live Binder service names from a connected device")
      .description("Run adb shell service list and return structured live system service data from the selected device.")
      .option("--grep <keyword>", "Include only service rows containing this keyword")
  )
    .action(withErrorHandler(async (opts) => {
      const fmt = new Formatter();
      const adb = new AdbClient({ adbPath: opts.adbPath, serial: opts.serial });
      adb.ensureAvailable();
      adb.ensureDeviceConnected();
      const services = filterSystemServices(adb.listSystemServices(), opts.grep);
      logCliEvent({
        command: "ard",
        action: "system_services",
        serial: opts.serial,
        grep: opts.grep,
        count: services.total,
      });
      fmt.output(services);
    }));

  addAdbDeviceOptions(
    cmd
      .command("perm-info <permission>")
      .summary("Show live Android permission metadata from a connected device")
      .description("Run adb shell pm list permissions and return details for one permission name such as android.permission.CAMERA.")
  )
    .action(withErrorHandler(async (permission: string, opts) => {
      const fmt = new Formatter();
      const adb = new AdbClient({ adbPath: opts.adbPath, serial: opts.serial });
      adb.ensureAvailable();
      adb.ensureDeviceConnected();
      const info = adb.getPermissionInfo(permission);
      logCliEvent({
        command: "ard",
        action: "perm_info",
        serial: opts.serial,
        permission,
      });
      fmt.output(info);
    }));
}

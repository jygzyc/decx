import { Command } from "commander";
import { AdbClient, filterSystemServices } from "../android/adb.js";
import { Formatter } from "../utils/formatter.js";
import { withErrorHandler } from "../utils/errors.js";
import { logCliEvent } from "../utils/logger.js";
import { addAdbDeviceOptions } from "./android-shared.js";

export function registerAndroidDeviceCommands(cmd: Command): void {
  const device = cmd
    .command("device")
    .summary("Inspect live state from an adb-connected Android device")
    .description("Run adb-backed queries against a connected Android device; these commands do not use a DECX analysis session.");

  addAdbDeviceOptions(
    device
      .command("system-services")
      .summary("List live Binder system services")
      .description("Run adb shell service list and return structured system service data from the selected device.")
      .option("--grep <keyword>", "Include only service rows containing this keyword")
  )
    .action(withErrorHandler(async (opts) => {
      const fmt = new Formatter();
      const adb = new AdbClient({ adbPath: opts.adbPath, serial: opts.serial });
      adb.ensureAvailable();
      adb.ensureDeviceConnected();
      const services = filterSystemServices(adb.listSystemServices(), opts.grep);
      logCliEvent({
        command: "android",
        action: "device_system_services",
        serial: opts.serial,
        grep: opts.grep,
        count: services.total,
      });
      fmt.output(services);
    }));

  addAdbDeviceOptions(
    device
      .command("permission-info <permission>")
      .summary("Show live Android permission metadata")
      .description("Run adb shell pm list permissions and return details for one permission name such as android.permission.CAMERA.")
  )
    .action(withErrorHandler(async (permission: string, opts) => {
      const fmt = new Formatter();
      const adb = new AdbClient({ adbPath: opts.adbPath, serial: opts.serial });
      adb.ensureAvailable();
      adb.ensureDeviceConnected();
      const info = adb.getPermissionInfo(permission);
      logCliEvent({
        command: "android",
        action: "device_permission_info",
        serial: opts.serial,
        permission,
      });
      fmt.output(info);
    }));
}

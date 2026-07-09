import { Command } from "commander";
import { AdbClient, filterSystemServices } from "../android/adb.js";
import { DecxError, withErrorHandler } from "../utils/errors.js";
import { Formatter } from "../utils/formatter.js";
import { logCliEvent } from "../utils/logger.js";
import type { AmStartTarget } from "../android/types.js";
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

  addAdbDeviceOptions(
    cmd
      .command("top-app")
      .summary("Return the current foreground app and activity from a connected device")
      .description("Run adb shell dumpsys activity activities and return the resumed/focused package and activity.")
  )
    .action(withErrorHandler(async (opts) => {
      const fmt = new Formatter();
      const adb = new AdbClient({ adbPath: opts.adbPath, serial: opts.serial });
      adb.ensureAvailable();
      adb.ensureDeviceConnected();
      const topApp = adb.getForegroundApp();
      logCliEvent({
        command: "ard",
        action: "top_app",
        serial: opts.serial,
        package: topApp.package,
        activity: topApp.activity,
      });
      fmt.output(topApp);
    }));

  addAdbDeviceOptions(
    cmd
      .command("am-start <pkg-or-component>")
      .summary("Start an app or activity on a connected device via adb am start")
      .description(
        "Launch an app via its launcher intent (pass a package name) or a specific activity " +
          "(pass a component such as com.example/.MainActivity). Use --activity to combine a package with an activity class.",
      )
      .option("--activity <class>", "Activity class to launch; pairs with a package argument (e.g. .MainActivity)")
  )
    .action(withErrorHandler(async (pkgOrComponent: string, opts) => {
      const fmt = new Formatter();
      const adb = new AdbClient({ adbPath: opts.adbPath, serial: opts.serial });
      adb.ensureAvailable();
      adb.ensureDeviceConnected();
      const target = resolveAmStartTarget(pkgOrComponent, opts.activity);
      const result = adb.amStart(target);
      logCliEvent({
        command: "ard",
        action: "am_start",
        serial: opts.serial,
        component: target.component,
        package: target.package,
        started: result.started,
      });
      fmt.output(result);
    }));
}

function resolveAmStartTarget(pkgOrComponent: string, activity?: string): AmStartTarget {
  if (activity) {
    if (pkgOrComponent.includes("/")) {
      throw new DecxError(
        "Cannot combine a component argument with --activity; pass either a component or a package plus --activity",
        "ADB_AM_START_TARGET_CONFLICT",
      );
    }
    return { component: `${pkgOrComponent}/${activity}` };
  }
  if (pkgOrComponent.includes("/")) {
    return { component: pkgOrComponent };
  }
  return { package: pkgOrComponent };
}

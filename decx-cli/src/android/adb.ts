import { spawnSync } from "child_process";
import { DecxError, FileError, ProcessError } from "../utils/errors.js";
import type {
  AdbClientOptions,
  AdbCommandResult,
  AmStartResult,
  AmStartTarget,
  PermissionInfo,
  SystemServicesResult,
  TopAppResult,
} from "./types.js";

const SUPPORTED_FRAMEWORK_OEMS = ["vivo", "oppo", "xiaomi", "honor", "google", "samsung"] as const;
type SupportedFrameworkOem = typeof SUPPORTED_FRAMEWORK_OEMS[number];

export function parseAdbDevicesOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("List of devices attached"))
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "device")
    .map((parts) => parts[0]);
}

export function resolvePreferredSerial(output: string, requestedSerial?: string, envSerial?: string): string {
  if (requestedSerial) return requestedSerial;
  const devices = parseAdbDevicesOutput(output);
  if (envSerial) {
    if (devices.length === 0) {
      throw new DecxError("No connected Android device detected via adb", "ADB_DEVICE_MISSING");
    }
    return envSerial;
  }
  if (devices.length === 0) {
    throw new DecxError("No connected Android device detected via adb", "ADB_DEVICE_MISSING");
  }
  if (devices.length > 1) {
    throw new DecxError(
      `Multiple adb devices detected (${devices.join(", ")}). Use --serial to select one.`,
      "ADB_DEVICE_AMBIGUOUS",
    );
  }
  return devices[0];
}

export function detectFrameworkOemFromBrand(brand: string): SupportedFrameworkOem {
  const normalized = brand.trim().toLowerCase();
  if ((SUPPORTED_FRAMEWORK_OEMS as readonly string[]).includes(normalized)) {
    return normalized as SupportedFrameworkOem;
  }
  throw new DecxError(
    `Unsupported device OEM '${brand}'. Supported: ${SUPPORTED_FRAMEWORK_OEMS.join(", ")}`,
    "ADB_UNSUPPORTED_OEM",
  );
}

export function parseSystemServicesOutput(output: string): SystemServicesResult {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const totalMatch = lines[0]?.match(/^Found\s+(\d+)\s+services:/);
  const services = lines
    .slice(totalMatch ? 1 : 0)
    .map((line) => line.match(/^(\d+)\t([^:]+): \[(.*)\]$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      index: Number.parseInt(match[1], 10),
      name: match[2],
      interfaces: match[3].trim().length === 0
        ? []
        : match[3].split(",").map((entry) => entry.trim()).filter(Boolean),
    }));

  return {
    total: totalMatch ? Number.parseInt(totalMatch[1], 10) : services.length,
    services,
  };
}

export function filterSystemServices(result: SystemServicesResult, keyword?: string): SystemServicesResult {
  const normalizedKeyword = keyword?.trim().toLowerCase();
  if (!normalizedKeyword) {
    return result;
  }

  const services = result.services.filter((service) =>
    service.name.toLowerCase().includes(normalizedKeyword)
    || service.interfaces.some((iface) => iface.toLowerCase().includes(normalizedKeyword)));

  return {
    total: services.length,
    services,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildPermissionInfoCommand(permission: string): string {
  return `pm list permissions -f | grep -A 5 -F -- ${shellQuote(permission)} || true`;
}

function normalizePermissionValue(value: string): string | null {
  return value === "null" ? null : value;
}

export function parsePermissionInfoOutput(output: string, permission: string): PermissionInfo | null {
  const normalizedPermission = permission.trim();
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const header = `+ permission:${normalizedPermission}`;
  const startIndex = lines.findIndex((line) => line === header);
  if (startIndex === -1) {
    return null;
  }

  const info: PermissionInfo = {
    permission: normalizedPermission,
  };
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > startIndex && line.startsWith("+ permission:")) {
      break;
    }
    if (index === startIndex) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key.length > 0) {
      info[key] = normalizePermissionValue(value);
    }
  }
  return info;
}

/**
 * Parse `dumpsys activity activities` output for the current foreground package/activity.
 *
 * Prefers `topResumedActivity`/`mResumedActivity` (modern ActivityTaskManager dumps),
 * whose lines look like:
 *   `topResumedActivity=ActivityRecord{2b3c u0 com.example/.MainActivity t123}`
 * Falls back to `mFocusedApp` (older / launcher hint), which look like:
 *   `mFocusedApp=AppWindowToken{... token=Token{... com.example/com.example.MainActivity}}`
 * Returns null when no foreground entry can be located.
 */
export function parseForegroundAppOutput(output: string): TopAppResult | null {
  const resumedMatch = output.match(/(?:topResumedActivity|mResumedActivity)=ActivityRecord\{[^}]*\su0\s+(\S+?)\s/);
  if (resumedMatch) {
    const component = resumedMatch[1];
    const slashIndex = component.indexOf("/");
    if (slashIndex > 0) {
      const pkg = component.slice(0, slashIndex);
      const activity = component.slice(slashIndex + 1);
      return { package: pkg, activity: resolveActivityName(pkg, activity) };
    }
    return { package: component, activity: null };
  }

  const focusedMatch = output.match(/mFocusedApp=.*?token=Token\{[^}]*\s([^\s}]+)\}/i);
  if (focusedMatch) {
    const component = focusedMatch[1];
    const slashIndex = component.indexOf("/");
    if (slashIndex > 0) {
      const pkg = component.slice(0, slashIndex);
      const activity = component.slice(slashIndex + 1);
      return { package: pkg, activity: resolveActivityName(pkg, activity) };
    }
    return { package: component, activity: null };
  }

  return null;
}

/**
 * Normalize an activity class name from a component's post-slash part.
 * `com.example/.MainActivity` -> `.MainActivity` is reported as `com.example.MainActivity`;
 * fully-qualified activities are returned unchanged.
 */
function resolveActivityName(pkg: string, activity: string): string {
  if (activity.startsWith(".")) {
    return `${pkg}${activity}`;
  }
  return activity;
}

export function buildAmStartCommand(target: AmStartTarget): string {
  if (target.component) {
    return `am start -W -n ${shellQuote(target.component)}`;
  }
  if (target.package) {
    return `am start -W ${shellQuote(target.package)}`;
  }
  throw new DecxError("am start requires either a component or a package", "ADB_AM_START_TARGET_REQUIRED");
}

export function parseAmStartOutput(output: string): { started: boolean } {
  const normalized = output.toLowerCase();
  if (/status:\s*ok/.test(normalized)) {
    return { started: true };
  }
  if (/\bstarted\b/.test(normalized) && !/error/.test(normalized)) {
    return { started: true };
  }
  return { started: false };
}

export class AdbClient {
  private selectedSerial: string | null = null;

  constructor(private readonly options: AdbClientOptions = {}) {}

  get adbPath(): string {
    return this.options.adbPath ?? "adb";
  }

  private baseArgs(): string[] {
    const serial = this.selectedSerial ?? this.options.serial ?? process.env.ANDROID_SERIAL;
    return serial ? ["-s", serial] : [];
  }

  private run(args: string[], timeout: number = 300_000): AdbCommandResult {
    const result = spawnSync(this.adbPath, [...this.baseArgs(), ...args], {
      encoding: "utf-8",
      timeout,
    });

    if (result.error) {
      throw new FileError(`Failed to execute adb: ${result.error.message}`, this.adbPath);
    }

    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
    };
  }

  ensureAvailable(): void {
    const result = this.run(["version"], 10_000);
    if (result.status !== 0) {
      throw new ProcessError(result.stderr.trim() || result.stdout.trim() || "adb is not available");
    }
  }

  private selectDevice(): void {
    this.selectedSerial = resolvePreferredSerial(
      this.run(["devices"], 10_000).stdout,
      this.options.serial,
      process.env.ANDROID_SERIAL,
    );
  }

  ensureDeviceConnected(): void {
    this.selectDevice();
    const result = this.run(["get-state"], 10_000);
    if (result.status !== 0 || !result.stdout.includes("device")) {
      throw new DecxError("No connected Android device detected via adb", "ADB_DEVICE_MISSING");
    }
  }

  shell(command: string, timeout: number = 300_000): string {
    const result = this.run(["shell", command], timeout);
    if (result.status !== 0) {
      throw new ProcessError(result.stderr.trim() || result.stdout.trim() || `adb shell failed: ${command}`);
    }
    return result.stdout;
  }

  listSystemServices(): SystemServicesResult {
    return parseSystemServicesOutput(this.shell("service list", 10_000));
  }

  getPermissionInfo(permission: string): PermissionInfo {
    const normalized = permission.trim();
    if (!normalized) {
      throw new DecxError("Permission name is required", "ADB_PERMISSION_REQUIRED");
    }
    const output = parsePermissionInfoOutput(
      this.shell(buildPermissionInfoCommand(normalized), 10_000),
      normalized,
    );
    if (!output) {
      throw new DecxError(`Permission '${normalized}' not found`, "ADB_PERMISSION_NOT_FOUND");
    }
    return output;
  }

  getProp(name: string): string {
    return this.shell(`getprop ${name}`, 10_000).trim();
  }

  detectFrameworkOem(): SupportedFrameworkOem {
    const brand =
      this.getProp("ro.product.vendor.brand")
      || this.getProp("ro.product.brand")
      || this.getProp("ro.product.manufacturer");
    return detectFrameworkOemFromBrand(brand);
  }

  pull(remotePath: string, localPath: string, timeout: number = 300_000): void {
    const result = this.run(["pull", remotePath, localPath], timeout);
    if (result.status !== 0) {
      throw new ProcessError(result.stderr.trim() || result.stdout.trim() || `adb pull failed: ${remotePath}`);
    }
  }

  getForegroundApp(): TopAppResult {
    const output = this.shell("dumpsys activity activities | grep -E '(mResumedActivity|topResumedActivity|mFocusedApp)'", 15_000);
    const parsed = parseForegroundAppOutput(output);
    if (!parsed) {
      throw new DecxError("No foreground activity detected on the device", "ADB_NO_FOREGROUND_APP");
    }
    return parsed;
  }

  amStart(target: AmStartTarget): AmStartResult {
    const command = buildAmStartCommand(target);
    const output = this.shell(command, 30_000);
    const { started } = parseAmStartOutput(output);
    if (!started) {
      throw new DecxError(
        `am start failed: ${output.trim().split(/\r?\n/).pop() || "unknown error"}`,
        "ADB_AM_START_FAILED",
        { component: target.component, package: target.package },
      );
    }
    return {
      component: target.component,
      package: target.package,
      started: true,
      raw: output.trim(),
    };
  }
}

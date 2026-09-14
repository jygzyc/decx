/**
 * ADB access for the device and framework workflows.
 *
 * Port of the former CLI `android/adb.ts`, aligned with the Go implementation
 * that superseded it: the service list is parsed from `service list` output,
 * permission metadata from `pm list permissions -f`, and device selection
 * distinguishes missing/ambiguous devices with stable error codes.
 */
const { spawnSync } = require("child_process");
const { DecxError, ProcessError, ToolError } = require("./errors.js");

const ADB_TIMEOUT_MS = 5 * 60 * 1000;

/** One row parsed from `service list`. */
interface SystemService {
  index: number;
  name: string;
  interfaces: string[];
}

/** `service list` result: total count plus matching rows. */
interface SystemServiceList {
  total: number;
  services: SystemService[];
}

/** Optional adb client settings from the command flags. */
interface AdbClientOptions {
  adbPath?: string;
  serial?: string;
}

/** Captured result of one adb invocation. */
interface AdbRunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Parsed `pm list permissions -f` block; absent values stay `null`. */
interface PermissionInfo {
  permission: string;
  [key: string]: string | null;
}

/** Device serials reported as ready by `adb devices`. */
function parseAdbDevicesOutput(output: string): string[] {
  const devices: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === "device") {
      devices.push(parts[0]);
    }
  }
  return devices;
}

/**
 * Resolve the device serial to use: the requested one, or the only connected
 * device. Missing devices raise ADB_DEVICE_MISSING and several connected
 * devices raise ADB_DEVICE_AMBIGUOUS so callers can report an actionable error.
 */
function resolvePreferredSerial(output: string, requestedSerial?: string): string {
  if (requestedSerial) return requestedSerial;
  const devices = parseAdbDevicesOutput(output);
  if (devices.length === 0) {
    throw new DecxError("no connected device", "ADB_DEVICE_MISSING");
  }
  if (devices.length > 1) {
    throw new DecxError(
      `select a device with --serial (connected: ${devices.join(", ")})`,
      "ADB_DEVICE_AMBIGUOUS",
    );
  }
  return devices[0];
}

/** Parse the `service list` shell output into structured service rows. */
function parseSystemServicesOutput(output: string, filter?: string): SystemServiceList {
  const services: SystemService[] = [];
  const normalizedFilter = filter?.trim().toLowerCase() ?? "";
  for (const rawLine of output.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^([0-9]+)\s+([^:]+): \[(.*)\]$/);
    if (!match) continue;
    if (
      normalizedFilter.length > 0
      && !`${match[2]} ${match[3]}`.toLowerCase().includes(normalizedFilter)
    ) {
      continue;
    }
    const interfaces = match[3]
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    services.push({
      index: Number.parseInt(match[1], 10),
      name: match[2],
      interfaces,
    });
  }
  return { total: services.length, services };
}

function filterSystemServices(result: SystemServiceList, keyword?: string): SystemServiceList {
  const normalized = keyword?.trim().toLowerCase();
  if (!normalized) return result;
  const services = result.services.filter((service) =>
    service.name.toLowerCase().includes(normalized)
    || service.interfaces.some((iface) => iface.toLowerCase().includes(normalized)));
  return { total: services.length, services };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPermissionInfoCommand(permission: string): string {
  return `pm list permissions -f | grep -A 5 -F -- ${shellQuote(permission)} || true`;
}

function normalizePermissionValue(value: string): string | null {
  return value === "null" ? null : value;
}

/**
 * Extract one permission's metadata block: the lines following
 * `+ permission:<name>` until the next permission header. Returns null when the
 * permission is absent from the output.
 */
function parsePermissionInfoOutput(output: string, permission: string): PermissionInfo | null {
  const normalizedPermission = permission.trim();
  const header = `+ permission:${normalizedPermission}`;
  let info: PermissionInfo | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("+ permission:")) {
      if (info !== null) break;
      if (line === header) info = { permission: normalizedPermission };
      continue;
    }
    if (info === null) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (key.length === 0) continue;
    info[key] = normalizePermissionValue(line.slice(separator + 1).trim());
  }
  return info;
}

export class AdbClient {
  selectedSerial: string | null = null;

  adbPath: string;
  requestedSerial: string | undefined;

  constructor(options: AdbClientOptions = {}) {
    this.adbPath = options.adbPath ?? "adb";
    this.requestedSerial = options.serial;
  }

  get serial(): string | null {
    return this.selectedSerial ?? this.requestedSerial ?? null;
  }

  baseArgs(): string[] {
    const serial = this.requestedSerial ?? this.selectedSerial;
    return serial ? ["-s", serial] : [];
  }

  run(args: string[], timeout = ADB_TIMEOUT_MS): AdbRunResult {
    const result = spawnSync(this.adbPath, [...this.baseArgs(), ...args], {
      encoding: "utf-8",
      timeout,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error) {
      throw new ToolError(`Failed to execute adb: ${result.error.message}`, "ADB_NOT_FOUND");
    }
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
    };
  }

  /** Run an adb command and fail on a non-zero exit status. */
  runChecked(args: string[], timeout = ADB_TIMEOUT_MS): string {
    const result = this.run(args, timeout);
    if (result.status !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `adb ${args.join(" ")} failed`;
      throw new ProcessError(message);
    }
    return result.stdout;
  }

  ensureAvailable(): void {
    const result = this.run(["version"], 10_000);
    if (result.status !== 0) {
      throw new ProcessError(result.stderr.trim() || result.stdout.trim() || "adb is not available");
    }
  }

  /**
   * Select the device: explicit serial wins, otherwise the single connected
   * device. Verifies the selection with `get-state`.
   */
  select(): void {
    if (!this.requestedSerial && !this.selectedSerial) {
      const output = this.runChecked(["devices"], 10_000);
      this.selectedSerial = resolvePreferredSerial(output);
    }
    const state = this.run(["get-state"], 10_000);
    if (state.status !== 0) {
      throw new DecxError(
        state.stderr.trim() || state.stdout.trim() || "selected device is not ready",
        "ADB_DEVICE_MISSING",
      );
    }
    if (state.stdout.trim() !== "device") {
      throw new DecxError("selected device is not ready", "ADB_DEVICE_MISSING");
    }
  }

  shell(command: string, timeout = ADB_TIMEOUT_MS): string {
    return this.runChecked(["shell", command], timeout);
  }

  listSystemServices(grep?: string): SystemServiceList {
    return parseSystemServicesOutput(this.shell("service list", 60_000), grep);
  }

  getPermissionInfo(permission: string): PermissionInfo {
    const normalized = permission.trim();
    if (!normalized) {
      throw new DecxError("permission name is required", "INVALID_PARAMETER");
    }
    const output = this.shell(buildPermissionInfoCommand(normalized), 60_000);
    const info = parsePermissionInfoOutput(output, normalized);
    if (!info) {
      throw new DecxError(`permission "${normalized}" not found`, "RESOURCE_NOT_FOUND");
    }
    return info;
  }

  getProp(name: string): string {
    return this.shell(`getprop ${name}`, 10_000).trim();
  }

  /** Device brand used for the artifact OEM segment (Go behavior: lowercase). */
  oem(): string {
    for (const key of ["ro.product.vendor.brand", "ro.product.brand", "ro.product.manufacturer"]) {
      const value = this.getProp(key);
      if (value) return value.toLowerCase();
    }
    return "unknown";
  }

  /** Device model used for the artifact vendor segment. */
  vendor(): string {
    return this.getProp("ro.product.model");
  }

  pull(remotePath: string, localPath: string, timeout = ADB_TIMEOUT_MS): void {
    this.runChecked(["pull", remotePath, localPath], timeout);
  }
}

module.exports = {
  parseAdbDevicesOutput,
  resolvePreferredSerial,
  parseSystemServicesOutput,
  filterSystemServices,
  shellQuote,
  buildPermissionInfoCommand,
  parsePermissionInfoOutput,
  AdbClient,
};

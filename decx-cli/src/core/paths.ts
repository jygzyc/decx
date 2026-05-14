import * as os from "os";
import * as path from "path";

export function userHome(): string {
  return os.homedir();
}

export function decxHome(): string {
  const override = process.env.DECX_HOME?.trim();
  return override ? path.resolve(override) : path.join(userHome(), ".decx");
}

export function decxPath(...parts: string[]): string {
  return path.join(decxHome(), ...parts);
}

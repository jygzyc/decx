import { ProcessError } from "../utils/errors.js";

export const MIN_SERVER_PORT = 1001;
export const MAX_SERVER_PORT = 65535;

/** Default range for randomly assigning a server port when none is requested. */
export const RANDOM_PORT_RANGE_MIN = 30000;
export const RANDOM_PORT_RANGE_MAX = 40000;

export function parseServerPort(value: string | number): number {
  const port = typeof value === "number"
    ? value
    : /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;

  if (!Number.isInteger(port) || port < MIN_SERVER_PORT || port > MAX_SERVER_PORT) {
    throw new ProcessError(`Invalid port: ${value}`);
  }

  return port;
}

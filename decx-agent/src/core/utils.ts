/**
 * Shared parsing helpers used across config loading, protocol parsing, and HTTP handlers.
 * Centralised here to avoid duplicating `isRecord` / `stringValue` / etc. in every module.
 */

/** Type guard: plain object (not null, not array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trimmed string or undefined if empty / not a string. */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Non-empty trimmed strings from an array, or undefined if none found. */
export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return result.length > 0 ? result : undefined;
}

/** Parse a positive integer, or undefined if invalid. */
export function positiveInt(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Sanitize a string for use as a session directory name. */
export function safeSessionName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

/** ISO-8601 UTC timestamp for current time. */
export function utcnow(): string {
  return new Date().toISOString();
}

/** Parse JSON value with fallback on failure. */
export function parseJson(value: unknown, fallback: unknown): unknown {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

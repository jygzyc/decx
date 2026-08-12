import type { Command } from "commander";

export function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

/** Parse a repeatable option value into a string array (commander passes [] by default). */
export function parseStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Parse an optional integer option value. */
export function parseOptionalInt(value: unknown): number | undefined {
  return value ? parseInt(String(value), 10) : undefined;
}

/** Parse the shared --page option (default 1). */
export function parsePage(opts: Record<string, unknown>): number {
  return parseOptionalInt(opts.page) ?? 1;
}

export function addPackageFilterOptions(cmd: Command): Command {
  return cmd
    .option("--limit <n>", "Maximum number of returned items")
    .option("--include-package <pattern>", "Include only class/package names matching this package pattern; repeatable", collectOption, [])
    .option("--exclude-package <pattern>", "Exclude class/package names matching this package pattern; repeatable", collectOption, [])
    .option("--no-regex", "Treat package filter patterns as literal text instead of regular expressions");
}

export function parseClassFilterOptions(opts: Record<string, unknown>): {
  filter: {
    limit?: number;
    includes: string[];
    excludes: string[];
    regex?: boolean;
  };
} {
  const limit = parseOptionalInt(opts.limit);
  return {
    filter: {
      ...(limit !== undefined ? { limit } : {}),
      includes: parseStringList(opts.includePackage),
      excludes: parseStringList(opts.excludePackage),
      ...(opts.regex === false ? { regex: false } : {}),
    },
  };
}

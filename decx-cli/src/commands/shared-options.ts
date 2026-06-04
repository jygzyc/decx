import type { Command } from "commander";

export function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
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
  return {
    filter: {
      ...(opts.limit ? { limit: parseInt(String(opts.limit), 10) } : {}),
      includes: Array.isArray(opts.includePackage) ? opts.includePackage.map(String) : [],
      excludes: Array.isArray(opts.excludePackage) ? opts.excludePackage.map(String) : [],
      ...(opts.regex === false ? { regex: false } : {}),
    },
  };
}

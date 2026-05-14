import { Command } from "commander";
import { resolveCommandClient } from "../core/client-helper.js";
import type { ClassFilterOptions, ClassGrepOptions, GlobalSearchOptions, SourceFilterOptions } from "../core/client.js";
import { withErrorHandler } from "../utils/errors.js";

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function addPackageFilterOptions(cmd: Command): Command {
  return cmd
    .option("--limit <n>", "Limit returned results")
    .option("--include-package <name>", "Only search classes and methods in this package", collectOption, [])
    .option("--exclude-package <name>", "Exclude classes and methods in this package", collectOption, [])
    .option("--no-regex", "Treat filter values as literal text");
}

function addGlobalSearchOptions(cmd: Command): Command {
  return addPackageFilterOptions(cmd)
    .option("--case-sensitive", "Use case-sensitive matching");
}

function addClassGrepOptions(cmd: Command): Command {
  return cmd
    .requiredOption("--limit <n>", "Limit returned grep results")
    .option("--case-sensitive", "Use case-sensitive matching")
    .option("--no-regex", "Treat the keyword as literal text");
}

function parseClassFilterOptions(opts: Record<string, unknown>): ClassFilterOptions {
  return {
    filter: {
      ...(opts.limit ? { limit: parseInt(String(opts.limit), 10) } : {}),
      includes: Array.isArray(opts.includePackage) ? opts.includePackage.map(String) : [],
      excludes: Array.isArray(opts.excludePackage) ? opts.excludePackage.map(String) : [],
      ...(opts.regex === false ? { regex: false } : {}),
    },
  };
}

function parseGlobalSearchOptions(opts: Record<string, unknown>): GlobalSearchOptions {
  return {
    search: {
      ...(opts.limit ? { limit: parseInt(String(opts.limit), 10) } : {}),
      includes: Array.isArray(opts.includePackage) ? opts.includePackage.map(String) : [],
      excludes: Array.isArray(opts.excludePackage) ? opts.excludePackage.map(String) : [],
      caseSensitive: opts.caseSensitive === true,
      regex: opts.regex !== false,
    },
  };
}

function parseClassGrepOptions(opts: Record<string, unknown>): ClassGrepOptions {
  return {
    grep: {
      limit: parseInt(String(opts.limit), 10),
      caseSensitive: opts.caseSensitive === true,
      regex: opts.regex !== false,
    },
  };
}

function parseSourceFilterOptions(opts: Record<string, unknown>): SourceFilterOptions {
  return {
    filter: {
      ...(opts.limit ? { limit: parseInt(String(opts.limit), 10) } : {}),
    },
  };
}

export function makeCodeCommand(): Command {
  const cmd = new Command("code");
  cmd.description("Common Code Analysis");

  cmd
    .option("-s, --session <name>", "Target session by name")
    .option("-P, --port <port>", "Server port");

  addPackageFilterOptions(cmd.command("classes"))
    .description("Get classes")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getClasses(parseClassFilterOptions(opts), page));
    }));

  addGlobalSearchOptions(cmd.command("search-global <keyword>"))
    .description("Search classes, methods, and resources")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (keyword: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.searchGlobalKey(keyword, parseGlobalSearchOptions(opts), page));
    }));

  cmd
    .command("class-context <class>")
    .description("Get class context with methods and fields")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (className: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getClassContext(className, page));
    }));

  cmd
    .command("class-source <class>")
    .description("Get class source code")
    .option("--limit <n>", "Limit returned source lines")
    .option("--smali", "Output in smali format")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (className: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getClassSource(className, opts.smali ?? false, parseSourceFilterOptions(opts), page));
    }));

  cmd
    .command("method-source <signature>")
    .description("Get method source")
    .option("--smali", "Output in smali format")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (sig: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getMethodSource(sig, opts.smali ?? false, page));
    }));

  cmd
    .command("method-context <signature>")
    .description("Get method context with signature, callers, and callees")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (sig: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getMethodContext(sig, page));
    }));

  cmd
    .command("method-cfg <signature>")
    .description("Get method control flow graph")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (sig: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getMethodCfg(sig, page));
    }));

  addClassGrepOptions(cmd.command("search-class <class> <pattern>"))
    .description("Grep in one class and return matching lines with method signatures")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (className: string, keyword: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.searchClassKey(className, keyword, parseClassGrepOptions(opts), page));
    }));

  cmd
    .command("search-method <name>")
    .description("Find methods by name")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (name: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.searchMethod(name, page));
    }));

  cmd
    .command("xref-method <signature>")
    .description("Find method callers")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (sig: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getMethodXref(sig, page));
    }));

  cmd
    .command("xref-class <class>")
    .description("Find class usages")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (className: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getClassXref(className, page));
    }));

  cmd
    .command("xref-field <field>")
    .description("Find field usages")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (fieldName: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getFieldXref(fieldName, page));
    }));

  cmd
    .command("implement <interface>")
    .description("Find implementations")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (iface: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getImplement(iface, page));
    }));

  cmd
    .command("subclass <class>")
    .description("Find subclasses")
    .option("--page <n>", "Page number", String)
    .action(withErrorHandler(async (className: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getSubClasses(className, page));
    }));

  return cmd;
}

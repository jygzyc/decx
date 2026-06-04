import { Command } from "commander";
import { resolveCommandClient } from "../core/client-helper.js";
import type { ClassGrepOptions, GlobalSearchOptions, SourceFilterOptions } from "../core/client.js";
import { withErrorHandler } from "../utils/errors.js";
import { addPackageFilterOptions, parseClassFilterOptions } from "./shared-options.js";

function addGlobalSearchOptions(cmd: Command): Command {
  return addPackageFilterOptions(cmd)
    .option("--case-sensitive", "Match keyword with case sensitivity");
}

function addClassGrepOptions(cmd: Command): Command {
  return cmd
    .requiredOption("--limit <n>", "Maximum number of matching source lines to return")
    .option("--case-sensitive", "Match pattern with case sensitivity")
    .option("--no-regex", "Treat pattern as literal text instead of a regular expression");
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
  cmd.description("Query decompiled classes, methods, source, control flow, and cross references");

  cmd
    .option("-s, --session <name>", "Use a named DECX process session instead of the default port")
    .option("-P, --port <port>", "Connect to a DECX HTTP server on this port");

  addPackageFilterOptions(cmd.command("classes"))
    .summary("List decompiled classes with optional package filters")
    .description("List decompiled class names. Use this first to discover exact class names for source, context, xref, and subclass commands.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getClasses(parseClassFilterOptions(opts), page));
    }));

  addGlobalSearchOptions(cmd.command("search-global <keyword>"))
    .summary("Search globally across class names, method names, and source/resource text")
    .description("Search the whole analysis target for a keyword or regex. Returns matched classes, methods, and resources for broad discovery.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (keyword: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.searchGlobalKey(keyword, parseGlobalSearchOptions(opts), page));
    }));

  cmd
    .command("class-context <class>")
    .summary("Show one class with fields, methods, and inheritance context")
    .description("Return structured context for one fully qualified class name, including fields, methods, and related class metadata.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (className: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getClassContext(className, page));
    }));

  cmd
    .command("class-source <class>")
    .summary("Return decompiled Java or smali source for one class")
    .description("Return source code for one fully qualified class name. Use --smali when bytecode-level output is needed.")
    .option("--limit <n>", "Maximum number of source lines to return")
    .option("--smali", "Return smali output instead of Java source")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (className: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getClassSource(className, opts.smali ?? false, parseSourceFilterOptions(opts), page));
    }));

  cmd
    .command("method-source <signature>")
    .summary("Return decompiled Java or smali source for one method")
    .description("Return source code for an exact method signature such as Lpkg/Cls;->method(I)V or the signature returned by search-method.")
    .option("--smali", "Return smali output instead of Java source")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (sig: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getMethodSource(sig, opts.smali ?? false, page));
    }));

  cmd
    .command("method-context <signature>")
    .summary("Show callers, callees, and metadata for one method")
    .description("Return structured context for an exact method signature, including caller and callee information for trace planning.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (sig: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getMethodContext(sig, page));
    }));

  cmd
    .command("method-cfg <signature>")
    .summary("Return the control-flow graph for one method")
    .description("Return basic blocks and control-flow edges for an exact method signature.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (sig: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getMethodCfg(sig, page));
    }));

  addClassGrepOptions(cmd.command("search-class <class> <pattern>"))
    .summary("Search source text inside one class")
    .description("Search one class source for a pattern and return matching lines with method signatures. Requires --limit.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (className: string, keyword: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.searchClassKey(className, keyword, parseClassGrepOptions(opts), page));
    }));

  cmd
    .command("search-method <name>")
    .summary("Find method signatures by simple or partial method name")
    .description("Search method names and return exact signatures suitable for method-source, method-context, method-cfg, and xref-method.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (name: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.searchMethod(name, page));
    }));

  cmd
    .command("xref-method <signature>")
    .summary("Find callers and references to one method")
    .description("Return cross references for an exact method signature, primarily callers and invocation sites.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (sig: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getMethodXref(sig, page));
    }));

  cmd
    .command("xref-class <class>")
    .summary("Find usages of one class")
    .description("Return code locations that reference a fully qualified class name.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (className: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getClassXref(className, page));
    }));

  cmd
    .command("xref-field <field>")
    .summary("Find reads and writes of one field")
    .description("Return code locations that reference an exact field signature or field name.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (fieldName: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getFieldXref(fieldName, page));
    }));

  cmd
    .command("implement <interface>")
    .summary("Find classes implementing one interface")
    .description("Return implementation classes for a fully qualified interface name.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (iface: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getImplement(iface, page));
    }));

  cmd
    .command("subclass <class>")
    .summary("Find subclasses of one class")
    .description("Return direct and discovered subclasses for a fully qualified class name.")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (className: string, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = opts.page ? parseInt(opts.page) : 1;
      fmt.output(await client.getSubClasses(className, page));
    }));

  return cmd;
}

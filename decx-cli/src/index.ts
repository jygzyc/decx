#!/usr/bin/env node

/**
 * DECX CLI - Decompiler + X
 */

import { Command } from "commander";
import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import { makeProcessCommand } from "./commands/process.js";
import { makeCodeCommand } from "./commands/code.js";
import { makeAndroidCommand } from "./commands/android.js";
import { makeSelfCommand } from "./commands/self.js";
import { maybeNotifyUpdate, runUpdateCheck } from "./core/update-notifier.js";
import { VERSION } from "./core/version.js";

export const ROOT_DESCRIPTION =
  "DECX - Decompiler + X, CLI for deeper analysis of decompiled Java code, powered by JADX and custom extensions";

export function createProgram(): Command {
  return new Command()
    .name("decx")
    .version(VERSION)
    .description(ROOT_DESCRIPTION)
    .addCommand(makeProcessCommand())
    .addCommand(makeCodeCommand())
    .addCommand(makeAndroidCommand())
    .addCommand(makeSelfCommand());
}

export function main(argv: readonly string[] = process.argv): void {
  // Internal entry point used by the background update-check child process;
  // kept out of the commander tree so it never shows up in help output.
  if (argv[2] === "__update-check") {
    void runUpdateCheck();
    return;
  }
  maybeNotifyUpdate();
  const program = createProgram();
  if (argv.length <= 2) {
    console.log(program.helpInformation());
    return;
  }
  program.parse(argv);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;

  const current = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(current);
  } catch {
    return entry === current;
  }
}

if (isDirectRun()) {
  main();
}

#!/usr/bin/env node

/**
 * DECX CLI - Decompiler + X
 */

import { Command } from "commander";
import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import { makeProcessCommand } from "./commands/process.js";
import { makeCodeCommand } from "./commands/code.js";
import { makeArdCommand } from "./commands/ard.js";
import { makeSelfCommand } from "./commands/self.js";
import { ROOT_DESCRIPTION } from "./core/constants.js";
import { VERSION } from "./core/version.js";

export function createProgram(): Command {
  return new Command()
    .name("decx")
    .version(VERSION)
    .description(ROOT_DESCRIPTION)
    .addCommand(makeProcessCommand())
    .addCommand(makeCodeCommand())
    .addCommand(makeArdCommand())
    .addCommand(makeSelfCommand());
}

export function main(argv: readonly string[] = process.argv): void {
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

#!/usr/bin/env node

/**
 * DECX CLI - Decompiler + X
 */

import { Command } from "commander";
import { makeProcessCommand } from "./commands/process.js";
import { makeCodeCommand } from "./commands/code.js";
import { makeArdCommand } from "./commands/ard.js";
import { makeSelfCommand } from "./commands/self.js";
import { ROOT_DESCRIPTION } from "./core/constants.js";

const program = new Command();

program
  .name("decx")
  .version(process.env.npm_package_version || "0.0.0")
  .description(ROOT_DESCRIPTION)
  .addCommand(makeProcessCommand())
  .addCommand(makeCodeCommand())
  .addCommand(makeArdCommand())
  .addCommand(makeSelfCommand());

program.parse();

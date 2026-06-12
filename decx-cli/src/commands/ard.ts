import { Command } from "commander";
import { registerArdAppAnalysisCommands, registerArdResourceCommands } from "./ard-app.js";
import { registerArdDeviceCommands } from "./ard-device.js";
import { registerArdFrameworkCommands } from "./ard-framework.js";

export function makeArdCommand(): Command {
  const cmd = new Command("ard");
  cmd.description("Android app, framework, resource, permission, and device analysis commands");

  cmd
    .option("-s, --session <name>", "Use a named DECX process session instead of the default port")
    .option("-P, --port <port>", "Connect to a DECX HTTP server on this port");

  registerArdAppAnalysisCommands(cmd);
  registerArdDeviceCommands(cmd);
  registerArdResourceCommands(cmd);
  registerArdFrameworkCommands(cmd);

  return cmd;
}

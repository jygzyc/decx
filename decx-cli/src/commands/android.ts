import { Command } from "commander";
import { registerAndroidAppAnalysisCommands, registerAndroidResourceCommands } from "./android-app.js";
import { registerAndroidDeviceCommands } from "./android-device.js";
import { registerAndroidFrameworkCommands } from "./android-framework.js";

export function makeAndroidCommand(): Command {
  const cmd = new Command("android");
  cmd.description("Analyze Android apps and frameworks, or inspect a connected device");

  cmd
    .option("-s, --session <name>", "Select a named DECX session; required when multiple sessions are running")
    .option("--port <port>", "Connect to a DECX HTTP server on this port");

  registerAndroidAppAnalysisCommands(cmd);
  registerAndroidDeviceCommands(cmd);
  registerAndroidResourceCommands(cmd);
  registerAndroidFrameworkCommands(cmd);

  return cmd;
}

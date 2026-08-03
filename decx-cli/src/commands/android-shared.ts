import { Command } from "commander";

export function addAdbDeviceOptions(cmd: Command): Command {
  return cmd
    .option("--adb-path <path>", "Path to the adb executable; defaults to adb on PATH")
    .option("--serial <serial>", "ADB device serial to use when multiple devices are connected");
}

export function addFrameworkCommonOptions(cmd: Command): Command {
  return addAdbDeviceOptions(cmd)
    .option("--source-dir <dir>", "Directory containing pulled framework files or receiving collected files")
    .option("--out-dir <dir>", "Directory for processed framework artifacts and packed jar output")
    .option("--clean-source", "Remove the collected source directory after successful processing");
}

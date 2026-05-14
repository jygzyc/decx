/**
 * CLI output formatter — JSON only.
 */

import pc from "picocolors";

export class Formatter {
  /** Print data as JSON. */
  output(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
  }

  error(msg: string): void {
    console.error(pc.red(`  [ERR] ${msg}`));
  }
}

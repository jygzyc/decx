/**
 * `decx taint` command group: Tai-e-powered taint analysis.
 *
 * Three surfaces mirroring the HTTP/MCP interfaces:
 *   - decx taint config    : inspect/validate JSON rules + engine state
 *   - decx taint analyze   : start an async analysis, returns a jobId
 *   - decx taint progress  : poll job state; on success returns attributed flows
 */

import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { resolveCommandClient } from "../core/client-helper.js";
import type { TaintAnalyzePayload, TaintConfigPayload } from "../core/client.js";
import { withErrorHandler } from "../utils/errors.js";
import { parseOptionalInt, parsePage, parseStringList } from "./shared-options.js";

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

/** --rules accepts a path to a rule file or an inline JSON document. */
function readRulesArg(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (existsSync(value)) return readFileSync(value, "utf-8");
  return value;
}

function parseRuleOptions(opts: Record<string, unknown>): TaintConfigPayload {
  const rules = readRulesArg(opts.rules);
  const rulePath = typeof opts.rulePath === "string" && opts.rulePath.length > 0 ? opts.rulePath : undefined;
  const ruleNames = parseStringList(opts.ruleNames);
  return {
    ...(rules !== undefined ? { rules } : {}),
    ...(rulePath !== undefined ? { rulePath } : {}),
    ...(ruleNames.length > 0 ? { ruleNames } : {}),
  };
}

export function makeTaintCommand(): Command {
  const cmd = new Command("taint");
  cmd.description("Run Tai-e taint analysis over an APK or an open session using appshark-style JSON rules");

  cmd
    .option("-s, --session <name>", "Select a named DECX session; required when multiple sessions are running")
    .option("--port <port>", "Connect to a DECX HTTP server on this port");

  cmd
    .command("config")
    .summary("Inspect taint rules and engine readiness")
    .description(
      "With no rule input: list built-in rules, engine capabilities, and environment status. " +
        "With --rules (file or inline JSON), --rule-path (directory), or --rule-names: parse, validate, " +
        "and summarize the selection. Use this to check 'decx self install tai-e' state before analyzing."
    )
    .option("--rules <file|json>", "Rule document: path to a *.json file or inline JSON text")
    .option("--rule-path <dir>", "Directory containing *.json rule files")
    .option("--rule-names <names>", "Comma-separated rule names to select/filter")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      fmt.output(await client.taintConfig(parseRuleOptions(opts), parsePage(opts)));
    }));

  cmd
    .command("analyze")
    .summary("Start an async taint analysis and print the job id")
    .description(
      "Validates rules and target synchronously, enqueues the analysis, and returns {jobId}. " +
        "Poll the result with: decx taint progress <jobId> --watch"
    )
    .requiredOption("--target-session <name>", "Analyze the APK of an open DECX session")
    .option("--apk <path>", "Analyze a standalone APK file (alternative to --target-session)")
    .option("--platforms <dir>", "Android SDK platforms directory (defaults to server DECX_HOME/platforms)")
    .option("--rules <file|json>", "Rule document: path to a *.json file or inline JSON text")
    .option("--rule-path <dir>", "Directory containing *.json rule files")
    .option("--rule-names <names>", "Comma-separated rule names to run (defaults to all built-in rules)")
    .option("--cs <mode>", "Context sensitivity: ci | 1obj | 2obj | 2-type | 2obj+H", "ci")
    .option("--scope <scope>", "Analysis scope: APP | REACHABLE", "APP")
    .option("--distinguish-strings", "Distinguish string constants in pointer analysis")
    .option("--timeout <sec>", "Hard wall-clock timeout for the whole analysis", String)
    .option("--pta-timeout <sec>", "Per-entry-point pointer analysis time budget", String)
    .action(withErrorHandler(async (opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      if (opts.targetSession && opts.apk) {
        throw new Error("Specify either --target-session or --apk, not both");
      }
      if (!opts.targetSession && !opts.apk) {
        throw new Error("One of --target-session or --apk is required");
      }
      const timeoutSec = parseOptionalInt(opts.timeout);
      const ptaTimeout = parseOptionalInt(opts.ptaTimeout);
      const payload: TaintAnalyzePayload = {
        target: {
          ...(opts.targetSession ? { session: opts.targetSession as string } : {}),
          ...(opts.apk ? { apk: opts.apk as string } : {}),
          ...(typeof opts.platforms === "string" && opts.platforms ? { platforms: opts.platforms } : {}),
        },
        ...parseRuleOptions(opts),
        analysis: {
          contextSensitivity: opts.cs as string,
          scope: (opts.scope as string).toUpperCase(),
          distinguishStrings: opts.distinguishStrings === true,
        },
        limits: {
          ...(timeoutSec !== undefined ? { timeoutSec } : {}),
          ...(ptaTimeout !== undefined ? { maxPointerAnalyzeTimeSec: ptaTimeout } : {}),
        },
      };
      fmt.output(await client.taintAnalyze(payload));
    }));

  cmd
    .command("progress [jobId]")
    .summary("Show taint job state, progress log, and attributed results")
    .description(
      "With a jobId: current state/stage/message/progressLog; when the job succeeded, items are the " +
        "attributed taint flows (rule names, severity, source/sink methods and lines). Without a jobId: " +
        "list recent jobs. --watch polls until the job finishes. --cancel cancels a queued/running job."
    )
    .option("--watch", "Poll until the job reaches a terminal state, then print the final result")
    .option("--interval <sec>", "Poll interval in seconds for --watch (default 5)", String)
    .option("--cancel", "Cancel the referenced queued/running job")
    .option("--page <n>", "Result page number to fetch", String)
    .action(withErrorHandler(async (jobId: string | undefined, opts, command) => {
      const { fmt, client } = resolveCommandClient(opts, command);
      const page = parsePage(opts);
      const intervalMs = Math.max(1, parseOptionalInt(opts.interval) ?? 5) * 1000;

      if (!jobId || opts.watch !== true) {
        fmt.output(await client.taintProgress({ ...(jobId ? { jobId } : {}), cancel: opts.cancel === true }, page));
        return;
      }

      // --watch: poll until terminal, then print the final envelope (flows).
      for (;;) {
        const result = (await client.taintProgress({ jobId }, page)) as Record<string, unknown>;
        const summary = (result.summary ?? {}) as Record<string, unknown>;
        const state = typeof summary.state === "string" ? summary.state : undefined;
        if (state !== undefined && TERMINAL_STATES.has(state)) {
          fmt.output(result);
          return;
        }
        if (result.ok === false) {
          fmt.output(result);
          return;
        }
        const stage = typeof summary.state === "string" ? summary.state : "running";
        process.stderr.write(`[taint] ${jobId}: ${stage}... (waiting ${intervalMs / 1000}s)\n`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }));

  return cmd;
}

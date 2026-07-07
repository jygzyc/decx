/**
 * Shared subprocess execution helper for command-style agent backends.
 *
 * Handles process spawning, stdin/prompt delivery, timeout handling, stdout and
 * stderr capture, and common result shaping so individual backend adapters stay
 * small.
 */

import { spawn } from "node:child_process";
import type { WorkerConfig } from "../../agent/types.js";
import type { AgentBackend, BackendInvokeInput, BackendInvokeResult } from "./types.js";

const SPAWN_ERROR_RETURNCODE = 127;
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

export abstract class SubprocessBackend implements AgentBackend {
  abstract readonly id: string;

  abstract buildArgv(config: WorkerConfig, prompt: string): { argv: string[]; env?: Record<string, string>; input?: string };

  invoke(input: BackendInvokeInput): Promise<BackendInvokeResult> {
    const built = this.buildArgv(input.config, input.prompt);
    const timeoutMs = input.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
      const child = spawn(built.argv[0], built.argv.slice(1), {
        cwd: input.cwd ?? process.cwd(),
        stdio: built.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(built.env ?? {}), DECX_AGENT_ACTIVE: "1" },
      });

      let stdoutLen = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let settled = false;

      const finish = (result: BackendInvokeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.removeAllListeners(); } catch { /* */ }
        resolve(result);
      };

      if (built.input && child.stdin) {
        child.stdin.write(built.input);
        child.stdin.end();
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutLen += chunk.length;
        if (stdoutLen > MAX_STDOUT_BYTES) {
          try { child.kill("SIGTERM"); } catch { /* */ }
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrChunks.reduce((a, c) => a + c.length, 0) < MAX_STDOUT_BYTES) {
          stderrChunks.push(chunk);
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* */ }
      }, timeoutMs);

      child.on("error", (err) => {
        finish({ text: "", returncode: SPAWN_ERROR_RETURNCODE, stderr: err.message });
      });

      child.on("close", (code, signal) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        if (timedOut || (signal && code === null)) {
          finish({
            text: stdout,
            returncode: SPAWN_ERROR_RETURNCODE,
            stderr: timedOut ? `worker timed out after ${timeoutMs}ms` : `worker terminated by signal ${signal}`,
            timedOut: timedOut || undefined,
          });
          return;
        }
        finish({
          text: stdout,
          returncode: code ?? SPAWN_ERROR_RETURNCODE,
          stderr,
        });
      });
    });
  }
}

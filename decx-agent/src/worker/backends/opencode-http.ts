/**
 * OpenCode HTTP backend.
 *
 * Sends prompts to a running OpenCode-compatible HTTP service instead of
 * spawning a local process. Use this when OpenCode session management is owned
 * by an external daemon.
 */

import type { WorkerConfig } from "../../agent/types.js";
import type { AgentBackend, BackendInvokeInput, BackendInvokeResult } from "./types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:4096";
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * OpencodeHttpBackend — invokes opencode via its HTTP server API.
 *
 * Requires `opencode serve` running at config.baseUrl (default localhost:4096).
 * If the server is not reachable, returns an error with instructions.
 *
 * The backend creates one session per invoke (no cross-turn session reuse).
 * This is intentional — the dispatcher passes a complete prompt each turn
 * (Cairn model). Session reuse would only matter for a subagent-loop dispatcher.
 *
 * Auth: if config.password is set, sends HTTP Basic auth (username "opencode").
 */
export class OpencodeHttpBackend implements AgentBackend {
  readonly id = "opencode-http";

  async invoke(input: BackendInvokeInput): Promise<BackendInvokeResult> {
    const baseUrl = (input.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    const password = input.config.password ?? process.env.OPENCODE_SERVER_PASSWORD;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (password) {
      const token = Buffer.from(`opencode:${password}`).toString("base64");
      headers["authorization"] = `Basic ${token}`;
    }

    let sessionId: string;
    try {
      const sessionResp = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: `decx-agent-${Date.now()}` }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!sessionResp.ok) {
        return errorResult(`opencode server returned ${sessionResp.status}: ${await sessionResp.text()}`);
      }
      const session = await sessionResp.json() as { id: string };
      sessionId = session.id;
    } catch (err) {
      return errorResult(`failed to connect to opencode server at ${baseUrl}. Is 'opencode serve' running? (${err instanceof Error ? err.message : String(err)})`);
    }

    try {
      const messageResp = await fetch(`${baseUrl}/session/${sessionId}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parts: [{ type: "text", text: input.prompt }],
        }),
        signal: AbortSignal.timeout(input.config.maxTokens ? input.config.maxTokens * 1000 : DEFAULT_TIMEOUT_MS),
      });

      if (!messageResp.ok) {
        return errorResult(`opencode message returned ${messageResp.status}: ${await messageResp.text()}`);
      }

      const result = await messageResp.json() as { info?: { role?: string }; parts?: Array<{ type: string; text?: string; content?: unknown }> };
      const text = extractAssistantText(result);
      return { text, returncode: 0, stderr: "" };
    } catch (err) {
      return errorResult(`opencode message failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function extractAssistantText(result: { parts?: Array<{ type: string; text?: string; content?: unknown }> }): string {
  if (!result.parts) return "";
  const texts: string[] = [];
  for (const part of result.parts) {
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    } else if (typeof part.content === "string") {
      texts.push(part.content);
    }
  }
  return texts.join("\n").trim();
}

function errorResult(message: string): BackendInvokeResult {
  return { text: "", returncode: 1, stderr: message };
}

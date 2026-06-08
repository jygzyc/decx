import { randomUUID } from "node:crypto";
import type { AgentPhase, WorkerConfig, WorkerName } from "../core/types.js";
import { safeSessionName } from "../core/utils.js";

export interface WorkerRequest {
  worker: WorkerName;
  phase: AgentPhase;
  role: string;
  projectId: string;
  sessionDir: string;
  prompt: string;
  intentId?: string;
  cwd?: string;
  config?: WorkerConfig;
}

export interface WorkerResult {
  worker: WorkerName;
  returncode: number;
  stdout: string;
  stderr: string;
  session?: string;
}

export interface WorkerDriver {
  readonly name: WorkerName;
  execute(request: WorkerRequest): Promise<WorkerResult> | WorkerResult;
}

export interface PreparedWorkerSession {
  session?: string;
  env: Record<string, string>;
}

export function prepareWorkerSession(request: WorkerRequest, config: WorkerConfig): PreparedWorkerSession {
  const strategy = config.sessionStrategy ?? "none";
  const session = strategy === "uuid"
    ? randomUUID()
    : strategy === "stable"
      ? safeSessionName(`${request.projectId}-${request.worker}-${request.role}`)
      : undefined;
  return {
    session,
    env: session ? { DECX_AGENT_WORKER_SESSION: session } : {},
  };
}

export function extractRegexSession(config: WorkerConfig, stdout: string, stderr: string): string | undefined {
  if (config.sessionStrategy !== "regex" || !config.sessionPattern) return undefined;
  const pattern = new RegExp(config.sessionPattern);
  const match = pattern.exec(`${stderr}\n${stdout}`);
  return typeof match?.[1] === "string" && match[1] ? match[1] : undefined;
}

export function renderArgTemplates(args: string[], request: WorkerRequest, session: string | undefined): string[] {
  const values: Record<string, string> = {
    prompt: request.prompt,
    worker: request.worker,
    phase: request.phase,
    role: request.role,
    projectId: request.projectId,
    sessionDir: request.sessionDir,
    intentId: request.intentId ?? "",
    session: session ?? "",
  };
  return args.map((arg) => arg.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_, key: string) => values[key] ?? ""));
}

export function extractResponseText(config: WorkerConfig, stdout: string): string {
  if (config.responseMode !== "jsonl-assistant-text") return stdout;

  let assistantText: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as unknown;
      const text = assistantTextFromEvent(event);
      if (text) assistantText = text;
    } catch {
      // Ignore non-JSON progress lines from command workers.
    }
  }
  return assistantText ?? stdout;
}

function assistantTextFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const message = record.message;
  if (record.type === "turn_end" && isAssistantMessage(message)) return textParts(message.content);
  if (record.type !== "agent_end" || !Array.isArray(record.messages)) return undefined;
  for (const item of [...record.messages].reverse()) {
    if (isAssistantMessage(item)) return textParts(item.content);
  }
  return undefined;
}

function isAssistantMessage(value: unknown): value is { role: string; content: unknown } {
  return !!value && typeof value === "object" && (value as Record<string, unknown>).role === "assistant";
}

function textParts(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  });
  return parts.join("\n").trim() || undefined;
}

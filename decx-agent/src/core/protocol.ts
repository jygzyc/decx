/**
 * JSON protocol parser for worker output.
 * Workers return structured JSON on stdout; this module extracts and validates it.
 */

import { isRecord, stringArray, stringValue } from "./utils.js";
import type { AgentPhase, WorkflowSeverity } from "./types.js";

export interface WorkerIntentPayload {
  from: string[];
  description: string;
  role?: string;
}

export interface WorkerEventPayload {
  type: string;
  severity?: WorkflowSeverity;
  source?: string;
  sink?: string;
  category?: string;
  data?: Record<string, unknown>;
}

export type WorkerPayload =
  | { kind: "rejected"; reason: string }
  | { kind: "fact"; description: string; evidence: string[]; events: WorkerEventPayload[] }
  | { kind: "intents"; intents: WorkerIntentPayload[] }
  | { kind: "complete"; from: string[]; description: string }
  | { kind: "review"; summary: string; severity?: WorkflowSeverity; events: WorkerEventPayload[] }
  | { kind: "events"; events: WorkerEventPayload[] }
  | { kind: "noop"; events: WorkerEventPayload[] };

export function parseWorkerPayload(phase: AgentPhase, stdout: string): WorkerPayload {
  const parsed = extractJson(stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`worker did not return JSON for ${phase}`);
  }

  const envelope = parsed as Record<string, unknown>;
  if (envelope.accepted === false) {
    return { kind: "rejected", reason: stringValue(envelope.reason) ?? "worker rejected task" };
  }

  const data = isRecord(envelope.data) ? envelope.data : envelope;
  const events = eventArray(data.events);

  if (isRecord(data.complete)) {
    return {
      kind: "complete",
      from: stringArray(data.complete.from) ?? [],
      description: requiredString(data.complete.description, "complete.description"),
    };
  }

  if (Array.isArray(data.intents)) {
    return {
      kind: "intents",
      intents: data.intents.map((intent, index) => {
        if (!isRecord(intent)) throw new Error(`intent ${index} must be an object`);
        return {
          from: stringArray(intent.from) ?? [],
          description: requiredString(intent.description, `intent ${index}.description`),
          role: stringValue(intent.role) ?? undefined,
        };
      }),
    };
  }

  if (isRecord(data.review)) {
    return {
      kind: "review",
      summary: requiredString(data.review.summary, "review.summary"),
      severity: severityValue(data.review.severity),
      events,
    };
  }

  if (isRecord(data.fact)) {
    return {
      kind: "fact",
      description: requiredString(data.fact.description, "fact.description"),
      evidence: stringArray(data.fact.evidence) ?? [],
      events,
    };
  }

  if (events.length > 0) return { kind: "events", events };
  if (phase === "reason") return { kind: "noop", events: [] };
  throw new Error(`${phase} worker output must contain fact data`);
}

function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  for (const candidate of candidates(trimmed)) {
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  return null;
}

/** Extract JSON from raw stdout: whole string first, then fenced code blocks, then {…} slices. */
function candidates(value: string): string[] {
  const fenced = [...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim());
  const direct = [value, ...fenced];
  const sliced: string[] = [];
  for (const candidate of direct) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) sliced.push(candidate.slice(start, end + 1));
  }
  return [...direct, ...sliced];
}

function requiredString(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`${field} must be a non-empty string`);
  return result;
}

function eventArray(value: unknown): WorkerEventPayload[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`event ${index} must be an object`);
    return {
      type: requiredString(item.type, `event ${index}.type`),
      severity: severityValue(item.severity),
      source: stringValue(item.source) ?? undefined,
      sink: stringValue(item.sink) ?? undefined,
      category: stringValue(item.category) ?? undefined,
      data: isRecord(item.data) ? item.data : undefined,
    };
  });
}

function severityValue(value: unknown): WorkflowSeverity | undefined {
  const severity = stringValue(value);
  if (severity === "info" || severity === "low" || severity === "medium" || severity === "high" || severity === "critical") {
    return severity;
  }
  return undefined;
}

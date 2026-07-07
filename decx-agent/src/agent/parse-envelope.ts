/**
 * Envelope parsing for worker output.
 *
 * Workers (LLM agents) return free-form text that may contain prose around a
 * JSON object. The envelope shape is `{ kind: string, data: unknown }`. This
 * module extracts the JSON, validates the envelope, and provides small typed
 * accessors used by the contract validators.
 *
 * Extracted from the original shared module so that contracts.ts,
 * SubagentRunner, MainAgent, and the decision applier share one parsing
 * implementation.
 */

export class StageError extends Error {
  constructor(
    message: string,
    readonly stage: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StageError";
  }
}

export interface WorkerEnvelope {
  kind: string;
  data: unknown;
}

export function parseEnvelope(text: string, stage: string): WorkerEnvelope {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new StageError("worker returned empty output", stage);
  }

  const jsonText = extractBestJson(trimmed);
  if (!jsonText) {
    throw new StageError(`worker output contains no JSON object: ${trimmed.slice(0, 120)}`, stage);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new StageError(`worker output is not valid JSON: ${(err as Error).message}`, stage, err);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StageError("worker output is not an object", stage);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.kind !== "string") {
    throw new StageError(`worker output missing "kind" field`, stage);
  }
  if (obj.data === undefined) {
    throw new StageError(`worker output missing "data" field`, stage);
  }
  return { kind: obj.kind, data: obj.data };
}

function extractBestJson(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    const candidate = fenced[1];
    if (validateJsonEnvelope(candidate)) return candidate;
  }

  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes("{")) continue;
    const candidate = findJsonFromLine(lines, i);
    if (candidate && validateJsonEnvelope(candidate)) return candidate;
  }

  return undefined;
}

function findJsonFromLine(lines: string[], startIdx: number): string | undefined {
  for (let i = startIdx; i >= 0; i--) {
    const slice = lines.slice(i, startIdx + 1).join("\n");
    const fb = slice.indexOf("{");
    const lb = slice.lastIndexOf("}");
    if (fb !== -1 && lb > fb) {
      const candidate = slice.slice(fb, lb + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch { /* keep searching */ }
    }
  }
  return undefined;
}

function validateJsonEnvelope(candidate: string): boolean {
  try {
    const obj = JSON.parse(candidate);
    return typeof obj === "object" && obj !== null && !Array.isArray(obj) &&
      typeof obj.kind === "string" && obj.data !== undefined;
  } catch {
    return false;
  }
}

export function expectKind(
  envelope: WorkerEnvelope,
  expected: string,
  stage: string,
): Record<string, unknown> {
  if (envelope.kind !== expected) {
    throw new StageError(`worker returned kind="${envelope.kind}", expected="${expected}"`, stage);
  }
  if (typeof envelope.data !== "object" || envelope.data === null || Array.isArray(envelope.data)) {
    throw new StageError(`worker data for kind="${expected}" is not an object`, stage);
  }
  return envelope.data as Record<string, unknown>;
}

export function asArray<T = unknown>(
  data: Record<string, unknown>,
  field: string,
  stage: string,
): T[] {
  const v = data[field];
  if (!Array.isArray(v)) {
    throw new StageError(`field "${field}" is not an array`, stage);
  }
  return v as T[];
}

export function asString(
  data: Record<string, unknown>,
  field: string,
  stage: string,
): string {
  const v = data[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new StageError(`field "${field}" is missing or not a non-empty string`, stage);
  }
  return v;
}

export function asOptionalString(
  data: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = data[field];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function asNumber(
  data: Record<string, unknown>,
  field: string,
  stage: string,
  fallback?: number,
): number {
  const v = data[field];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (fallback !== undefined) return fallback;
  throw new StageError(`field "${field}" is not a number`, stage);
}

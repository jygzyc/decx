/**
 * Output envelope.  Every command prints exactly one JSON object on stdout
 * (the consumers are agents), and failures use the same `{ok:false,error}`
 * shape as the rest of DECX.
 */

export interface SuccessEnvelope extends Record<string, unknown> {
  ok: true;
  command: string;
}

export interface FailureEnvelope {
  ok: false;
  command: string | null;
  error: { code: string; message: string; hint?: string };
}

export function ok(command: string, payload: Record<string, unknown>): SuccessEnvelope {
  const envelope: SuccessEnvelope = { ok: true, command };
  for (const key of Object.keys(payload)) envelope[key] = payload[key];
  return envelope;
}

export function fail(command: string | null, code: string, message: string, hint?: string): FailureEnvelope {
  return {
    ok: false,
    command,
    error: { code, message, ...(hint !== undefined && hint !== '' ? { hint } : {}) },
  };
}

export function stringify(value: unknown, pretty = false): string {
  return JSON.stringify(value, null, pretty ? 2 : undefined);
}

/**
 * Output envelope.  Every command prints exactly one JSON object on stdout
 * (the consumers are agents), and failures use the same `{ok:false,error}`
 * shape as the rest of DECX.
 */

export type SuccessEnvelope<T> = { ok: true; command: string } & T;

export interface FailureEnvelope {
  ok: false;
  command: string | null;
  error: { code: string; message: string; hint?: string };
}

export function ok<T extends object>(command: string, payload: T): SuccessEnvelope<T> {
  return { ok: true, command, ...payload };
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

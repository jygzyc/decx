import type { HttpResponse } from './types.ts';

/** Shared Node/scriptc transport; gh.ts owns redirect and authentication policy. */
export async function openResponse(url: string, headers: Record<string, string>): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeout = (): void => { controller.abort(); };
  let timer = setTimeout(timeout, 60_000);
  const cancel = (): void => { clearTimeout(timer); controller.abort(); };
  try {
    const response = await fetch(url, { headers, redirect: 'manual', signal: controller.signal });
    return {
      status: response.status,
      location: response.headers.get('location') ?? undefined,
      body: response.body,
      touch: () => { clearTimeout(timer); timer = setTimeout(timeout, 60_000); },
      cancel,
    };
  } catch (error) {
    cancel();
    throw error;
  }
}

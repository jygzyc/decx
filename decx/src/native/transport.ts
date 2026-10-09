import type { HttpResponse } from '../http-types.ts';

/** scriptc's native fetch streams through its bundled transport, not Node. */
export async function openResponse(url: string, headers: Record<string, string>): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeout = (): void => { controller.abort(); };
  let timer = setTimeout(timeout, 60_000);
  const cancel = (): void => { clearTimeout(timer); controller.abort(); };
  try {
    const response = await fetch(url, { headers, redirect: 'manual', signal: controller.signal });
    const location = response.headers.get('location') as string | null;
    return {
      status: response.status,
      location: location === null ? undefined : location,
      body: response.body,
      touch: () => { clearTimeout(timer); timer = setTimeout(timeout, 60_000); },
      cancel,
    };
  } catch (error) {
    cancel();
    throw error;
  }
}

import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';

import type { HttpResponse } from './http-types.ts';

/** One hop only: authentication and redirect policy belongs to gh.ts. */
export function openResponse(url: string, headers: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const onResponse = (res: http.IncomingMessage): void => {
      resolve({
        status: res.statusCode ?? 0,
        location: res.headers.location,
        body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
        touch: () => {}, // ClientRequest's timeout already measures socket inactivity.
        cancel: () => { res.destroy(); },
      });
    };
    const target = new URL(url);
    const req = target.protocol === 'http:'
      ? http.get(target, { headers }, onResponse)
      : https.get(target, { headers }, onResponse);
    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error(`timed out after 60s while fetching ${url}`));
    });
  });
}

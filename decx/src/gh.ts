/**
 * GitHub release resolution and asset download for the installer.
 *
 * The manager needs the newest release tag of a repository (stable, or the
 * newest prerelease), the release assets themselves, and -- when the project
 * publishes one -- a `SHA256SUMS`-style file.  Downloads stream to disk while
 * hashing, so a large archive is never buffered twice, and redirects are
 * followed by hand so the bearer token stays bound to the initial origin.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export const DEFAULT_API_BASE = 'https://api.github.com';
export const DEFAULT_DOWNLOAD_BASE = 'https://github.com';
export const DEFAULT_USER_AGENT = 'decx';

export interface GithubErrorOptions {
  status?: number;
  hint?: string;
}

export class GithubError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly hint: string | undefined;

  constructor(code: string, message: string, options: GithubErrorOptions = {}) {
    super(message);
    this.name = 'GithubError';
    this.code = code;
    this.status = options.status;
    this.hint = options.hint;
  }
}

export interface GithubRequestOptions {
  /** `GITHUB_TOKEN` / `GH_TOKEN`; sent only to each request's initial origin. */
  token?: string;
  userAgent?: string;
  apiBase?: string;
}

export interface ResolveReleaseOptions extends GithubRequestOptions {
  /** `owner/repo` on GitHub. */
  repository: string;
  /** Explicit tag; when set the API is not queried. */
  tag?: string;
  /** Restrict "latest" to tags starting with this prefix, e.g. `tools-v`. */
  tagPrefix?: string;
}

export interface ResolvedRelease {
  repository: string;
  tag: string;
  prerelease: boolean;
  /** Asset names GitHub reports for the release; empty for an explicit tag. */
  assetNames: string[];
}

/** The token the CLI uses, from the two environment variables GitHub itself uses. */
export function githubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  return token !== undefined && token.trim() !== '' ? token.trim() : undefined;
}

interface RawResponse {
  status: number;
  body: Readable;
}

interface RequestOptions {
  token?: string;
  userAgent: string;
  accept?: string;
  /** Initial origin the token may be sent to; fixed across all redirect hops. */
  authOrigin?: string;
}

function request(url: string, options: RequestOptions, redirects = 0): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new GithubError('TOO_MANY_REDIRECTS', `too many redirects while fetching ${url}`));
      return;
    }
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new GithubError('BAD_URL', `not a valid URL: ${url}`));
      return;
    }
    const authOrigin = options.authOrigin ?? target.origin;
    const transport = target.protocol === 'http:' ? http : https;
    const headers: Record<string, string> = {
      accept: options.accept ?? '*/*',
      'user-agent': options.userAgent,
    };
    if (options.token !== undefined && target.origin === authOrigin) {
      headers.authorization = `Bearer ${options.token}`;
    }
    const req = transport.get(target, { headers }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location !== undefined) {
        res.resume();
        let next: URL;
        try {
          next = new URL(location, target);
        } catch {
          reject(new GithubError('BAD_URL', `not a valid redirect URL: ${location}`));
          return;
        }
        if (target.protocol === 'https:' && next.protocol !== 'https:') {
          reject(new GithubError('INSECURE_REDIRECT', `refusing HTTPS downgrade from ${target} to ${next}`));
          return;
        }
        resolve(request(next.toString(), { ...options, authOrigin }, redirects + 1));
        return;
      }
      resolve({ status, body: res });
    });
    req.on('error', (error) => reject(error));
    req.setTimeout(60_000, () => req.destroy(new Error(`timed out after 60s while fetching ${url}`)));
  });
}

async function readBody(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function apiError(status: number, url: string, detail: string): GithubError {
  const code = status === 404 ? 'RELEASE_NOT_FOUND' : 'HTTP_ERROR';
  return new GithubError(code, `GitHub API returned HTTP ${status} for ${url}${detail === '' ? '' : `: ${detail}`}`);
}

async function getJson<T>(url: string, options: RequestOptions): Promise<T> {
  const response = await request(url, { ...options, accept: 'application/vnd.github+json' });
  const text = (await readBody(response.body)).toString('utf8');
  if (response.status !== 200) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === 'string') {
        detail = parsed.message;
      }
    } catch {
      // not JSON; keep the raw excerpt
    }
    throw apiError(response.status, url, detail);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GithubError('BAD_RESPONSE', `GitHub API returned invalid JSON for ${url}`);
  }
}

interface GithubReleaseJson {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

function releaseFromJson(repository: string, json: GithubReleaseJson, source: string): ResolvedRelease {
  const tag = json.tag_name;
  if (typeof tag !== 'string' || tag.trim() === '') {
    throw new GithubError('RELEASE_NOT_FOUND', `no release tag in the GitHub response for ${source}`);
  }
  const assets = Array.isArray(json.assets) ? json.assets : [];
  const assetNames: string[] = [];
  for (const asset of assets) {
    if (typeof asset === 'object' && asset !== null && typeof (asset as { name?: unknown }).name === 'string') {
      assetNames.push((asset as { name: string }).name);
    }
  }
  return { repository, tag, prerelease: json.prerelease === true, assetNames };
}

/**
 * Resolves the tag to install.  An explicit tag is returned untouched (the
 * caller already knows it; no API round-trip and no rate limit), while
 * "latest" is the newest stable release, or the newest stable release matching
 * `tagPrefix` across the paginated release list.
 */
export async function resolveRelease(options: ResolveReleaseOptions): Promise<ResolvedRelease> {
  const repository = options.repository;
  const explicit = options.tag;
  if (explicit !== undefined && explicit.trim() !== '') {
    return { repository, tag: explicit.trim(), prerelease: false, assetNames: [] };
  }
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const requestOptions: RequestOptions = {
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    ...(options.token !== undefined ? { token: options.token } : {}),
  };
  const wantsList = options.tagPrefix !== undefined;
  if (!wantsList) {
    const json = await getJson<GithubReleaseJson>(`${apiBase}/repos/${repository}/releases/latest`, requestOptions);
    return releaseFromJson(repository, json, `${apiBase}/repos/${repository}/releases/latest`);
  }
  const listUrl = `${apiBase}/repos/${repository}/releases`;
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const list = await getJson<GithubReleaseJson[]>(`${listUrl}?per_page=${pageSize}&page=${page}`, requestOptions);
    const first = list.find((release) => {
      if (release.draft === true || typeof release.tag_name !== 'string') {
        return false;
      }
      if (options.tagPrefix !== undefined && !release.tag_name.startsWith(options.tagPrefix)) {
        return false;
      }
      return release.prerelease !== true;
    });
    if (first !== undefined) {
      return releaseFromJson(repository, first, listUrl);
    }
    if (list.length < pageSize) {
      break;
    }
  }
  const prefix = options.tagPrefix !== undefined ? ` with tag prefix "${options.tagPrefix}"` : '';
  throw new GithubError('RELEASE_NOT_FOUND', `no stable release${prefix} found in ${repository}`, {
    hint: 'pass --version <tag> to pick a release explicitly',
  });
}

export interface DownloadResult {
  path: string;
  sha256: string;
  bytes: number;
}

/** Streams a URL to a file while computing its SHA-256 digest. */
export async function downloadAsset(
  url: string,
  dest: string,
  options: GithubRequestOptions = {},
): Promise<DownloadResult> {
  let response: RawResponse;
  try {
    response = await request(url, {
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      ...(options.token !== undefined ? { token: options.token } : {}),
    });
  } catch (error) {
    if (error instanceof GithubError || (error as NodeJS.ErrnoException).code === 'ERR_INVALID_PROTOCOL') {
      throw error;
    }
    throw new GithubError('DOWNLOAD_FAILED', `failed to download ${url}: ${(error as Error).message}`);
  }
  if (response.status !== 200) {
    response.body.resume();
    throw new GithubError('DOWNLOAD_FAILED', `failed to download ${url}: HTTP ${response.status}`, {
      status: response.status,
      hint: 'check the release tag and network access',
    });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      hash.update(buffer);
      bytes += buffer.length;
      callback(null, buffer);
    },
  });
  const output = fs.createWriteStream(dest);
  let writeError: Error | undefined;
  output.on('error', (error: NodeJS.ErrnoException) => {
    // A local staging failure is not evidence that an upstream is unavailable.
    if (error.syscall !== undefined && ['open', 'write', 'writev', 'close'].includes(error.syscall)) {
      writeError = error;
    }
  });
  try {
    await pipeline(response.body, meter, output);
  } catch (error) {
    fs.rmSync(dest, { force: true });
    if (writeError !== undefined) {
      throw writeError;
    }
    throw new GithubError('DOWNLOAD_FAILED', `failed to download ${url}: ${(error as Error).message}`);
  }
  return { path: dest, sha256: hash.digest('hex'), bytes };
}

/** SHA-256 of a file on disk, as lowercase hex. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    fs.createReadStream(file),
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        callback(null);
      },
    }),
  );
  return hash.digest('hex');
}

/** Parses `sha256  filename` lines (the `sha256sum` and `*filename` forms). */
export function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match !== null) {
      checksums.set(match[2] as string, (match[1] as string).toLowerCase());
    }
  }
  return checksums;
}

/** `https://github.com/<owner/repo>/releases/download/<tag>/<asset>`. */
export function releaseDownloadUrl(base: string, repository: string, tag: string, asset: string): string {
  return `${base.replace(/\/+$/, '')}/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

/**
 * GitHub release resolution and asset download for the installer.
 *
 * The manager needs the newest release tag of a repository (stable, or the
 * newest prerelease), the release assets themselves, and -- when the project
 * publishes one -- a `SHA256SUMS`-style file.  Downloads stream to disk while
 * hashing, so a large archive is never buffered twice, and redirects are
 * followed by hand so the bearer token stays bound to the initial origin.
 */

import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openResponse } from './http.ts';
import type { HttpResponse } from './types.ts';

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

/** SHA-256 digests published in the GitHub REST release asset metadata. */
export async function releaseAssetDigests(options: GithubRequestOptions & { repository: string; tag: string }): Promise<Map<string, string>> {
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const url = `${apiBase}/repos/${options.repository}/releases/tags/${encodeURIComponent(options.tag)}`;
  const json = await getJson<GithubReleaseJson>(url, {
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    ...(options.token !== undefined ? { token: options.token } : {}),
  });
  const digests = new Map<string, string>();
  const assets: unknown[] = Array.isArray(json.assets) ? json.assets : [];
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) continue;
    const { name, digest } = asset as { name?: unknown; digest?: unknown };
    if (typeof name === 'string' && typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(digest)) {
      digests.set(name, digest.slice('sha256:'.length).toLowerCase());
    }
  }
  return digests;
}

/** The token the CLI uses, from GitHub environment variables or `gh auth token`. */
export function githubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (token !== undefined && token.trim() !== '') {
    return token.trim();
  }
  if (env === process.env) {
    try {
      const gh = childProcess.execFileSync('gh', ['auth', 'token'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
        timeout: 2000,
      }).trim();
      if (gh.length > 0) return gh;
    } catch {
      // gh not installed, not authenticated, or errored
    }
  }
  return undefined;
}


interface RequestOptions {
  token?: string;
  userAgent: string;
  accept?: string;
  /** Initial origin the token may be sent to; fixed across all redirect hops. */
  authOrigin?: string;
}

async function request(url: string, options: RequestOptions): Promise<HttpResponse> {
  let target: URL;
  try { target = new URL(url); }
  catch { throw new GithubError('BAD_URL', `not a valid URL: ${url}`); }
  const authOrigin = options.authOrigin ?? target.origin;
  for (let redirects = 0; ; redirects += 1) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new GithubError('ERR_INVALID_PROTOCOL', `unsupported URL protocol: ${target.protocol}`);
    }
    if (redirects > 8) {
      throw new GithubError('TOO_MANY_REDIRECTS', `too many redirects while fetching ${target}`);
    }
    const headers: Record<string, string> = {
      accept: options.accept ?? '*/*', 'user-agent': options.userAgent,
    };
    if (options.token !== undefined && target.origin === authOrigin) {
      headers.authorization = `Bearer ${options.token}`;
    }
    const response = await openResponse(target.toString(), headers);
    const location = response.location;
    if (response.status < 300 || response.status >= 400 || location === undefined) return response;
    response.cancel();
    let next: URL;
    try { next = new URL(location, target); }
    catch { throw new GithubError('BAD_URL', `not a valid redirect URL: ${location}`); }
    if (target.protocol === 'https:' && next.protocol !== 'https:') {
      throw new GithubError('INSECURE_REDIRECT', `refusing HTTPS downgrade from ${target} to ${next}`);
    }
    target = next;
  }
}

async function readBody(response: HttpResponse): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const body = response.body;
  try {
    if (body !== null) {
      const reader = body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        response.touch();
        chunks.push(Buffer.from(chunk.value));
      }
    }
    return Buffer.concat(chunks);
  } finally { response.cancel(); }
}

function apiError(status: number, url: string, detail: string): GithubError {
  const code = status === 404 ? 'RELEASE_NOT_FOUND' : 'HTTP_ERROR';
  return new GithubError(code, `GitHub API returned HTTP ${status} for ${url}${detail === '' ? '' : `: ${detail}`}`);
}

async function getJson<T>(url: string, options: RequestOptions): Promise<T> {
  const response = await request(url, { ...options, accept: 'application/vnd.github+json' });
  const text = (await readBody(response)).toString('utf8');
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
  const assets: unknown[] = Array.isArray(json.assets) ? json.assets : [];
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
  const hash = createHash('sha256');
  let response: HttpResponse;
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
    response.cancel();
    throw new GithubError('DOWNLOAD_FAILED', `failed to download ${url}: HTTP ${response.status}`, {
      status: response.status,
      hint: 'check the release tag and network access',
    });
  }
  let bytes = 0;
  let descriptor: number | undefined;
  let localFailure = true;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    descriptor = fs.openSync(dest, 'w');
    localFailure = false;
    const body = response.body;
    if (body !== null) {
      const reader = body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        response.touch();
        const buffer = Buffer.from(chunk.value);
        let offset = 0;
        while (offset < buffer.length) {
          localFailure = true;
          const written = fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
          if (written === 0) throw new Error(`zero-byte write to ${dest}`);
          localFailure = false;
          offset += written;
        }
        hash.update(buffer);
        bytes += buffer.length;
      }
    }
    localFailure = true;
    fs.closeSync(descriptor);
    descriptor = undefined;
    localFailure = false;
  } catch (error) {
    response.cancel();
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the primary failure. */ }
    }
    fs.rmSync(dest, { force: true });
    // A local staging failure must not trigger an upstream fallback.
    if (localFailure) throw error;
    throw new GithubError('DOWNLOAD_FAILED', `failed to download ${url}: ${(error as Error).message}`);
  }
  response.cancel();
  return { path: dest, sha256: hash.digest('hex'), bytes };
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

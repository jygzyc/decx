/** Offline GitHub transport tests: loopback servers only, no real credentials. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { downloadAsset, GithubError, resolveRelease } from '../src/gh.ts';
import { sha256, tempDir } from './fixtures.ts';

const TOKEN = 'fixture-token';
const REPOSITORY = 'acme/demo';
const LATEST_PATH = `/repos/${REPOSITORY}/releases/latest`;
const RELEASE_BODY = JSON.stringify({ tag_name: 'v1.0.0', assets: [{ name: 'demo.zip' }] });

async function serve(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function destination(t: TestContext): string {
  const directory = tempDir('decx-gh-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'asset');
}

/** Exercise URL policy through HTTPS URLs without certificates or TLS overrides. */
function loopbackHttps(t: TestContext): void {
  t.mock.method(https, 'get', (target: URL, options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
    assert.equal(target.hostname, '127.0.0.1');
    assert.equal(target.protocol, 'https:');
    const local = new URL(target);
    local.protocol = 'http:';
    return http.get(local, options, callback);
  });
}

test('download redirects keep authorization bound to the initial origin across every hop', async (t) => {
  const received: Array<[string | undefined, string | undefined]> = [];
  const body = Buffer.from('offline archive\n');
  const origin = await serve(t, (request, response) => {
    received.push([request.url, request.headers.authorization]);
    if (request.url === '/start') {
      response.writeHead(302, { location: '/same-origin' });
    } else if (request.url === '/same-origin') {
      response.writeHead(302, { location: `${other}/cross-origin` });
    } else {
      response.end(body);
      return;
    }
    response.end();
  });
  const other = await serve(t, (request, response) => {
    received.push([request.url, request.headers.authorization]);
    response.writeHead(302, {
      location: request.url === '/cross-origin' ? '/still-cross-origin' : `${origin}/returned`,
    });
    response.end();
  });
  const dest = destination(t);
  const result = await downloadAsset(`${origin}/start`, dest, { token: TOKEN });
  assert.deepEqual(received, [
    ['/start', `Bearer ${TOKEN}`],
    ['/same-origin', `Bearer ${TOKEN}`],
    ['/cross-origin', undefined],
    ['/still-cross-origin', undefined],
    ['/returned', `Bearer ${TOKEN}`],
  ]);
  assert.deepEqual(result, { path: dest, sha256: sha256(body), bytes: body.length });
  assert.deepEqual(fs.readFileSync(dest), body);
});

test('release API redirects do not send the token to another origin or its relative redirects', async (t) => {
  const received: Array<string | undefined> = [];
  const other = await serve(t, (request, response) => {
    received.push(request.headers.authorization);
    if (request.url === '/redirect') {
      response.writeHead(307, { location: '/release' });
      response.end();
    } else {
      response.end(RELEASE_BODY);
    }
  });
  const apiBase = await serve(t, (request, response) => {
    received.push(request.headers.authorization);
    response.writeHead(301, { location: `${other}/redirect` });
    response.end();
  });
  const release = await resolveRelease({ repository: REPOSITORY, apiBase, token: TOKEN });
  assert.equal(release.tag, 'v1.0.0');
  assert.deepEqual(release.assetNames, ['demo.zip']);
  assert.deepEqual(received, [`Bearer ${TOKEN}`, undefined, undefined]);
});

test('an HTTP to HTTPS upgrade changes the authorization origin even on the same host and port', async (t) => {
  loopbackHttps(t);
  const received: Array<[string | undefined, string | undefined]> = [];
  const base = await serve(t, (request, response) => {
    received.push([request.url, request.headers.authorization]);
    if (request.url === '/start') {
      response.writeHead(302, { location: `${base.replace('http:', 'https:')}/secure` });
    } else if (request.url === '/secure') {
      response.writeHead(302, { location: '/secure-final' });
    } else {
      response.end('archive');
      return;
    }
    response.end();
  });
  await downloadAsset(`${base}/start`, destination(t), { token: TOKEN });
  assert.deepEqual(received, [
    ['/start', `Bearer ${TOKEN}`],
    ['/secure', undefined],
    ['/secure-final', undefined],
  ]);
});

for (const operation of ['download', 'release'] as const) {
  for (const token of [undefined, TOKEN]) {
    test(`${operation} rejects HTTPS downgrade ${token === undefined ? 'without' : 'with'} a token before sending HTTP`, async (t) => {
      loopbackHttps(t);
      const received: Array<string | undefined> = [];
      const base = await serve(t, (request, response) => {
        received.push(request.url);
        if (request.url === '/insecure') {
          response.end(RELEASE_BODY);
        } else {
          response.writeHead(302, { location: `${base}/insecure` });
          response.end();
        }
      });
      const secure = base.replace('http:', 'https:');
      const options = token === undefined ? {} : { token };
      const dest = destination(t);
      await assert.rejects(
        () => operation === 'download'
          ? downloadAsset(`${secure}/asset`, dest, options)
          : resolveRelease({ repository: REPOSITORY, apiBase: secure, ...options }),
        (error: unknown) => {
          assert.ok(error instanceof GithubError);
          assert.equal(error.code, 'INSECURE_REDIRECT');
          assert.equal(error.status, undefined);
          return true;
        },
      );
      assert.deepEqual(received, [operation === 'download' ? '/asset' : LATEST_PATH]);
      assert.equal(fs.existsSync(dest), false);
    });
  }
}

test('tag prefix lookup pages through unrelated, draft and prerelease entries to the first stable match', async (t) => {
  const unrelated = Array.from({ length: 100 }, (_, i) => ({ tag_name: `other-v${i}` }));
  const pages = [
    unrelated,
    [
      { tag_name: 'tools-v9', draft: true },
      { tag_name: 'tools-v8-rc1', prerelease: true },
      ...unrelated.slice(2),
    ],
    [
      { tag_name: 'tools-v7', draft: true },
      { tag_name: 'tools-v6-rc1', prerelease: true },
      { tag_name: 'tools-v5', assets: [{ name: 'demo.zip' }, { name: 'SHA256SUMS' }] },
      { tag_name: 'tools-v4' },
    ],
  ];
  const received: Array<[string, string | null, number, string | undefined]> = [];
  const apiBase = await serve(t, (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const page = Number(url.searchParams.get('page') ?? '1');
    received.push([url.pathname, url.searchParams.get('per_page'), page, request.headers.authorization]);
    response.end(JSON.stringify(pages[page - 1] ?? []));
  });
  const release = await resolveRelease({ repository: REPOSITORY, apiBase, tagPrefix: 'tools-v', token: TOKEN });
  assert.deepEqual(release, {
    repository: REPOSITORY,
    tag: 'tools-v5',
    prerelease: false,
    assetNames: ['demo.zip', 'SHA256SUMS'],
  });
  assert.deepEqual(received, [1, 2, 3].map((page) => [
    `/repos/${REPOSITORY}/releases`, '100', page, `Bearer ${TOKEN}`,
  ]));
});

test('tag prefix lookup stops as soon as a full page contains a stable match', async (t) => {
  const requested: string[] = [];
  const apiBase = await serve(t, (request, response) => {
    requested.push(request.url ?? '');
    response.end(JSON.stringify([
      { tag_name: 'tools-v2' },
      ...Array.from({ length: 99 }, (_, i) => ({ tag_name: `tools-v1.${i}` })),
    ]));
  });
  assert.equal((await resolveRelease({ repository: REPOSITORY, apiBase, tagPrefix: 'tools-v' })).tag, 'tools-v2');
  assert.equal(requested.length, 1);
});

for (const length of [0, 2, 100]) {
  test(`tag prefix lookup stops on an exhausted list (${length} nonmatching releases)`, async (t) => {
    const requested: number[] = [];
    const apiBase = await serve(t, (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const page = Number(url.searchParams.get('page') ?? '1');
      requested.push(page);
      response.end(JSON.stringify(page === 1
        ? Array.from({ length }, (_, i) => ({ tag_name: `other-v${i}` }))
        : []));
    });
    await assert.rejects(
      () => resolveRelease({ repository: REPOSITORY, apiBase, tagPrefix: 'tools-v' }),
      (error: unknown) => {
        assert.ok(error instanceof GithubError);
        assert.equal(error.code, 'RELEASE_NOT_FOUND');
        assert.match(error.message, /no stable release with tag prefix "tools-v"/);
        assert.match(error.hint ?? '', /--version <tag>/);
        return true;
      },
    );
    assert.deepEqual(requested, length === 100 ? [1, 2] : [1]);
  });
}

test('latest still uses the latest endpoint, while an explicit tag needs no request', async (t) => {
  const requested: Array<string | undefined> = [];
  const apiBase = await serve(t, (request, response) => {
    requested.push(request.url);
    response.end(RELEASE_BODY);
  });
  const latest = await resolveRelease({ repository: REPOSITORY, apiBase });
  const explicit = await resolveRelease({ repository: REPOSITORY, apiBase, tag: ' tools-v1 ' });
  assert.equal(latest.tag, 'v1.0.0');
  assert.deepEqual(explicit, { repository: REPOSITORY, tag: 'tools-v1', prerelease: false, assetNames: [] });
  assert.deepEqual(requested, [LATEST_PATH]);
});

for (const status of [401, 403, 404, 429, 500]) {
  test(`download HTTP ${status} retains its status after a redirect without writing a file`, async (t) => {
    const base = await serve(t, (request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { location: '/error' });
        response.end();
      } else {
        response.writeHead(status);
        response.end('fixture error');
      }
    });
    const dest = destination(t);
    await assert.rejects(() => downloadAsset(`${base}/start`, dest), (error: unknown) => {
      assert.ok(error instanceof GithubError);
      assert.equal(error.code, 'DOWNLOAD_FAILED');
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
    assert.equal(fs.existsSync(dest), false);
  });
}

test('transport failures remain distinguishable from HTTP download errors', async (t) => {
  const base = await serve(t, (request) => request.socket.destroy());
  const dest = destination(t);
  await assert.rejects(() => downloadAsset(`${base}/asset`, dest), (error: unknown) => {
    assert.ok(error instanceof GithubError);
    assert.equal(error.code, 'DOWNLOAD_FAILED');
    assert.equal(error.status, undefined);
    return true;
  });
  assert.equal(fs.existsSync(dest), false);
});

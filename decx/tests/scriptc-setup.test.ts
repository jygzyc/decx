import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
const { installSdk } = await import(new URL('../scripts/scriptc.mjs', import.meta.url).href) as {
  installSdk(root: string, options: {
    download: (url: string | URL | Request) => Promise<Response>;
    verify: (compiler: string) => { status: number | null; stdout: string; stderr: string; error?: Error };
  }): Promise<void>;
};
import { makeTarGz, sha256, tempDir, writeFile } from './fixtures.ts';

const suffix = process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : '';
const platform = `${process.platform}-${process.arch}${suffix}`;
const executable = process.platform === 'win32' ? 'scriptc.exe' : 'scriptc';
const bytes = makeTarGz([
  { name: `bin/${executable}`, data: 'fixture compiler', mode: 0o755 },
  { name: `bin/${executable}.json`, data: JSON.stringify({ schema: 'scriptc.native-toolchain.v1', compiler_version: '0.2.7' }) },
]);
const success = { pid: 0, output: [], status: 0, signal: null, stdout: '0.2.7\n', stderr: '' };

for (const failure of ['none', 'digest', 'download', 'version']) {
  test(`pinned SDK setup: ${failure}`, async (t) => {
    const root = tempDir('decx-sdk-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeFile(path.join(root, 'scriptc.json'), JSON.stringify({
      version: '0.2.7', repository: 'vercel-labs/scriptc',
      sha256: { [platform]: failure === 'digest' ? '0'.repeat(64) : sha256(bytes) },
    }));
    const marker = path.join(root, '.scriptc-toolchain/old');
    writeFile(marker, 'preserve existing SDK');
    let verified = false;
    const install = () => installSdk(root, {
      download: async (url: string | URL | Request) => {
        assert.equal(String(url), `https://github.com/vercel-labs/scriptc/releases/download/v0.2.7/scriptc-0.2.7-${platform}.tar.gz`);
        return new Response(Uint8Array.from(bytes), { status: failure === 'download' ? 404 : 200 });
      },
      verify: (compiler: string) => {
        assert.ok(fs.existsSync(compiler));
        verified = true;
        return { ...success, stdout: failure === 'version' ? '0.2.6\n' : success.stdout };
      },
    });
    if (failure === 'none') {
      await install();
      assert.ok(verified);
      assert.ok(!fs.existsSync(marker));
      assert.ok(fs.existsSync(path.join(root, '.scriptc-toolchain/bin', executable)));
      const source = JSON.parse(fs.readFileSync(path.join(root, '.scriptc-toolchain/SOURCE.json'), 'utf8'));
      assert.equal(source.sha256, sha256(bytes));
      assert.equal(source.version, '0.2.7');
    } else {
      await assert.rejects(install, failure === 'download' ? /HTTP 404/ : failure === 'digest' ? /integrity failure/ : /0.2.6/);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve existing SDK');
      assert.equal(verified, failure === 'version');
    }
    assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.scriptc-native-')));
  });
}

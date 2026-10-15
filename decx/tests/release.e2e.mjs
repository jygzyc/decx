import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const packageInfo = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

test('npm pack installs an offline, standalone CLI with embedded catalog and an executable npm shim', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-npm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, '安装目录 with spaces');
  const env = {
    ...process.env, HOME: root, USERPROFILE: root,
    DECX_HOME: path.join(root, 'tools'), DECX_LINKS_DIR: path.join(root, 'links'),
    npm_config_cache: path.join(root, 'cache'), npm_config_userconfig: path.join(root, 'npmrc'),
    npm_config_update_notifier: 'false',
  };
  fs.writeFileSync(env.npm_config_userconfig, '');
  assert.ok(process.env.npm_execpath, 'run package acceptance with npm test');
  const runNpm = args => {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: packageRoot, env, encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.error ?? result.stderr}\n${result.stdout}`);
    return result;
  };
  // Exercise prepack, not a substitute archiver or a manually built fixture.
  runNpm(['pack', '--pack-destination', root]);
  const archives = fs.readdirSync(root).filter(name => name.endsWith('.tgz'));
  assert.equal(archives.length, 1);
  const archive = path.join(root, archives[0]);
  const tar = args => {
    const result = spawnSync('tar', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  assert.deepEqual(tar(['-tzf', archive]).trim().split(/\r?\n/).sort(), [
    'package/README.md', 'package/dist/LICENSE', 'package/dist/THIRD_PARTY_NOTICES.txt',
    'package/dist/decx.mjs', 'package/package.json',
  ]);
  const packed = JSON.parse(tar(['-xOf', archive, 'package/package.json']));
  assert.equal(packed.name, packageInfo.name);
  assert.equal(packed.version, packageInfo.version);
  assert.equal(packed.private, undefined);
  assert.deepEqual(packed.bin, { decx: 'dist/decx.mjs' });
  assert.equal(packed.dependencies, undefined);
  const notices = tar(['-xOf', archive, 'package/dist/THIRD_PARTY_NOTICES.txt']);
  assert.match(notices, /execa@/);
  assert.match(notices, /Permission is hereby granted/);
  assert.doesNotMatch(notices, /(?:ajv|esbuild|typescript)@/);
  assert.match(tar(['-xOf', archive, 'package/dist/decx.mjs']), /^#!\/usr\/bin\/env node\n/);
  assert.equal(packed.license, 'Apache-2.0');
  assert.equal(tar(['-xOf', archive, 'package/dist/LICENSE']), fs.readFileSync(path.join(packageRoot, '..', 'LICENSE'), 'utf8'));
  runNpm(['install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  const executable = process.platform === 'win32' ? path.join(prefix, 'decx.cmd') : path.join(prefix, 'bin', 'decx');
  assert.ok(fs.existsSync(executable), 'npm must create the public decx executable');
  const execute = (args, status) => {
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${executable}" ${args.join(' ')}"`], {
        cwd: root, env, encoding: 'utf8', windowsVerbatimArguments: true,
      })
      : spawnSync(executable, args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, status, `${args}: ${result.error ?? result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const version = JSON.parse(execute(['version'], 0));
  assert.equal(version.ok, true);
  assert.equal(version.version, packageInfo.version);
  assert.match(execute(['help'], 0), /usage: decx/);
  assert.equal(JSON.parse(execute(['install'], 2)).error.code, 'USAGE');
  for (const id of ['afe', 'droidasc', 'kuna']) {
    assert.equal(JSON.parse(execute(['-m', id], 1)).error.code, 'NOT_INSTALLED');
  }
  assert.equal(fs.existsSync(env.DECX_HOME), false, 'read-only commands must not create a tool install');
  // Execute the bundled process runner from the actual offline npm install,
  // outside the checkout and without any external runtime node_modules.
  const share = path.join(env.DECX_HOME, 'share', 'afe');
  const bin = path.join(env.DECX_HOME, 'bin', process.platform === 'win32' ? 'afe.cmd' : 'afe');
  fs.mkdirSync(share, { recursive: true });
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const probe = path.join(share, 'probe.cjs');
  fs.writeFileSync(probe, 'console.log(JSON.stringify(process.argv.slice(2)));');
  fs.writeFileSync(bin, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${probe}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${probe}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(share, 'PROVENANCE'), `tool: afe\nbinary: ${bin}\nbinaries: ${path.basename(bin)}\nversion: fixture\n`);
  fs.writeFileSync(path.join(share, 'launch.json'), JSON.stringify({ command: process.execPath, args: [probe] }));
  assert.deepEqual(JSON.parse(execute(['-m', 'afe', 'bundle-probe'], 0)), ['bundle-probe']);
  runNpm(['uninstall', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', packageInfo.name]);
  assert.equal(fs.existsSync(executable), false);
});

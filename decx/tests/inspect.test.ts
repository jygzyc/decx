import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { binPath, provenanceFile, toolPrefix } from '../src/config.ts';
import {
  parseProvenance,
  provenanceBinaries,
  provenanceVersion,
  readProvenance,
  toolState,
} from '../src/inspect.ts';
import type { ToolManifest } from '../src/manifest.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decx-inspect-'));
}

function demoManifest(): ToolManifest {
  return { manifest: 1, id: 'demo', kind: 'binary', summary: 'demo tool', bins: ['demo'] };
}

test('parseProvenance reads pairs and folds indented continuations', () => {
  const provenance = parseProvenance(
    [
      'tool: demo',
      'install_method: release download',
      'extra: first line',
      '  second line',
      '',
      'not a pair',
      'version: 1.0.0',
      '',
    ].join('\n'),
  );
  assert.deepEqual(provenance, {
    tool: 'demo',
    install_method: 'release download',
    extra: 'first line\nsecond line',
    version: '1.0.0',
  });
});

test('parseProvenance tolerates empty and colon-less input', () => {
  assert.deepEqual(parseProvenance(''), {});
  assert.deepEqual(parseProvenance('no separator here\n\n'), {});
});

test('readProvenance returns null when there is no PROVENANCE file', () => {
  assert.equal(readProvenance(path.join(tempDir(), 'PROVENANCE')), null);
});

test('provenanceVersion prefers the release tag and strips a leading v', () => {
  assert.equal(provenanceVersion({ release_tag: 'v1.504' }), '1.504');
  assert.equal(provenanceVersion({ release_tag: 'v1.0.0', upstream_tag: 'v2.0.0' }), '1.0.0');
  assert.equal(provenanceVersion({ upstream_tag: 'v2.0.0' }), '2.0.0');
  assert.equal(provenanceVersion({ version: '3.0.0' }), '3.0.0');
  assert.equal(provenanceVersion({ release_tag: 'unknown', upstream_tag: 'v2.0.0' }), '2.0.0');
  assert.equal(provenanceVersion({ release_tag: '  ', version: '3.0.0' }), '3.0.0');
  assert.equal(provenanceVersion({ tool: 'demo' }), undefined);
});

test('provenanceBinaries reads the binaries list, falling back to binary', () => {
  assert.deepEqual(provenanceBinaries({ binaries: 'kuna decomp_dbg slacomp' }), ['kuna', 'decomp_dbg', 'slacomp']);
  assert.deepEqual(provenanceBinaries({ binary: '/home/me/.decx/share/kuna/bin/kuna.exe' }), ['kuna.exe']);
  assert.deepEqual(provenanceBinaries({ binaries: '   ', binary: '/opt/kuna' }), ['kuna']);
  assert.deepEqual(provenanceBinaries({}), []);
});

test('toolState reads the installed launcher and version from PROVENANCE', () => {
  const home = tempDir();
  fs.mkdirSync(path.dirname(binPath(home, 'demo')), { recursive: true });
  fs.writeFileSync(binPath(home, 'demo'), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(toolPrefix(home, 'demo'), { recursive: true });
  fs.mkdirSync(path.dirname(provenanceFile(home, 'demo')), { recursive: true });
  fs.writeFileSync(provenanceFile(home, 'demo'), 'tool: demo\ninstaller: decx install\nrelease_tag: v1.2.3\n');

  const state = toolState(home, demoManifest());
  assert.equal(state.installed, true);
  assert.equal(state.prefix, toolPrefix(home, 'demo'));
  assert.equal(state.bin, binPath(home, 'demo'));
  assert.equal(state.version, '1.2.3');
  assert.equal(state.provenance?.installer, 'decx install');
});

test('toolState reports a tool with no launcher as not installed', () => {
  const home = tempDir();
  assert.deepEqual(toolState(home, demoManifest()), { id: 'demo', installed: false });
});

test('toolState reports a launcher whose payload is gone as not installed', () => {
  const home = tempDir();
  fs.mkdirSync(path.dirname(binPath(home, 'demo')), { recursive: true });
  fs.writeFileSync(binPath(home, 'demo'), '#!/bin/sh\n', { mode: 0o755 });

  const state = toolState(home, demoManifest());
  assert.equal(state.installed, false);
  assert.equal(state.bin, binPath(home, 'demo'));
});

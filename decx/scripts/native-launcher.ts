import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Replaced at build time by the bundled CLI, including its version and manifests.
// scriptc does not yet compile the manager's Node APIs directly. This native
// launcher is intentionally a Node-dependent distribution, not a standalone CLI.
const bundle = '__DECX_BUNDLE__';

const directory = mkdtempSync(join(tmpdir(), 'decx-cli-'));
try {
  const entry = join(directory, 'decx.mjs');
  writeFileSync(entry, bundle);
  const node = process.platform === 'win32' ? 'node.exe' : 'node';
  const result = spawnSync(node, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.status === null) {
    console.error('decx: Node 24.21+ must be available on PATH');
    process.exitCode = 1;
  } else {
    process.exitCode = result.status;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

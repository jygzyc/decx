#!/usr/bin/env node
/**
 * Build the distributable CLI: compile `src/` to `dist/decx/lib/` (the build
 * tsconfig rewrites the `.ts` import specifiers to `.js`), write the runtime
 * `dist/decx/package.json` the CLI reads for `decx version`, and copy every
 * tool manifest into `dist/subprojects/` so the packaged CLI discovers tools
 * without the source checkout. The `subprojects/` checkout itself is not
 * bundled: install falls back to the manifest's release sources.
 */
import fs from 'node:fs';
import path from 'node:path';
import { distRoot, packageInfo, packageRoot, repoRoot, run, writeJson } from './common.mjs';

fs.rmSync(distRoot, { recursive: true, force: true });

const tsc = path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tsc)) {
  throw new Error('typescript is not installed; run `npm ci` first');
}
run(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: packageRoot, stdio: 'inherit' });

const cliJs = path.join(distRoot, 'decx', 'lib', 'cli.js');
if (!fs.existsSync(cliJs)) {
  throw new Error(`build did not produce ${cliJs}`);
}
// tsc keeps the `#!/usr/bin/env node` shebang from src/cli.ts; restore the exec bit.
fs.chmodSync(cliJs, 0o755);

const pkg = packageInfo();
writeJson(path.join(distRoot, 'decx', 'package.json'), {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  type: 'module',
  bin: pkg.bin,
  engines: pkg.engines,
});

const subprojects = path.join(repoRoot, 'subprojects');
let bundled = 0;
for (const entry of fs.readdirSync(subprojects, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('decx-')) {
    continue;
  }
  const manifest = path.join(subprojects, entry.name, `${entry.name}.json`);
  if (!fs.existsSync(manifest)) {
    continue;
  }
  const dest = path.join(distRoot, 'subprojects', entry.name, path.basename(manifest));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(manifest, dest);
  bundled += 1;
}
if (bundled === 0) {
  throw new Error('no tool manifests were bundled into dist/subprojects');
}

console.log(`built dist/decx/lib/cli.js (bundled ${bundled} tool manifests)`);

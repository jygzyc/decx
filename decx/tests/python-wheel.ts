import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './fixtures.ts';

/** Minimal pure-Python wheel; pip only sees the caller's local wheelhouse. */
export function writePythonWheel(wheelhouse: string): void {
  const fixture = fileURLToPath(new URL('./fixtures/python-tool/', import.meta.url));
  const info = 'pyprobe-1.0.0.dist-info';
  const files = [
    { name: 'pyprobe/__init__.py', data: fs.readFileSync(path.join(fixture, 'pyprobe', '__init__.py')) },
    { name: 'pyprobe/cli.py', data: fs.readFileSync(path.join(fixture, 'pyprobe', 'cli.py')) },
    { name: `${info}/METADATA`, data: 'Metadata-Version: 2.1\nName: pyprobe\nVersion: 1.0.0\n' },
    { name: `${info}/WHEEL`, data: 'Wheel-Version: 1.0\nGenerator: decx-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n' },
    { name: `${info}/entry_points.txt`, data: '[console_scripts]\npyprobe = pyprobe.cli:main\n' },
  ];
  const record = [...files.map(({ name }) => `${name},,`), `${info}/RECORD,,`].join('\n') + '\n';
  fs.writeFileSync(path.join(wheelhouse, 'pyprobe-1.0.0-py3-none-any.whl'), makeZip([...files, { name: `${info}/RECORD`, data: record }]));
}

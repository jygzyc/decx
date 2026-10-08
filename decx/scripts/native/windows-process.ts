import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandResult, CommandSpec } from './install.ts';

// Bound at build time by --ffi; UTF-8 strings pass as pointer/length pairs.
declare function decxWindowsRun(application: string, commandLine: string, environment: string,
  stdout: string, stderr: string, capture: number, hide: number): number;

/** Preserve launchSpec's cmd escaping without applying CRT quoting a second time. */
export async function runWindowsVerbatim(spec: CommandSpec): Promise<CommandResult> {
  if (spec.command.includes('\0') || spec.command.includes('"') || spec.args.some(arg => arg.includes('\0'))) {
    return { status: null, stdout: '', stderr: '', error: 'invalid Windows command line' };
  }
  const entries: string[] = [];
  for (const [key, value] of Object.entries(spec.env ?? process.env)) {
    if (value === undefined) continue;
    if (key.includes('\0') || value.includes('\0')) {
      return { status: null, stdout: '', stderr: '', error: 'NUL in child environment' };
    }
    entries.push(`${key}=${value}`);
  }
  entries.sort((a, b) => {
    const left = a.toUpperCase();
    const right = b.toUpperCase();
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  const commandLine = `"${spec.command}" ${spec.args.join(' ')}`;
  const environment = `${entries.join('\0')}\0\0`;
  const capture = spec.mode !== 'inherit';
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-windows-run-'));
  try {
    const out = path.join(temporary, 'stdout');
    const err = path.join(temporary, 'stderr');
    const status = decxWindowsRun(spec.command, commandLine, environment, out, err, capture ? 1 : 0,
      spec.windowsHide !== false ? 1 : 0);
    if (status < 0) return { status: null, stdout: '', stderr: '', error: `CreateProcessW failed (Win32 ${-status})` };
    const stdout = capture ? fs.readFileSync(out, 'utf8') : '';
    const stderr = capture ? fs.readFileSync(err, 'utf8') : '';
    if (spec.mode === 'stream') { process.stderr.write(stdout); process.stderr.write(stderr); }
    return { status, stdout, stderr };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

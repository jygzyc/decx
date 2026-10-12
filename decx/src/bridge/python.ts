/** Probe Python and prepare a private venv initialized at its permanent path. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { binRoot, runtimePath } from '../core/config.ts';
import { InstallError } from '../core/errors.ts';
import { applyExecutableMode, isExecutable } from '../core/fs.ts';
import { isWindows } from '../core/platform.ts';
import { verifyArgs, type ToolManifest } from '../catalog/manifest.ts';
import { isoTimestamp } from '../install/state.ts';
import type { InstallOptions, StagedOutcome } from '../install/types.ts';
import { launcherText, type LaunchEntry } from './launch.ts';
import { runCommand, type BridgeContext, type CommandResult } from './process.ts';

function firstLine(result: CommandResult): string {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return text.split(/\r?\n/)[0] ?? '';
}

interface PythonCandidate {
  /** Interpreter command name, e.g. `python3.12`. */
  command: string;
  /** Leading arguments the command needs, e.g. `-3.12` for the Windows launcher. */
  args: string[];
  /** Human-readable form for messages and PROVENANCE, e.g. `python3.12` or `py -3.12`. */
  label: string;
}

/** Interpreter names to probe for a venv install, PATH defaults first. */
function pythonCandidates(ctx: BridgeContext): PythonCandidate[] {
  // An explicit `DECX_PYTHON` is used as given: the caller knows the machine.
  const override = (ctx.env.DECX_PYTHON ?? '').trim();
  if (override !== '') {
    return [{ command: override, args: [], label: override }];
  }
  const candidates: PythonCandidate[] = [
    { command: 'python3', args: [], label: 'python3' },
    { command: 'python', args: [], label: 'python' },
  ];
  if (isWindows()) {
    candidates.push({ command: 'py', args: ['-3'], label: 'py -3' });
  }
  // Also probe versioned interpreters when PATH defaults are absent or Python 2.
  // Package metadata and pip enforce any package-specific minimum Python version.
  for (const minor of [15, 14, 13, 12, 11, 10]) {
    candidates.push({ command: `python3.${minor}`, args: [], label: `python3.${minor}` });
    if (isWindows()) {
      candidates.push({ command: 'py', args: [`-3.${minor}`], label: `py -3.${minor}` });
    }
  }
  return candidates;
}

/** Finds Python 3 for a private venv; pip owns package-version requirements. */
async function findPython(ctx: BridgeContext): Promise<PythonCandidate & { output: string }> {
  for (const candidate of pythonCandidates(ctx)) {
    const probe = await runCommand(ctx, candidate.command, [...candidate.args, '--version']);
    if (probe.error !== undefined || probe.status !== 0) {
      continue;
    }
    const output = firstLine(probe);
    if (!/^Python 3\./.test(output)) {
      continue;
    }
    return { command: candidate.command, args: candidate.args, label: candidate.label, output };
  }
  throw new InstallError(
    'PYTHON_NOT_FOUND',
    "no Python 3 interpreter found in PATH (looked for python3, python and versioned names such as python3.12). Install Python 3 with the venv module (Debian/Ubuntu: 'apt install python3 python3-venv'; macOS: 'brew install python3'; Windows: python.org or 'winget install Python.Python.3') and re-run; decx does not install it for you.",
  );
}

export async function stageVenv(
  ctx: BridgeContext,
  manifest: ToolManifest,
  prefix: string,
  stage: string,
  options: Pick<InstallOptions, 'version'>,
): Promise<StagedOutcome> {
  const packageName = manifest.install[2] as string;
  const provenance: Record<string, string> = {};
  const python = await findPython(ctx);
  const platformOs = ctx.platform !== null ? ctx.platform.split('-')[0] ?? 'unknown' : isWindows() ? 'win' : process.platform;
  const windows = platformOs === 'win';
  const venvBin = windows ? 'Scripts' : 'bin';
  const venvPythonName = windows ? 'python.exe' : 'python';
  const venvDir = runtimePath(ctx.home, manifest.id);
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  const name = manifest.launch.commands[0] as string;
  const launcherName = windows ? `${name}.cmd` : name;
  const consoleScript = path.join(venvDir, venvBin, windows ? `${name}.exe` : name);
  const entry: LaunchEntry = { command: windows ? consoleScript : path.join(venvDir, venvBin, venvPythonName),
    args: windows ? [] : [consoleScript], env: { VIRTUAL_ENV: venvDir }, prependPath: path.join(venvDir, venvBin) };
  fs.writeFileSync(path.join(stage, 'bin', launcherName), launcherText(entry, windows));
  applyExecutableMode(path.join(stage, 'bin', launcherName));
  const binaries = [launcherName];
  return {
    entry,
    provenance,
    binaries,
    launcherName,
    method: 'python venv',
    // Console scripts (including Windows .exe launchers) embed the interpreter
    // path. Build the environment here, never in a staging path that will move.
    initialize: async () => {
      ctx.log(`creating virtualenv in ${venvDir} (${platformOs})`);
      const venv = await runCommand(ctx, python.command, [...python.args, '-m', 'venv', venvDir], 'stream');
      if (venv.error !== undefined || venv.status !== 0) {
        throw new InstallError(
          'VENV_FAILED',
          `${python.label} -m venv failed. Make sure the venv module is available (Debian/Ubuntu: 'apt install python3-venv'; macOS: 'brew install python3'; Windows: the python.org build bundles it) and that ${prefix} is writable.`,
        );
      }
      const venvPython = path.join(venvDir, venvBin, venvPythonName);
      if (!isExecutable(venvPython)) {
        throw new InstallError(
          'VENV_LAYOUT',
          `the virtualenv at ${venvDir} does not contain ${venvBin}/${venvPythonName}, which is what platform '${platformOs}' expects. Remove it and retry with a CPython 3 build from python.org or your distribution.`,
        );
      }
      const installArgs = manifest.install.slice(2);
      if (options.version !== undefined && options.version !== 'latest') {
        const requested = options.version.replace(/^v/, '');
        if (!/^[0-9][A-Za-z0-9.!+_-]*$/.test(requested)) {
          throw new InstallError('INVALID_VERSION', `invalid PyPI package version: ${options.version}`);
        }
        const index = installArgs.indexOf(packageName);
        installArgs[index] = `${packageName}==${requested}`;
      }
      ctx.log(`running pip install for ${manifest.id} into ${venvDir}`);
      const install = await runCommand(ctx, venvPython, ['-m', 'pip', 'install', ...installArgs], 'stream');
      if (install.error !== undefined || install.status !== 0) {
        throw new InstallError('PIP_FAILED', `pip install failed using ${python.output} (${python.label}). Check the pip output, declared package dependencies and minimum Python version for ${manifest.id}; install a compatible Python 3 and select it with DECX_PYTHON if needed.`);
      }
      const versionResult = await runCommand(ctx, venvPython, ['-c', `import importlib.metadata; print(importlib.metadata.version(${JSON.stringify(packageName)}))`], 'capture');
      const installedVersion = versionResult.stdout.trim();
      if (versionResult.error !== undefined || versionResult.status !== 0 || installedVersion === '') {
        throw new InstallError('PACKAGE_VERSION', `could not determine installed version of ${packageName} in ${venvDir}`);
      }
      if (!isExecutable(consoleScript)) {
        throw new InstallError('ENTRY_MISSING', `${manifest.id} did not install its declared console script: ${consoleScript}`);
      }
      const args = verifyArgs(manifest);
      if (args.length > 0) {
        const result = await runCommand(ctx, consoleScript, args, 'capture');
        if (result.error !== undefined || result.status !== 0) {
          throw new InstallError('VERIFY_FAILED', `${manifest.id} verification failed: ${firstLine(result) || result.error || 'no output'}`);
        }
      }
      const entries: Array<[string, string]> = [
        ['tool', manifest.id],
        ['installer', 'decx install'],
        ['install_method', 'python venv'],
        ['installed', isoTimestamp()],
        ['install_command', ['pip', 'install', ...installArgs].join(' ')],
        ['version', installedVersion],
        ['platform', ctx.platform ?? platformOs],
        ['python', `${python.output} (${python.label})`],
        ['python_manager', 'pip'],
        ['venv', path.join(venvDir, venvBin, venvPythonName)],
        ['binaries', binaries.join(' ')],
        ['bin_dir', binRoot(ctx.home)],
        [
          'launcher',
          `${path.join(binRoot(ctx.home), launcherName)} -> ${consoleScript}`,
        ],
      ];
      Object.assign(provenance, Object.fromEntries(entries));
    },
  };
}

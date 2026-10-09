import * as fs from 'node:fs';
import * as path from 'node:path';
import { toolPrefix } from './config.ts';
import type { CommandSpec } from './runner.ts';

/** Installed executable and its fixed arguments; never a shell command line. */
export interface LaunchEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  prependPath?: string;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cmdQuote(value: string): string {
  if (/["\r\n\0]/.test(value)) throw new Error('invalid Windows launcher value');
  return `"${value.replaceAll('%', '%%')}"`;
}

/** Human-facing PATH shim, generated from exactly the same data the manager executes. */
export function launcherText(entry: LaunchEntry, windows: boolean): string {
  const lines = windows ? ['@echo off', 'setlocal DisableDelayedExpansion'] : ['#!/bin/sh'];
  for (const [name, value] of Object.entries(entry.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid environment variable: ${name}`);
    lines.push(windows ? `set ${cmdQuote(`${name}=${value}`)}` : `export ${name}=${shellQuote(value)}`);
  }
  if (entry.prependPath !== undefined) lines.push(windows
    ? `set "PATH=${cmdQuote(entry.prependPath).slice(1, -1)};%PATH%"`
    : `export PATH=${shellQuote(entry.prependPath)}:"$PATH"`);
  const command = [entry.command, ...entry.args].map(value => windows ? cmdQuote(value) : shellQuote(value)).join(' ');
  lines.push(windows ? `${command} %*` : `exec ${command} "$@"`);
  if (windows) lines.push('exit /b %errorlevel%');
  return lines.join(windows ? '\r\n' : '\n') + (windows ? '\r\n' : '\n');
}

export function installedCommand(home: string, id: string, args: string[], env: NodeJS.ProcessEnv): CommandSpec {
  const file = path.join(toolPrefix(home, id), 'launch.json');
  let entry: LaunchEntry;
  try {
    entry = JSON.parse(fs.readFileSync(file, 'utf8')) as LaunchEntry;
    const environment = entry.env;
    if (entry === null || typeof entry.command !== 'string' || entry.command === '' ||
      !Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string') ||
      (environment !== undefined && (environment === null || Array.isArray(environment) || typeof environment !== 'object' ||
        Object.values(environment).some(value => typeof value !== 'string'))) ||
      (entry.prependPath !== undefined && typeof entry.prependPath !== 'string')) throw new Error('invalid launch entry');
  } catch (error) {
    throw new Error(`cannot read ${file}: ${(error as Error).message}; reinstall ${id}`);
  }
  const childEnv: NodeJS.ProcessEnv = {};
  for (const source of [env, { DECX_HOME: home }, entry.env ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      childEnv[process.platform === 'win32' ? key.toUpperCase() : key] = value;
    }
  }
  if (entry.prependPath !== undefined) childEnv.PATH = `${entry.prependPath}${path.delimiter}${childEnv.PATH ?? ''}`;
  return { command: entry.command, args: [...entry.args, ...args], env: childEnv, mode: 'inherit', windowsHide: false };
}

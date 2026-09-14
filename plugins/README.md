# DECX plugins

A DECX plugin is a module that implements local CLI workflows in JavaScript. The CLI runs the
plugin **in-process** in an embedded QuickJS engine (`quickjs-go`), so plugins
work on macOS, Linux and Windows without Node, npm, or any other external
runtime. The engine is linked through cgo, so a C toolchain is needed to build
the CLI (release binaries ship prebuilt per platform).

A plugin ships as **one compiled, self-contained `.js` file** that the
component's `decx.json` manifest points at. Plugins are authored in TypeScript
and bundled with esbuild; the toolchain is development-only and nothing of it
is needed at runtime.

## Layout

```
plugins/<id>/
  README.md          plugin documentation
  package.json       TypeScript + esbuild build (development only)
  tsconfig.json      compiles src/ and tests/ to dist/ for the test suite
  esbuild bundle     dist/ard-framework.js, the compiled plugin the CLI loads
  src/index.ts       entry point exporting handle()
  src/*.ts           plugin modules
  host/*.js          host module shims (fs, path, os, child_process, crypto)
  tests/             Node test suite (development only)
  dist/              build output (git-ignored)
```

The plugin's own `decx.json` manifest declares the plugin, how to download it
and everything runtime-related; it lives in the plugin directory and inside the
release archive:

```json
{
  "manifest": 1,
  "kind": "plugin",
  "id": "ard-framework",
  "description": "Android device and framework workflows",
  "release": {
    "source": "repo",
    "tag": "ard-framework-v{version}",
    "asset": "decx-ard-framework-plugin-{version}.zip",
    "checksums": "SHA256SUMS",
    "format": "zip"
  },
  "entry": "dist/ard-framework.js",
  "commands": [
    { "name": "device", "subcommands": [ { "name": "system-services", "args": [ /* … */ ] } ] },
    { "name": "framework", "subcommands": [ { "name": "collect" }, { "name": "process" } ] }
  ]
}
```

`entry` is the plugin's own file, relative to the module directory — both in a
source checkout and after an install. A `VERSION` file sits next to the
manifest and is what `decx module list` reports. A plugin declares its command
tree in `commands` (nested `subcommands`); the CLI reaches it with the global
selector flag as `decx -m/--module <id> <command>` (for example
`decx -m ard-framework framework collect`) instead of a remote endpoint, and
`decx -m <id>` alone prints the module's command list. Every module is selected
per invocation with `-m/--module`, so a plugin command always needs the flag.

## Install

Plugins are installed, not shipped with the CLI: `decx install` downloads
the `zip`/`tar.gz` archive named by the manifest's `release.asset` from the
GitHub release, extracts it into `$DECX_HOME/modules/<id>` and records the
release in the `VERSION` file (read back by `decx module list`). The archive
holds the plugin files at their module-relative paths plus the manifest and
version — `decx.json`, `VERSION`, `dist/ard-framework.js`, `README.md` — and
the default `ard-framework` module from the CLI's known table is installed
without `--module`:

```bash
decx install                          # default modules (jadx, ard-framework)
decx install --module ard-framework
decx self update --module ard-framework
```

Plugin bundles are platform independent, so a single archive serves every OS
and architecture: the plugin's own workflow
(`.github/workflows/release-ard-framework.yml`) builds the bundle, packs
`decx.json` + `VERSION` with it and attaches the archive plus a `SHA256SUMS`
asset to the `ard-framework-v*` release. The CLI only parses the manifests and installs/loads what that release publishes;
nothing in this directory is copied into a CLI distribution.

The CLI resolves the plugin directory like this:

1. `$DECX_HOME/modules/<id>/` (where `decx install` puts the bundle) — the
   shared module root, and an installed module always wins;
2. otherwise a source checkout: the closest `plugins/<id>/` on the way up
   from the explicit `--config` directory, the `decx` executable's directory
   and the working directory, or the `modules/`/legacy `plugins/`
   subdirectory of an explicit `--config <dir>`, so a checkout runs in place
   during development.

A module directory is only used when it contains a `decx.json` manifest, and a
plugin module that cannot be found fails with
``module <id> is not installed; run `decx install --module <id>` ``.

## Contract

The engine evaluates the compiled file in a fresh context and then calls the
plugin's global `handle` function (the esbuild build publishes it with a
`globalThis.handle = …` footer):

```js
globalThis.handle = function (request) {
  return { ok: true, data: { /* JSON-serializable */ } };
};
```

There is no module loader: the file must be self-contained (the build inlines
every relative import), and it reaches the host only through the `decx` global
described below.

The CLI applies the same context rules it documents for every other command:
`context.home` is `$DECX_HOME`, `context.cwd` is the CLI working directory, and
`context.pluginDir` is the resolved plugin directory.

### Request

```jsonc
{
  "protocol": 1,
  "command": ["framework", "collect"], // plugin-relative command path
  "args": { "oem": "acme", "serial": ["emulator-5554"] }, // string or string[]
  "positionals": ["com.example"],
  "context": { "home": "/home/me/.decx", "cwd": "/work", "pluginDir": "/.../plugins/ard-framework" }
}
```

### Response

```jsonc
{
  "ok": true,
  "data": { /* printed as the command's JSON result */ }
}
```

On failure return `{ "ok": false, "error": { "code": "...", "message": "...", "details": {} } }`
(typically by throwing an error carrying a `code` property and letting the
entry point's error mapping produce that envelope). The CLI prints the error and
exits non-zero.

A plugin returns data only: it never starts servers or opens sessions. When a
command produces a file (for example a packed framework jar), it reports the
path and the user decides what to do with it — opening a session stays in the
CLI (`decx session open`).

`handle` runs synchronously and must return a JSON-serializable object. Do not
use promises, timers, worker threads or network APIs — the embedded engine has
no event loop.

## Host API

The host installs a small, platform-independent subset of Node's standard
library on the `decx` global; the build aliases the bare `fs`, `path`, `os`,
`child_process` and `crypto` imports of the sources to shims that forward to it,
so plugin code keeps using ordinary Node imports while nothing is required at
runtime:

```ts
const { fs, path, crypto, child_process, os, protocol, pluginDir } = globalThis.decx;
```

| Module | Provided surface |
|---|---|
| `fs` | `readFileSync`, `writeFileSync`, `readSync`, `openSync`, `closeSync`, `readdirSync`, `statSync`, `lstatSync`, `existsSync`, `mkdirSync`, `mkdtempSync`, `rmSync`, `copyFileSync`, `renameSync`, `accessSync`, `constants` |
| `path` | `join`, `resolve`, `relative`, `normalize`, `dirname`, `basename`, `extname`, `isAbsolute`, `parse`, `format`, `sep`, `delimiter` |
| `child_process` | `spawnSync` (`encoding`, `cwd`, `timeout`, `input`, `maxBuffer`, `stdio` including numeric file descriptors) |
| `crypto` | `createHash(algorithm)` with `update` / `digest` (for example `createHash("sha256").update(data).digest("hex")`) |
| `os` | `tmpdir`, `platform`, `EOL` |

Relative paths in the `fs` module resolve against the CLI working directory, not
the plugin directory (that matches Node); use `path.join(pluginDir, …)` when
your plugin reads or writes files next to itself.

Globals: `Buffer` (`alloc`, `from`, `concat`, `isBuffer`, `byteLength` and the
usual read/write/decode methods), `console`, `process` (`env`, `platform`,
`argv`, `cwd()`, `stdout`, `stderr`, `exit`), `TextEncoder`, `TextDecoder`.

`console.log` / `console.error` and `process.stderr.write` go to the CLI's
standard error; `process.stdout.write` is accepted but ignored, because the
command result is the returned object, not stdout.

## Development

Plugins keep a Node test suite next to the sources and build with `tsc` (tests)
plus esbuild (the shipped bundle):

```bash
cd plugins/ard-framework
npm ci
npm run build            # typecheck + tsc + dist/ard-framework.js
node --test "dist/tests/*.test.js"
```

For a quick manual run the plugin sources still execute with Node: the test
suite and `node dist/src/index.js` (stdin mode) use Node's own modules. The
bundle itself is CLI-only — it reaches the host through the `decx` global, which
only the embedded runtime installs. `make -C decx build` and the release
workflows run the same build, so a checkout that runs plugins needs
`npm ci && npm run build` once (or `make plugins`).

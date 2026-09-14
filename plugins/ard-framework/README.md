# DECX ard-framework plugin

TypeScript implementation of the DECX **android device** and **android
framework** workflows, bundled into one self-contained JavaScript file and
loaded in-process by the CLI's embedded QuickJS engine. It replaces the packaged binaries that used to live
in `decx/native-tools/` and the native Go implementation that used to live
in `decx/internal/android/`; nothing is packaged with the plugin, every
external tool is resolved from `PATH`, and unsupported payloads are only
unpacked on Linux/macOS.

The plugin implements the in-process contract described in
`plugins/README.md`; `esbuild` bundles the compiled tree into
`dist/ard-framework.js`, the single file the CLI evaluates and from which it
calls the global `handle()` published by the bundle footer. The plugin's own
`decx.json` manifest points at that file (`entry: dist/ard-framework.js`) and
declares the platform-independent `decx-ard-framework-plugin-{version}.zip`
release asset installed into `$DECX_HOME/modules/ard-framework`, where the CLI
loads it from; a source checkout is used in place when no installed copy exists.

`handle()` validates the request, dispatches on `request.command.join(" ")` and
always returns the response envelope (`{ ok: true, data }` or
`{ ok: false, error: { code, message, details? } }`); diagnostics go to stderr.
For manual debugging the same entry point also runs on Node, reading one JSON
request from stdin and writing one JSON response to stdout:

```bash
node dist/src/index.js   # JSON request on stdin, one JSON response on stdout (debug only)
```

## Building

```bash
npm ci                        # typescript + @types/node + esbuild (development only)
npm run build                 # tsc -> dist/src/*.js, dist/tests/*.js; esbuild -> dist/ard-framework.js
npm run typecheck             # tsc --noEmit
```

The CLI loads the self-contained bundle `dist/ard-framework.js`: `tsc` still
compiles the CommonJS tree the tests run against, then `esbuild` inlines it into
one file and publishes `globalThis.handle`. The bundle resolves the host modules
`fs`, `path`, `os`, `child_process` and `crypto` through the shims in `host/`,
which read the `globalThis.decx` object the runtime installs before evaluating
the file — there is no `require()` and no `node_modules` at runtime. `dist/` is
git-ignored and rebuilt by `make -C decx plugins`, `make -C decx build`
and the release workflows; the DECX release workflow
(`.github/workflows/release-ard-framework.yml`) packs `dist/ard-framework.js` plus this
README into the published `decx-ard-framework-plugin-{version}.zip`.

## Command surface

Arguments are keyed by the ids in the plugin's own `decx.json` command
definitions; the bracketed aliases are also accepted by the plugin.

| Command | Positional | Arguments | `data` |
| --- | --- | --- | --- |
| `device system-services` | – | `grep`, `adb-path`, `serial` | `{ services: [{ name, rawInterfaces }] }` |
| `device permission-info` | `permission` | `adb-path`, `serial` | `{ name, description, protectionLevel, group, rawInterfaces }` |
| `framework collect` | – | `adb-path`, `serial`, `out-dir` [`output`], `source-dir` [`input`], `clean-source` [`clean`] | `{ artifact, layout, collection }` |
| `framework process` | `oem` | `adb-path`, `serial`, `out-dir` [`output`], `source-dir` [`input`], `clean-source` [`clean`] | `{ artifact, layout, process, pack }` |

Responses use the shared envelope: `{ "ok": true, "data": … }` or
`{ "ok": false, "error": { "code", "message", "details? } }`. Failures carry
codes such as `ADB_DEVICE_MISSING`, `ADB_DEVICE_AMBIGUOUS`, `ADB_NOT_FOUND`,
`MISSING_OEM`, `ARTIFACT_NOT_FOUND`, `INVALID_LAYOUT`, `INVALID_ARTIFACT`,
`TOOL_NOT_FOUND`, `PROCESS_FAILED`, `INVALID_PARAMETER`,
`INVALID_REQUEST` and `INTERNAL_ERROR`. `handle()` never writes to stdout —
progress and failures are logged to stderr — so the embedded engine reads the
command result from the returned object; only the debug script mode writes the
response to stdout.

### Opening the packed jar

The plugin only collects, processes and packs; it never spawns a JVM and never
calls the `decx` binary. What `process` packed is opened with the CLI's own
session command:

```bash
decx -m ard-framework framework process acme
decx session open "$DECX_HOME/output/framework/acme/framework_acme_pixel.jar"
```

`data.pack.jarPath` (and `data.artifact.jarPath`) carry the packed jar path;
`--name` on `decx session open` overrides the derived
`framework_<oem>_<vendor>` session name. The plugin exposes no `--module`,
`--port` or `--name` argument.

## External tools

| Tool | Used for | Resolution |
| --- | --- | --- |
| `adb` | device probing and `pull` | `--adb-path`, then `DECX_ADB`, then `PATH` |
| `debugfs` | ext4 APEX payload fallback | `DECX_DEBUGFS`, then `PATH` (Linux/macOS only) |
| `extract.erofs` / `fsck.erofs` | EROFS APEX payload fallback | `DECX_EXTRACT_EROFS` / `DECX_FSCK_EROFS`, then `PATH` (Linux/macOS only) |
| `unzip` / `zip` | jar/apk/apex container I/O (POSIX) | `PATH` |
| `C:\Windows\System32\tar.exe` (bsdtar) | container I/O on Windows | fixed path, no `zip`/`unzip` needed |

ext4 and EROFS payload images are parsed by the bundled native readers
(`src/ext4-reader.ts`, `src/erofs-reader.ts`); `debugfs` and erofs-utils are
only fallbacks for images the readers reject. Neither tool has a native Windows
binary, so on Windows those payloads report an actionable error asking to run
`framework process` on Linux/macOS instead of being unpacked.

## On-disk layout

```text
<out-dir>/                        $DECX_HOME/output/framework/<oem> by default
  .artifact.json                  { name, oem, vendor, rootDir, jarPath, updatedAt }
  source/                         raw pulls (tiered roots, apex modules)
  out_tmp/                        processed dex files (staged, then swapped in)
  framework_<oem>_<vendor>.jar    packed artifact (manifest + all dex entries)
```

Processing is atomic: each input is expanded in a `.input-*` temp dir inside
`out-dir`, the results are staged, and `out_tmp` is replaced only when every
input succeeded (the old directory moves to `out_tmp.previous`). `--clean-source`
deletes `source/` after `process`; `collect` never cleans.

## Behavior notes and deviations

- Collection follows the Go implementation: the roots `/system/framework`,
  `/apex`, `/vendor/framework`, `/system_ext/framework` and `/system/apex` are
  pulled tier by tier, already-pulled `apex/<module>/…` layouts mark modules as
  covered (`skippedCoveredModules`), and `/system/apex` images are only taken for
  modules the runtime `/apex` mount did not expose.
- `oem`/`vendor` are normalized but not validated against a fixed list (Go
  semantics); `--oem` is required for offline processing when `.artifact.json`
  does not already record it. The vendor comes from `ro.product.model` via adb
  and defaults to `unknown` offline.
- Archive creation replaces an existing archive instead of updating it, so a run
  can never merge entries into a stale package (Info-ZIP would).
- The ext4 reader follows symlinks that point at regular files (APEX payloads
  link jars/dex into place) and skips `lost+found`, dangling links and
  non-regular inodes.
- There is no `--module`, `--port` or `--name` argument: the plugin only
  produces a jar, and `decx session open` owns the session.

## Development

```bash
npm ci
npm run build
node --test "dist/tests/*.test.js"   # unit tests on the tsc output (Node's built-in runner)
```

Tests cover the ext4 and EROFS readers (images are synthesized in-code except
for one committed EROFS fixture), container I/O, tool resolution, and the full
collect → process → pack workflow. The plugin is TypeScript with no runtime
dependencies beyond the host API the engine provides; `tsc` emits the CommonJS
tree the tests run against, and `esbuild` bundles that tree into the single
`dist/ard-framework.js` artifact the runtime evaluates and from which it calls
the global `handle()`. Relative `require()` calls are inlined by the bundler and
`fs`/`path`/`os`/`child_process`/`crypto` are aliased to the `host/` shims, so
the bundle needs no module loader. Node, npm, TypeScript and esbuild are only
needed to build and test.

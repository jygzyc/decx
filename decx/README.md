# decx -- toolkit installer and manager

DECX is not a decompiler and not a wrapper around one.  This CLI installs and manages
the native analysis tools the DECX skills drive (`droidasc`, `kuna`, `afe`), so an agent
can go from a bare machine to a working toolkit with one command.  The tools stay where
they belong: upstream releases where they exist, `third_party/` checkouts where DECX is
the maintainer.

- **Node only.** No runtime dependencies, no build step: Node 24.21+ runs the
  `.ts` sources directly, so the CLI cannot break because a bundler or a
  `node_modules` tree drifted.
- **JSON by default.** Every data command prints one JSON object on stdout; the
  consumer is an agent.  `--pretty` is for humans.
- **Never installs runtimes.** A tool that needs Python or Rust is checked at
  install time, and the exact shortfall is reported instead of installed.

## Source layout

- `src/cli.ts`: command dispatch, JSON responses and process entry point.
- `src/args.ts`: manager flags and the `-m` pass-through boundary.
- `src/launch.ts`: platform-specific subprocess invocation.
- `src/install.ts`: release resolution, staging, verification and atomic install.
- `src/remove.ts`: uninstall using recorded binary ownership.
- `src/config.ts`, `src/links.ts`, `src/inspect.ts`: install paths, PATH entries and state.
- `src/manifest.ts`, `src/gh.ts`, `src/archive.ts`: tool declarations and release assets.

## Usage

```console
$ decx install kuna          # download the release and link the launcher
$ decx update kuna           # replace it with the newest matching GitHub release
$ decx kuna --help           # exec the installed launcher, args untouched
$ decx -m kuna --help        # equivalent explicit form
$ decx remove kuna           # remove its payload, runtime and managed links
$ decx version               # CLI version
$ decx help install          # help for the manager or one command
```

Exit codes: `0` success, `1` a check failed or a runtime error, `2` usage error.
Failures use the DECX envelope:

```json
{"ok":false,"command":"install","error":{"code":"UNKNOWN_TOOL","message":"unknown tool: nope","hint":"run `decx help`"}}
```

`decx install <tool>` resolves the host platform from the manifest and either
installs the pinned release asset -- downloaded to a temp dir and
sha256-verified against the manifest-declared checksum asset (a missing or
unreadable declared checksum aborts installation),
with any release `extraAssets` (Kuna's compiled SLEIGH specs) downloaded
alongside.  A manifest that pins `release.version` is what an install
reproduces: that is the tag whose asset names were verified against upstream,
and upstream renames files between releases (Kuna's archives gained a `v` in the
file name in v1.508); `--version <tag>` installs one specific tag instead.
`decx install droidasc` creates a fresh `runtime/droidasc` virtualenv and
runs `pip install droidasc` inside it. The published PyPI package supplies the
entry point and dependencies: no vendored checkout, source archive or GitHub
release is needed. `--version <version>` pins the PyPI distribution; `update`
installs the latest available package. `share/droidasc` holds only PROVENANCE. Python environments are initialized at their
final install path, so dependency console scripts never retain a temporary
interpreter path. The previous payload and executables remain backed up until
environment initialization, verification and PROVENANCE writing succeed;
a failure restores them and the previous private runtime.

`decx update <tool>` installs the latest PyPI distribution for a direct pip
recipe, or resolves the latest matching GitHub release for an archive recipe,
then replaces the installed version. `decx remove <tool>` deletes its recorded executables,
payload and private runtime, removing only PATH links still pointing to its
managed launcher. Both support `--home`; update accepts `--version <tag>`.

`decx install afe` uses a prebuilt `tools-v*` archive for the platform.
A missing release asset currently fails; this manager does not yet provide
an automatic cargo fallback.

Installing also links the tool's executables into `~/.local/bin` (change with
`--links <dir>` or `$DECX_LINKS_DIR`, suppress with `--no-links`): a symlink on
macOS and Linux, a generated `.cmd` shim on Windows.  A file that decx did not
create is never replaced -- the install reports the conflict unless `--force`
asks for it. With `--force`, overwritten foreign executables are retained in a
`.decx-overwritten-<tool>-*` directory under `$DECX_HOME`; an existing
`share/<tool>` without matching PROVENANCE is never replaced. No command edits shell startup files, and the JSON result reports
whether the link directory is on `PATH` together with the line to add when it is
not. PATH links are set up after the core install commits; link conflicts or
setup failures produce warnings without undoing the installed tool. The tool
remains callable with `decx <tool>`.
`decx <tool> [args...]` (or `decx -m <tool> [args...]`) reads the installed
`share/<id>/launch.json` and executes its real executable and argv directly,
with every argument after the tool id passed through unchanged,
inherits stdio and forwards the exit code; it never translates analysis
commands. The selected install root is passed as `DECX_HOME`. Python launchers
initialize `VIRTUAL_ENV` and prepend the private interpreter directory to `PATH`,
so the installed package works without activating a shell.
These changes apply only to the launched process and its children.  Options before the module (`--home`, `--third-party`, `--pretty`)
belong to decx, so `decx -m kuna --version` asks Kuna for its version.

The portable `decx-tool` skill works without any pi extension: install the CLI
and point an Agent Skills-compatible harness at its standalone `SKILL.md` and
`references/` directory. The manager does not install plugins or copy skills
into `$DECX_HOME`. Pi users may instead download the separate
`decx-pi-<version>.tar.gz` release bundle, unpack it, and `pi install` its
extracted directory to load the wiki extension. Run `/decx init` inside a
project to initialize `.decxwiki` and install the bundled execution skills into
that project's `.agents/skills/`, without cloning this repository.

## Layout

```
decx/
├── src/
│   ├── cli.ts          argument parsing, dispatch, output envelope
│   ├── platform.ts     `win`/`darwin`/`linux` × `arm64`/`amd64` platform keys
│   ├── config.ts       DECX_HOME resolution and paths
│   ├── manifest.ts     tool manifest schema, loading and validation
│   ├── gh.ts           GitHub release resolution and asset downloads
│   ├── archive.ts      tar.gz/zip extraction, no external tools
│   ├── install.ts      install orchestration: resolve, verify, stage, commit
│   ├── links.ts        PATH links: symlinks on POSIX, `.cmd` shims on Windows
│   ├── inspect.ts      install state: launcher and PROVENANCE
│   └── json.ts         success/failure envelopes and pretty printing
└── tests/              node:test suite (run against the .ts sources)
```

One manifest per tool lives inside that tool's subproject —
`third_party/decx-<id>/decx-<id>.json` — so the manager's tool list is exactly the
subproject list.

Installs live under `$DECX_HOME` (default `~/.decx`; `--home`, alias
`--prefix`, overrides it):

```
$DECX_HOME/bin/<name>                executables of every managed tool (`.exe`/`.cmd` on Windows)
$DECX_HOME/share/<id>/PROVENANCE     what was installed, from where
$DECX_HOME/share/<id>/launch.json    executable, fixed argv and environment
$DECX_HOME/runtime/<id>/               Python virtualenvs
$DECX_HOME/share/<id>/...            runtime resources, if needed (not Python source)
$DECX_HOME/share/kuna/specs/         Kuna's SLEIGH specs
~/.local/bin/<name> -> $DECX_HOME/bin/<name>     PATH link (see --links)
```

Executables live in one store so that tools sharing helper binaries -- Kuna's
`decomp_dbg` and `slacomp` next to `kuna` -- are linked together; the payloads
stay in per-tool directories.  The earlier `scripts/install-*.sh` layout
(`$DECX_HOME/tools/<id>`) is no longer detected or migrated; the manager only
reads installs that follow the layout above.

## Tool manifests

A manifest is data, never code; adding a tool means adding a JSON file.

```json
{
  "manifest": 2,
  "summary": "Native decompiler for ELF/PE/Mach-O (upstream Kuna)",
  "install": ["github-release"],
  "launch": { "type": "bin", "commands": ["kuna", "decomp_dbg", "slacomp"] },
  "env": { "KUNA_SPECS": "{prefix}/specs" },
  "release": {
    "repository": "Noelo-Lab/kuna",
    "tagPrefix": "v",
    "checksums": null,
    "assets": { "darwin-arm64": "kuna-v{version}-macos-arm64.tar.gz" },
    "extraAssets": { "specs": "kuna-v{version}-specs.tar.gz" }
  },
  "verify": "--version"
}
```

Every tool JSON uses the same [JSON Schema](../third_party/decx-tool.schema.json) for editor completion. `src/manifest.ts` validates cross-field recipe rules; no separate schema is needed for each runtime.

| Field | Meaning |
|---|---|
| `summary` | one-line tool description |
| `release` | required for `bin` and `js`, omitted for PyPI packages. The install source: `repository` (`owner/repo`, default `jygzyc/decx`), `version` (`latest` or an exact version/tag), `tagPrefix` (default `<id>-v`), exactly one of `asset` (a single template) or `assets` (per-platform names); `{version}`, `{os}` and `{arch}` are substituted at install time. `checksums` names the `sha256  filename` asset (`<id>-SHA256SUMS.txt` by default); `null` instead requires a SHA-256 digest in GitHub REST asset metadata for **every** download. `extraAssets` are downloaded for every platform (Kuna's compiled SLEIGH specs) |
| `install` | required installer recipe: `["github-release"]` downloads and verifies the archive described by `release`; `["pip", "install", "droidasc"]` installs a published PyPI package (no shell). Python source-checkout/archive recipes are not supported. The manager creates the Python virtual environment itself; manifests do not contain venv commands. `--version` pins PyPI packages using `==`. Python source checkouts are not copied into `share/`; JS release assets retain their module tree under `share/<id>/app` |
| `env` | `bin` tools only: environment the generated launchers export (`{prefix}` = the payload directory, `{version}` = the installed version); declaring it moves the binaries to `share/<id>/bin` and puts wrappers in `bin/` |
| `launch` | required object with `type` (`bin`, `python` or `js`) and `commands` (nonempty list of public command names). The first command is the default for `decx -m <tool>`. For `bin`, the release archive contains each executable; for `python`, the manager generates a wrapper to the venv console script; for `js`, the release archive contains `<command>.mjs`, `.cjs` or `.js` and the manager keeps the archive tree in `share/<id>/app` (including local imports and `package.json`), generating Node launchers (`.cmd` on Windows). JS installs require `node` on PATH. |
| `verify` | the probe command run against the staged executable or Node script before committing, e.g. `--version` |
| `requires` | runtime floors `install` checks before staging anything (`{ "python": ">=3.10" }`; Python tools only) |

The venv install records the interpreter it used in PROVENANCE (`python`), the
manager that installed the package (`python_manager`) and the interpreter
path it will run (`venv`).

The tool `id` is derived; `repository`, `tagPrefix`, `version` and `checksums` have defaults. Manifests declare only values that differ from those defaults — `launch.type` selects the
tool runtime; the tool id is the subproject
directory name without the `decx-` prefix. Platforms are two axes joined as
`<os>-<arch>`: `win`, `darwin`, `linux` × `arm64`, `amd64` (e.g. `darwin-arm64`,
`win-amd64`); an `assets` map may additionally use `any` for a
platform-independent payload. For archive recipes, `--version <tag>` picks a
release explicitly; otherwise `release.version` selects a tag (default
`latest`, resolved through GitHub REST). For PyPI recipes, `--version` pins a
package version and the default is the newest available version. `update`
selects the latest unless `--version` is specified. There is no checkout detection, source fallback, old manifest migration or
legacy launch-record fallback. An install missing `launch.json` must be reinstalled.

## Development

```console
$ npm ci                      # dev deps only (esbuild, typescript, @types/node)
$ npm test                    # offline CLI functional tests: install/run/update/remove and actual artifacts
$ npm run typecheck           # tsc --noEmit
$ node src/cli.ts version
```

### Real analyzer functional acceptance

`npm test` alone does **not** prove decompilation works. Install the actual
upstream tools into an explicit isolated prefix, build the manager, then run
`npm run test:functional` with `DECX_HOME` pointing at that prefix:

```console
$ node src/cli.ts install droidasc --home /tmp/decx-functional --no-links
$ node src/cli.ts install kuna --home /tmp/decx-functional --no-links
$ npm run build
$ DECX_HOME=/tmp/decx-functional npm run test:functional
```

On PowerShell, use `$env:DECX_HOME` and a unique directory under `$env:TEMP`.
Installation uses real PyPI/GitHub distributions and may access the network;
the tests themselves do not download or install tools. Missing prerequisites
fail rather than silently skipping. A host C compiler is required (`cc` on
macOS/Linux; `cl` in a Visual Studio developer environment on Windows).

- DroidASC decodes the existing real Sieve APK's binary manifest, enumerates
  DEX classes, decompiles the SQL provider to Java and locates a real URI
  reference. Written files, class-name normalization and missing-class errors
  are checked through subprocesses, not imported analyzer functions.
- Kuna analyzes a freshly compiled real Mach-O/ELF/PE executable, exports a
  project, recompiles the recovered C and compares its execution with the
  original on seven branch/negative inputs. This checks semantics, not just
  exit status or whether output contains `return`.
- `test:functional:droidasc` and `test:functional:kuna` select one suite. The
  existing tool workflows run these gates on Linux, macOS and Windows using
  real installed tools; no mocks replace them. Manager security/rollback cases
  also run through actual CLI subprocesses. No suite imports manager functions
  or mocks Node builtins.

Set `DECX_FUNCTIONAL_MANAGER` to an absolute built native manager executable
to run the same functional suite through scriptc instead of `dist/decx.mjs`.
The test prefix must be explicit; never install into the user's real home.
Fixture origins and hashes are documented in `tests/fixtures/real-analysis/`.

## Single-file release

`npm run build` produces **`dist/decx.mjs`**, a single Node 24.21+ executable
with the package version and all tool manifests embedded by esbuild. Copy that
file anywhere and run `node decx.mjs version` or `node decx.mjs help`: no adjacent
package.json, manifests, node_modules or runtime temporary manifests are needed.
Node itself and the tools being installed are not bundled.

`npm run pack` archives that executable plus LICENSE and this README as
`artifacts/decx-<version>.tar.gz`, with `decx-SHA256SUMS.txt` alongside it.
After extracting, run `node decx-<version>/decx.mjs install <tool>`.
`npm run build` also runs an offline smoke check by copying only the executable
into a temporary empty directory and checking version, help, tool discovery and
the `--third-party` override.

Direct source execution (`node src/cli.ts …`) still reads package.json and the
repository's `third_party/`. In either mode, `--third-party <dir>` replaces the
default manifest set with that directory's manifests; it does not merge them.

## scriptc native manager

On Node 24.21+, run `npm run setup:scriptc` to install scriptc 0.2.7 into
`.scriptc-toolchain/`. `scriptc.json` pins the official
GitHub Release SDK and each host archive's SHA-256 digest. Setup verifies before
extracting, checks the compiler version, and stages replacement atomically.
It executes no npm lifecycle scripts and records the source in `SOURCE.json`.
This build-time SDK is separate from the manager's `npm ci`. The SDK retains its
upstream compiler filename (`bin/scriptc`, or `bin/scriptc.exe` on Windows).
Updating the pin requires updating every archive digest and rebuilding the
matching runtime; scriptc 0.2.7 uses runtime ABI v8. To use an HTTP proxy,
set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` for the setup command only.

`npm run build:scriptc` stages the typed manager sources, embeds the version
and manifests, and invokes the native compiler with `--dynamic`. It does not
compile erased esbuild output or launch an external Node interpreter. Successful
builds must pass smoke checks with Node absent from PATH outside the checkout.

All compiler commands live in `scripts/scriptc.mjs` (`setup`, `build`, `tool`).
There is no separate toolchain project or test-launcher script. The native
runtime suite is explicit (`tests/native-runtime.e2e.ts`); missing prerequisites
fail rather than silently skipping.

`npm run test:native` tests the resulting manager with Node absent from its
PATH: verified tar.gz/zip installation, cross-origin redirect authentication,
environment launchers and argument preservation, update, checksum failure and
rollback, removal, and a real Python venv installing a local wheel. All prefixes,
links and caches are temporary; pip cannot use the network. These tests have
passed locally on macOS arm64. Branch and release CI run compilation and the
same native tests on Linux x64/arm64, macOS arm64 and Windows x64; a platform
must pass before its native artifact is published.

Node and native builds use the same source modules and one shell-free process
runner. The compiler stages only version/manifests and the entry point; it does
not substitute application adapters. Installation records a real executable,
fixed argv and environment in `launch.json` inside the rollback transaction.
User-facing shell/`.cmd` launchers remain available on PATH but the manager never
executes them. There is no `src/native/`, custom Win32 process bridge or runtime
sidecar. Windows native executables embed `scripts/windows.manifest` for UTF-8
paths/environment and long paths (Windows 10 1903+ or Windows Server 2022+).
DECX's build script uses Zig only to compile that executable resource. `--dynamic` embeds
scriptc's own dynamic engine for unsupported static operations, not Node.

```console
$ npm run setup:scriptc
$ npm run build:scriptc
$ npm run test:native
# Or run the complete compiler + independent-tool + manager gate:
$ npm run check:native
```

## Independent TypeScript tools (scriptc)

With Node 24.21+ on the **build** machine, run `npm run setup:scriptc`, then
`npm run compile:ts-tool -- <tool.ts> -o <tool>` (use `<tool>.exe` on Windows). Package the resulting
executable as a verified release asset and declare `launch.type: "bin"` in the
tool manifest. DECX installs and invokes that native binary without Node at
runtime. `tests/scriptc-tool.e2e.ts` compiles a real TS fixture, serves a
checksum-protected archive locally, then installs and executes it through
`decx -m` without network access. scriptc 0.2.7 publishes native compilers
for macOS x64/arm64, Linux x64/arm64 and Windows x64; Windows arm64 remains
unsupported. CI tests independent tool compilation on the same four hosts as
the native manager; macOS x64 is not part of the release matrix. Because scriptc is installed separately for builds,
the manager's lockfile and `npm ci` do not depend on its platform packages.

Adding a tool: create `third_party/decx-<id>/` with its own `README.md` and the
`decx-<id>.json` manifest (the tool id is the subproject directory name without the
`decx-` prefix), add its contract to `skills/decx-tool/` (a routing-gate row in
`SKILL.md` plus `references/<id>.md`), then run `npm test` — the manifest tests load
every manifest under `third_party/` and hold each shipped manifest to the platform,
release-asset and launcher rules.  The skill is validated by
`python3 skills/check-skills.py`, which validates the packaged execution skills.

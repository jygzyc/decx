# decx -- toolkit installer and manager

DECX is not a decompiler and not a wrapper around one.  This CLI installs and manages
the native analysis tools the DECX skills drive (`droidasc`, `kuna`, `afe`), so an agent
can go from a bare machine to a working toolkit with one command.  The tools stay where
they belong: upstream releases where they exist, `subprojects/` checkouts where DECX is
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
`decx <tool> [args...]` (or `decx -m <tool> [args...]`) executes the installed
launcher with every argument after the tool id passed through unchanged,
inherits stdio and forwards the exit code; it never translates analysis
commands. The selected install root is passed as `DECX_HOME`. Python launchers
initialize `VIRTUAL_ENV` and prepend the private interpreter directory to `PATH`,
so the installed package works without activating a shell.
These changes apply only to the launched process and its children.  Options before the module (`--home`, `--subprojects`, `--pretty`)
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
`subprojects/decx-<id>/decx-<id>.json` — so the manager's tool list is exactly the
subproject list.

Installs live under `$DECX_HOME` (default `~/.decx`; `--home`, alias
`--prefix`, overrides it):

```
$DECX_HOME/bin/<name>                executables of every managed tool (`.exe`/`.cmd` on Windows)
$DECX_HOME/share/<id>/PROVENANCE     what was installed, from where
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

Every tool JSON uses the same [JSON Schema](../subprojects/decx-tool.schema.json) for editor completion. `src/manifest.ts` validates cross-field recipe rules; no separate schema is needed for each runtime.

| Field | Meaning |
|---|---|
| `summary` | one-line tool description |
| `release` | required for `bin`, `js` and `{source}` recipes, omitted for direct PyPI packages. The install source: `repository` (`owner/repo`, default `jygzyc/decx`), `version` (`latest` or an exact version/tag), `tagPrefix` (default `<id>-v`), exactly one of `asset` (a single template) or `assets` (per-platform names); `{version}`, `{os}` and `{arch}` are substituted at install time. `checksums` names the `sha256  filename` asset (`<id>-SHA256SUMS.txt` by default); `null` instead requires a SHA-256 digest in GitHub REST asset metadata for **every** download. `extraAssets` are downloaded for every platform (Kuna's compiled SLEIGH specs) |
| `install` | required installer recipe: `["github-release"]` downloads and verifies the archive described by `release`; `["pip", "install", "droidasc"]` installs a published PyPI package (no shell). `{source}` recipes instead install a checked source archive or pinned checkout and require `release`. The manager creates the Python virtual environment itself; manifests do not contain venv commands. `--version` pins PyPI packages using `==`. Python source checkouts are not copied into `share/`; JS release assets retain their module tree under `share/<id>/app` |
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
selects the latest unless `--version` is specified. For a Python checkout
recipe, an explicit `--version` must match the checkout's exact tag;
a mismatch or an untagged checkout is rejected rather than silently ignoring
the requested version.

## Development

```console
$ npm ci                      # dev deps only (esbuild, typescript, @types/node)
$ npm test                    # offline JS, Python wheel/venv and native binary install + decx -m tests
$ npm run typecheck           # tsc --noEmit
$ node src/cli.ts version
```

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
the `--subprojects` override.

Direct source execution (`node src/cli.ts …`) still reads package.json and the
repository's `subprojects/`. In either mode, `--subprojects <dir>` replaces the
default manifest set with that directory's manifests; it does not merge them.

## scriptc native manager

On Node 24.21+, run `npm run setup:scriptc` to install scriptc 0.2.6 into
`.scriptc-toolchain/`. Its complete dependency graph is locked separately in
`toolchains/scriptc/package-lock.json`; setup uses `npm ci` with lifecycle
scripts disabled, then explicitly runs scriptc's native compiler setup.
It is a build-time dependency, separate from the manager's `npm ci`.

`npm run build:scriptc` stages the typed manager sources, embeds the version
and manifests, and invokes the native compiler with `--dynamic`. It does not
compile erased esbuild output or launch an external Node interpreter. Successful
builds must pass smoke checks with Node absent from PATH outside the checkout.

`npm run test:native` tests the resulting manager with Node absent from its
PATH: verified tar.gz/zip installation, cross-origin redirect authentication,
environment launchers and argument preservation, update, checksum failure and
rollback, removal, and a real Python venv installing a local wheel. All prefixes,
links and caches are temporary; pip cannot use the network. These tests have
passed locally on macOS arm64. Branch and release CI run compilation and the
same native tests on Linux x64/arm64, macOS arm64 and Windows x64; a platform
must pass before its native artifact is published.

Source adaptations are build-only: namespace imports, native fetch with shared
redirect/download verification policy, explicit filesystem copy/link handling,
and typed callbacks. Node source execution retains its HTTP adapter. Windows
links a small `CreateProcessW` FFI implementation into the same executable so
`.cmd` arguments retain their existing escaping; building that bridge requires
Zig on PATH (CI pins Zig 0.16.0, matching upstream's Windows runtime-pack ABI). No bridge binary,
Node interpreter or JavaScript sidecar is needed at runtime. `--dynamic` embeds
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
runtime. `tests/scriptc-tool.test.ts` compiles a real TS fixture, serves a
checksum-protected archive locally, then installs and executes it through
`decx -m` without network access. scriptc 0.2.6 publishes native compilers
for macOS x64/arm64, Linux x64/arm64 and Windows x64; Windows arm64 remains
unsupported. CI tests independent tool compilation on the same four hosts as
the native manager; macOS x64 is not part of the release matrix. Because scriptc is installed separately for builds,
the manager's lockfile and `npm ci` do not depend on its platform packages.

Adding a tool: create `subprojects/decx-<id>/` with its own `README.md` and the
`decx-<id>.json` manifest (the tool id is the subproject directory name without the
`decx-` prefix), add its contract to `skills/decx-tool/` (a routing-gate row in
`SKILL.md` plus `references/<id>.md`), then run `npm test` — the manifest tests load
every manifest under `subprojects/` and hold each shipped manifest to the platform,
release-asset and launcher rules.  The skill is validated by
`python3 skills/check-skills.py`, which validates the packaged execution skills.

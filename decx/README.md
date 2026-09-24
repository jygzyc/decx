# decx -- toolkit installer and manager

DECX is not a decompiler and not a wrapper around one.  This CLI installs and manages
the native analysis tools the DECX skills drive (`droidasc`, `kuna`, `afe`), so an agent
can go from a bare machine to a working toolkit with one command.  The tools stay where
they belong: upstream releases where they exist, `subprojects/` checkouts where DECX is
the maintainer.

- **Node only.** No runtime dependencies, no build step: Node 22.18+ runs the
  `.ts` sources directly, so the CLI cannot break because a bundler or a
  `node_modules` tree drifted.
- **JSON by default.** Every data command prints one JSON object on stdout; the
  consumer is an agent.  `--pretty` is for humans.
- **Never installs runtimes.** A tool that needs Python or Rust is checked at
  install time, and the exact shortfall is reported instead of installed.

## Usage

```console
$ decx install kuna          # download the release and link the launcher
$ decx -m kuna --help        # exec the installed launcher, args untouched
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
`decx install droidasc` needs no download: it builds a private venv over
`subprojects/decx-droidasc/source` and installs a self-contained payload under
`share/droidasc/`.  The environment is created fresh in `share/droidasc/.venv`
with the Python the manifest's `requires` selects -- an environment that is
already there is refused, never reused -- and `requirements.txt` goes in with
`uv pip install` when a `uv` is on `PATH` (or reachable as `pipx run uv`),
otherwise with the interpreter's own `pip`.  When there is no checkout to build
from -- a packaged CLI, or a clone that never initialised submodules -- the
install falls back to the release's source archive, verifies its checksum and
builds the same payload from it. Python environments are initialized at their
final install path, so dependency console scripts never retain a temporary
interpreter path. The previous payload and executables remain backed up until
environment initialization, verification and PROVENANCE writing succeed;
a failure restores them.

`decx install afe` uses a prebuilt `tools-v*` archive when one
carries an AFE build for the platform, and otherwise builds
`subprojects/decx-afe` with cargo.

Installing also links the tool's executables into `~/.local/bin` (change with
`--links <dir>` or `$DECX_LINKS_DIR`, suppress with `--no-links`): a symlink on
macOS and Linux, a generated `.cmd` shim on Windows.  A file that decx did not
create is never replaced -- the install reports the conflict unless `--force`
asks for it.  No command edits shell startup files, and the JSON result reports
whether the link directory is on `PATH` together with the line to add when it is
not. PATH links are set up after the core install commits; link conflicts or
setup failures produce warnings without undoing the installed tool. The tool
remains callable with `decx -m <tool>`.
`decx -m <tool> [args...]` (or `--module <tool>`) executes the installed
launcher with every argument after the tool id passed through unchanged,
inherits stdio and forwards the exit code; it never translates analysis
commands. The selected install root is passed as `DECX_HOME`. Python launchers
initialize `VIRTUAL_ENV`, prepend the private interpreter directory to `PATH`,
and expose the installed payload through `PYTHONPATH`, so child Python processes
can import the tool from any working directory without activating a shell.
These changes apply only to the launched process and its children.  Options before the module (`--home`, `--subprojects`, `--pretty`)
belong to decx, so `decx -m kuna --version` asks Kuna for its version.

The agent skills this repository ships (`skills/`: one skill for every tool) are
loaded by the agent harness directly from the checkout: point it at `skills/`,
or at the repository root.  The manager has no skill commands, and no skill files are
copied into `$DECX_HOME`.

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
$DECX_HOME/share/<id>/...            the tool's payload (venv, entry point, ...)
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
  "env": { "KUNA_SPECS": "{prefix}/specs" },
  "release": {
    "repository": "Noelo-Lab/kuna",
    "assets": { "darwin-arm64": "kuna-v{version}-macos-arm64.zip" },
    "extraAssets": { "specs": "kuna-v{version}-specs.zip" }
  },
  "bins": ["kuna", "decomp_dbg", "slacomp"],
  "verify": "--version"
}
```

| Field | Meaning |
|---|---|
| `summary` | one line shown by `list` (required; everything else has a convention) |
| `release` | the install source: `repository` (`owner/repo`, default `jygzyc/decx`), `tagPrefix` (default `<id>-v`), exactly one of `asset` (a single template) or `assets` (per-platform names); `{version}`, `{os}` and `{arch}` are substituted at install time. `checksums` names the `sha256  filename` asset (`<id>-SHA256SUMS.txt` by default), `extraAssets` are downloaded for every platform (Kuna's compiled SLEIGH specs) |
| `python` | its presence makes the tool `python-venv`: the payload comes from the vendored checkout `subprojects/decx-<id>/source` when there is one, otherwise from the release's source archive. `install` creates the environment at `{ venv }` (`.venv` by default) inside the payload from `{ entry, requirements, payload }` and generates the launcher (`bins` is not used). The environment is always created fresh -- one that already exists is refused, never reused -- and `requirements` go in with `uv pip install` when a uv is on `PATH`, else with the venv's own pip |
| `bins` | executables the release archive must contain (binary tools; the venv launcher is generated) |
| `env` | environment the generated launchers export (`{prefix}` = the payload directory, `{version}` = the installed version); declaring it moves the binaries to `share/<id>/bin` and puts wrappers in `bin/` |
| `launch` | launcher name inside `bin/`; the first `bins` entry by default |
| `verify` | the probe command run through the launcher after install, e.g. `--version` |
| `requires` | runtime floors `install` checks before staging anything (`{ "python": ">=3.10" }`) |

The venv install records the interpreter it used in PROVENANCE (`python`), the
manager that installed the requirements (`python_manager`) and the interpreter
path it will run (`venv`).

`kind`, `id`, `tagPrefix` and `checksums` are derived — a `python` block makes a
tool `python-venv`, its absence `binary`; the tool id is the subproject
directory name without the `decx-` prefix. Platforms are two axes joined as
`<os>-<arch>`: `win`, `darwin`, `linux` × `arm64`, `amd64` (e.g. `darwin-arm64`,
`win-amd64`); an `assets` map may additionally use `any` for a
platform-independent payload. `--version <tag>` picks a release explicitly,
otherwise `install` resolves the newest stable tag with the prefix. For a Python
checkout install, an explicit `--version` must match the checkout's exact tag;
a mismatch or an untagged checkout is rejected rather than silently ignoring
the requested version.

## Development

```console
$ npm ci                      # dev deps only (esbuild, typescript, @types/node)
$ npm test                    # offline tests, including isolated bundle smoke
$ npm run typecheck           # tsc --noEmit
$ node src/cli.ts version
```

## Single-file release

`npm run build` produces **`dist/decx.mjs`**, a single Node 22.18+ executable
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

Adding a tool: create `subprojects/decx-<id>/` with its own `README.md` and the
`decx-<id>.json` manifest (the tool id is the subproject directory name without the
`decx-` prefix), add its contract to `skills/decx-tool/` (a routing-gate row in
`SKILL.md` plus `references/<id>.md`), then run `npm test` — the manifest tests load
every manifest under `subprojects/` and hold each shipped manifest to the platform,
release-asset and launcher rules.  The skill is validated by
`python3 skills/check-skills.py`, which walks every `skills/` root.

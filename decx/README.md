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
$ decx run kuna --help       # exec the installed launcher, args untouched
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
sha256-verified against the release's `SHA256SUMS` asset when one is published,
with any release `extraAssets` (Kuna's compiled SLEIGH specs) downloaded
alongside -- or, with `--from-source`, builds the checkout the manifest declares
as buildable (AFE).  A manifest that pins `release.version` is what an install
reproduces: that is the tag whose asset names were verified against upstream,
and upstream renames files between releases (Kuna's archives gained a `v` in the
file name in v1.508); `--version <tag>` installs one specific tag instead.
`decx install droidasc` needs no download: it builds a private venv over
`subprojects/decx-droidasc/source` and installs a self-contained payload under
`share/droidasc/`.  `decx install afe` uses a prebuilt `tools-v*` archive when one
carries an AFE build for the platform, and otherwise builds
`subprojects/decx-afe` with cargo.

Installing also links the tool's executables into `~/.local/bin` (change with
`--links <dir>` or `$DECX_LINKS_DIR`, suppress with `--no-links`): a symlink on
macOS and Linux, a generated `.cmd` shim on Windows.  A file that decx did not
create is never replaced -- the install reports the conflict unless `--force`
asks for it.  No command edits shell startup files, and the JSON result reports
whether the link directory is on `PATH` together with the line to add when it is
not.
`decx run [options] <tool> [args...]` executes the installed launcher with every
argument after the tool id passed through unchanged, inherits stdio and forwards
the exit code; it never translates analysis commands.  Options before the tool
id (`--home`, `--subprojects`, `--pretty`) belong to decx, so
`decx run kuna --version` asks Kuna for its version.

The agent skills this repository ships (`skills/`: the process skills plus one skill per
tool) are loaded by the agent harness directly from the checkout: point it at `skills/`,
or at the repository root.  The manager has no skill commands, and no skill files are
copied into `$DECX_HOME`.

## Layout

```
decx/
├── src/
│   ├── cli.ts          argument parsing, dispatch, output envelope
│   ├── platform.ts     `macos-arm64` / `windows-x64` / ... keys
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
  "manifest": 1,
  "id": "kuna",
  "kind": "binary",
  "summary": "Native decompiler for ELF/PE/Mach-O (upstream Kuna)",
  "env": { "KUNA_SPECS": "{prefix}/specs" },
  "release": {
    "repository": "Noelo-Lab/kuna",
    "version": "1.515",
    "assets": { "macos-arm64": "kuna-v{version}-macos-arm64.tar.gz" },
    "extraAssets": { "specs": "kuna-v{version}-specs.tar.gz" }
  },
  "bins": ["kuna", "decomp_dbg", "slacomp"],
  "launch": { "bin": "kuna" },
  "verify": { "args": ["--version"] }
}
```

| Field | Meaning |
|---|---|
| `kind` | `binary` (release artifact and/or source build) or `python-venv` (upstream Python payload plus a private virtualenv) |
| `release` | `owner/repo` plus per-platform asset names; `{version}` is substituted, `checksums` names the `sha256  file` asset, `extraAssets` are downloaded for every platform (Kuna's compiled SLEIGH specs), `allowSourceFallback` builds from `source/` when no release can be resolved |
| `source` | vendored checkout to build from (`subprojects/<dir>`), with the cargo manifest, packages and optional build `env` (`{version}` = the pinned version, for tools whose release CI bakes it into `--version`) |
| `env` | environment the generated launchers export before running the packaged binary (`{prefix}` = the payload directory, `{version}` = the installed version); declaring it moves the binaries to `share/<id>/bin` and puts launchers in `bin/` |
| `python` | `python-venv` payload: checkout path, entry point, requirements, payload directories |
| `bins` | executables the install must produce; required for kind `binary`, taken from the release archive or from the cargo build |
| `requires` | runtime floors checked by `install` (ASC Python >= 3.10; Rust for source builds) |
| `launch`, `verify` | what to run afterwards and how to verify a fresh install |

Platform keys are `macos-{x64,arm64}`, `linux-{x64,arm64}`,
`windows-{x64,arm64}` -- the same vocabulary the install scripts and upstream
release assets use.

## Development

```console
$ npm ci                      # dev deps only (typescript, @types/node)
$ npm test                    # node --test, no build step
$ npm run typecheck           # tsc --noEmit
$ node src/cli.ts version
```

Adding a tool: create `subprojects/decx-<id>/` with its own `README.md`, a
`skills/decx-<id>/` directory inside it holding the skill, and the `decx-<id>.json`
manifest (the tool id is the subproject directory name without the `decx-` prefix),
then run `npm test` — the manifest tests load every manifest under `subprojects/` and
hold each shipped manifest to the platform, release-asset and launcher rules.  The
skill is validated by `python3 skills/check-skills.py`, which walks every `skills/` root.

# decx -- toolkit installer and manager

DECX is not a decompiler and not a wrapper around one.  This CLI installs and manages
the native analysis tools the DECX skills drive (`droidasc`, `kuna`, `afe`), so an agent
can go from a bare machine to a working toolkit with one command.  The tools stay where
they belong: upstream releases where they exist, `third_party/` checkouts where DECX is
the maintainer.

- **npm CLI.** Node 24.21+ is required. The published package contains one
  JavaScript executable with its version, tool catalog and Execa embedded; no
  external runtime npm dependencies. Source development can also run TypeScript directly.
- **JSON by default.** Every data command prints one JSON object on stdout; the
  consumer is an agent.  `--pretty` is for humans.
- **Never installs runtimes.** A tool that needs Python or Rust is checked at
  install time, and the exact shortfall is reported instead of installed.

## Source layout

- `src/cli.ts`, `src/build-info.ts`: command dispatch, process entry and build metadata.
- `src/cli/`: manager flags, the `-m` pass-through boundary and JSON output envelopes.
- `src/core/`: install paths, shared filesystem helpers, platform keys and install errors.
- `src/catalog/manifest.ts`: tool declarations, loading and validation.
- `src/download/`: GitHub release discovery, HTTP transport and download types.
- `src/install/`: release resolution, downloads/checksums, archive extraction, shared
  verification, ownership, staging/commit/rollback, PATH links, state and removal.
- `src/bridge/`: shell-free process execution and launch descriptors, Python interpreter
  probes/private venv initialization, and Node probes/JavaScript release launchers.
  Native tools execute their command/argv directly; bridges never translate analysis commands.

## Install and usage

After publication, `npm install -g @jygzyc/decx-cli` installs the `decx` command;
`npx @jygzyc/decx-cli --help` runs it without a global install. From a checkout,
run `npm ci && npm pack`, then install the generated `.tgz` with npm.
Node must remain available when running the manager; upstream native tools are
still native and retain their own runtime requirements.

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

`decx install <tool>` resolves the host platform from the catalog and installs
the newest stable GitHub release carrying the declared primary and all extra
assets (Kuna's compiled SLEIGH specs), or a release selected by `release.version`
or `--version`. Downloads are staged and SHA-256 verified: omitted or null
`release.checksums` requires GitHub REST asset digests for every download.
An explicit checksum filename instead requires that file and each asset's entry.
Missing, null or mismatched digests fail; there is never an unverified fallback.
Asset names must match the candidate version after template substitution, so
unrelated manager releases in a shared repository are skipped.
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

The portable [decx-tool skill](../.agents/skills/decx-tool/) uses this CLI as the
unified install and launch entry. Skills live in the repository's `.agents/skills/`
and work in any Agent Skills-compatible agent without plugins or initialization
commands. Skills are sourced directly from the repository, independently of CLI
releases. From the target project, install them with
`npx skills add jygzyc/decx --skill decx-tool --agent universal`, update them with
`npx skills update`, or uninstall with
`npx skills remove decx-tool --agent universal`. The manager does not manage
skills, install plugins or copy skills into `$DECX_HOME`.

## Layout

```
decx/
├── src/
│   ├── cli.ts          command dispatch and process entry point
│   ├── build-info.ts   source/bundled build metadata
│   ├── cli/            args.ts, output.ts
│   ├── core/           config.ts, fs.ts, platform.ts, errors.ts
│   ├── catalog/        manifest.ts
│   ├── download/       github.ts, http.ts, types.ts
│   ├── install/        index.ts, archive.ts, links.ts, state.ts, remove.ts, types.ts
│   └── bridge/         process.ts, launch.ts, python.ts, javascript.ts
└── tests/              node:test suite (run against the shipped bundle)
```

All tool manifests live in the central `third_party/tools.json` catalog.
The root requires `manifest: 1`; each unversioned tool entry has an explicit
`id` and `repo`, independent of its source directory.
`third_party/ASC` and `third_party/kuna` are direct pinned upstream gitlinks;
`third_party/afe` is DECX's own Rust utility. There are no per-directory manifests.

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

A manifest is data, never code; adding a tool means adding an entry to
`third_party/tools.json`. The only root fields are `$schema` (optional),
`manifest` (required, exactly `1`) and a nonempty `tools` array. Entries have
neither `manifest` nor `$schema`; old per-tool versions, `homepage`, object
`requires` and `release.repository` are rejected rather than migrated.

```json
{
  "$schema": "./decx-tool.schema.json",
  "manifest": 1,
  "tools": [{
    "id": "kuna",
    "repo": "Noelo-Lab/kuna",
    "requires": "bin",
    "summary": "Native decompiler for ELF/PE/Mach-O (upstream Kuna)",
    "install": ["github-release"],
    "launch": { "type": "bin", "commands": ["kuna", "decomp_dbg", "slacomp"] },
    "env": { "KUNA_SPECS": "{prefix}/specs" },
    "release": {
      "assets": { "darwin-arm64": "kuna-v{version}-macos-arm64.tar.gz" },
      "extraAssets": { "specs": "kuna-v{version}-specs.tar.gz" }
    },
    "verify": "--version"
  }]
}
```

The catalog uses one [JSON Schema](../third_party/decx-tool.schema.json) for editor completion and validation. `src/catalog/manifest.ts` enforces the same entry and cross-field recipe rules without runtime dependencies; tests compare both validators. Unique tool IDs are additionally checked by the catalog loader. No separate schema is needed for each runtime.

| Field | Meaning |
|---|---|
| `id` | required explicit lowercase tool name, unique within the catalog |
| `repo` | required GitHub `owner/repo`; archive release source (no default repository) |
| `summary` | one-line tool description |
| `release` | required for `bin` and `js`, omitted for PyPI packages. Optional `version` defaults to `latest`; optional `tagPrefix` filters discovery and normalizes bare versions, with no default prefix. Exactly one of `asset` (single template) or `assets` (per-platform names); `{version}`, `{os}` and `{arch}` are substituted at install time. Omitted or null `checksums` requires GitHub REST SHA-256 asset digests for **every** download; an explicit filename requires its `sha256  filename` entries instead. `extraAssets` are required on every platform. Repository is derived internally from `repo`, never accepted inside `release` |
| `install` | required installer recipe: `["github-release"]` downloads and verifies the archive described by `release`; `["pip", "install", "droidasc"]` installs a published PyPI package (no shell). Python source-checkout/archive recipes are not supported. The manager creates the Python virtual environment itself; manifests do not contain venv commands. `--version` pins PyPI packages using `==`. Python source checkouts are not copied into `share/`; JS release assets retain their module tree under `share/<id>/app` |
| `env` | required object; empty `{}` is valid for any runtime. Variable names must match `[A-Za-z_][A-Za-z0-9_]*`, and values must be nonblank strings. Nonempty maps are supported for `bin` tools only: environment the launchers export (`{prefix}` = payload directory, `{version}` = installed version); these move binaries to `share/<id>/bin` and put wrappers in `bin/` |
| `launch` | required object with `type` (`bin`, `python` or `js`) and `commands` (nonempty list of public command names). The first command is the default for `decx -m <tool>`. For `bin`, the release archive contains each executable; for `python`, the manager generates a wrapper to the venv console script; for `js`, the release archive contains `<command>.mjs`, `.cjs` or `.js` and the manager keeps the archive tree in `share/<id>/app` (including local imports and `package.json`), generating Node launchers (`.cmd` on Windows). JS installs require `node` on PATH. |
| `verify` | the probe command run against the staged executable or Node script before committing, e.g. `--version` |
| `requires` | required explicit runtime string: `bin`, `python` or `js`, matching `launch.type`; omitted values are rejected. Python must be Python 3 with `venv`; pip/upstream package metadata enforces package-specific minimum Python versions |

The venv install records the interpreter it used in PROVENANCE (`python`), the
manager that installed the package (`python_manager`) and the interpreter
path it will run (`venv`).

The tool `id` and `repo` are required; `launch.type` selects the runtime.
There is no implicit tool-specific repository, tag prefix or checksum filename. Platforms are two axes joined as
`<os>-<arch>`: `win`, `darwin`, `linux` × `arm64`, `amd64` (e.g. `darwin-arm64`,
`win-amd64`); an `assets` map may additionally use `any` for a
platform-independent payload. For archive recipes, `latest` enumerates paginated GitHub releases and chooses
the newest non-draft, non-prerelease candidate carrying every declared host
primary/extra asset. Without a prefix, bare `--version 0.1.0` matches a listed
release's extracted version and asset names, not an assumed `v0.1.0` tag.
Version extraction strips `v` or the last namespace prefix before `v` followed
by a digit: `v1.604`, `tools-v0.1.0` and `decx-v0.1.0` yield `1.604` and `0.1.0`.
An explicit full tag downloads directly, still requiring integrity verification.
Explicit `release.tagPrefix` filters discovery and prefixes bare numeric
versions; full tags stay unchanged. `release.version` uses the same rules and
defaults to `latest`. For PyPI recipes, `--version` pins a
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
  suites run manually against real installed tools, not in offline CI. No mocks
  replace them. Manager security/rollback cases
  also run through actual CLI subprocesses. No suite imports manager functions
  or mocks Node builtins.

The suites run the built `dist/decx.mjs` through Node. The test prefix must be
explicit; never install into the user's real home.
Fixture origins and hashes are documented in `tests/fixtures/real-analysis/`.

## npm package and release

`npm run build` produces **`dist/decx.mjs`**, a single Node 24.21+ executable
with the package version, tool manifests and Execa embedded by esbuild. Command
execution uses Execa with argv arrays, inherited tool I/O and stderr-only install
logs, including its Windows `.cmd` handling. Copy that
file anywhere and run `node decx.mjs version` or `node decx.mjs help`: no adjacent
package.json, manifests, node_modules or runtime temporary manifests are needed.
Node itself and the tools being installed are not bundled.

`npm pack` runs the build through `prepack` and creates a standard npm `.tgz`.
The package contains `package.json`, this README, `dist/LICENSE`, the executable
and `dist/THIRD_PARTY_NOTICES.txt` (licenses for bundled libraries);
npm creates the `decx` symlink or Windows `.cmd` shim from the package's `bin` entry.
There are no install-time build hooks, SDK downloads, native manager artifacts
or runtime npm dependencies. Installing a packed tarball works offline.

`npm test` first builds the bundle, then tests real tool installations, update,
rollback, removal and argument/environment preservation. The package acceptance
test runs `npm pack`, inspects its files, installs it into a temporary offline npm
prefix with a spaced Unicode path, executes the npm-created shim outside the
repository and uninstalls it. Tests are sequential because packing rebuilds the
same bundle used by the other suites.

A `decx-v<version>` tag (or workflow dispatch with that tag) publishes to npm only
after Linux, macOS and Windows gates pass and the tag matches `package.json`.
Publication uses npm trusted publishing with provenance, not a stored npm token.
The existing npm package's latest release is the legacy `4.3.0`; this replacement
is versioned `5.0.0`. Before publishing, configure GitHub repository `jygzyc/decx`
and workflow `decx-cli.yml` as that package's trusted publisher on npmjs.com.
The npm install command still retrieves the legacy release until `5.0.0` is
published. No registry publication is performed by local tests or ordinary
branch pushes.
`npm run build` also runs an offline smoke check by copying only the executable
into a temporary empty directory and checking version, help, tool discovery and
the `--third-party` override.

Direct source execution (`node src/cli.ts …`) still reads package.json and the
repository's `third_party/tools.json`. In either mode, `--third-party <dir>`
replaces the default manifest set with `<dir>/tools.json`; it does not merge them.
The loader never scans tool directories or falls back to old manifest files.
Malformed catalog roots yield no tools. Invalid entries produce issues keyed by
`tools.json#tools/<index>` without blocking valid tools; duplicate IDs report an
issue and keep the first valid entry.

Adding a tool: add an unversioned entry with an explicit unique `id` and `repo` to
`third_party/tools.json` and its contract to `.agents/skills/decx-tool/` (a routing-gate
row in `SKILL.md` plus `references/<id>.md`), then run `npm test`. If a source
checkout is needed, retain its upstream repository name and pinned gitlink;
never wrap it in a DECX manifest directory. The manager tests hold the catalog
entries to the platform, release-asset and launcher rules.  The skill is validated by
`python3 scripts/check-skills.py`, which validates the versioned execution skills.

---
name: decx-init
description: Use when setting up, checking or repairing a DECX environment — installing the native tools with `decx install`, running one through `decx run`, the manager's commands, options, exit codes and environment variables, the DECX_HOME layout and PROVENANCE records, pinned releases, missing runtimes, and how the skills/wiki/raw workspace is created. Not an analysis interface: it never translates one tool's commands into another.
metadata:
  requires:
    bins: ["decx"]
---

# DECX Init

Initializing DECX is two things: install the native tools, then work inside a workspace
where `skills/` is loaded, `raw/` records execution and `wiki/` keeps the knowledge.
`decx` installs and launches tools; `decx run <tool> <args...>` passes `<args...>`
through unchanged.

## Routing Gate

Use for installation, environment checks, locating a launcher, diagnosing a missing
runtime or a failed install, and for the workspace layers (`skills/`, `wiki/`, `raw/`).

Do not use it as an analysis interface. There is no unified DECX command tree, no
analyzer registry, no session protocol and no command translation — a request for any of
them stops the session instead of being reimplemented. Analysis commands belong to the
tool itself, documented by the tool's own skill: `decx-droidasc`, `decx-kuna`, `decx-afe`.

## Commands

```console
$ decx install <tool>        # download or build one tool into DECX_HOME (JSON)
$ decx run <tool> [args…]    # exec the installed launcher; args pass through
$ decx version               # manager version (JSON)
$ decx help [command]        # usage; `decx <command> --help` for one command
```

- Every data command prints one JSON object on stdout: exit `0` on success, `1` when a
  runtime check fails, `2` on a usage error. Failures keep the envelope, e.g.
  `{"ok":false,"command":"install","error":{"code":"UNKNOWN_TOOL","message":"unknown tool: nope","hint":"run \`decx help\`"}}`.
- In `run`, every argument after the tool id belongs to the tool — `decx run kuna --version`
  asks Kuna for its version — so `run`'s own options (`--home`, `--subprojects`, `--pretty`)
  come before the tool id. `run` inherits stdio and forwards the tool's exit code.
- `install` takes its options after the tool id, e.g.
  `decx install kuna --version v1.515 --home /tmp/decx --no-links`.
- `install` commits nothing until every check — including the tool's own verify command —
  has succeeded. It links the launchers into `~/.local/bin` (`.cmd` shims on Windows) and
  prints the `PATH` line to add instead of editing shell startup files.

## Options

| Option | For | Meaning |
|---|---|---|
| `--home <dir>`, `--prefix <dir>` | all | install root (default `$DECX_HOME`, else `~/.decx`) |
| `--subprojects <dir>` | install | tool subproject directory (default `<repo>/subprojects`) |
| `--pretty` | all | indent the JSON output (for humans) |
| `--version <tag>` | install | install one release tag (e.g. `v1.515`, `tools-v0.1.0`) |
| `--from-source` | install | build the vendored checkout with cargo |
| `--source <dir>` | install | checkout to build (implies `--from-source`) |
| `--force` | install | reinstall over an existing install, replacing links |
| `--links <dir>` | install | PATH link directory (default `~/.local/bin`) |
| `--no-links` | install | install without PATH links |
| `-V`, `--version` (no value) | all | manager version |
| `-h`, `--help` | all | manager help; `decx <command> --help` for one command |

- `install` refuses to overwrite an existing tool (`ALREADY_INSTALLED`, naming the prefix)
  unless `--force`; `run` reports `NOT_INSTALLED` with the install hint. There is no state
  command — read `PROVENANCE` to see what is installed.
- A manifest pins the release tag whose asset names were verified, so `install <tool>`
  reproduces a known-good install; upstream renames files between releases. `--from-source`
  and `--source` work only where the manifest declares a buildable source block — a tool
  without one rejects them.
- Missing runtimes are install errors naming the exact shortfall (the interpreter a venv
  install needs, Rust for a cargo build) and are never installed for you; a too-old default
  `python3` falls back to a versioned interpreter and says so (`... via python3.12`).
- The host is resolved to a platform key — `macos-{x64,arm64}`, `linux-{x64,arm64}`,
  `windows-{x64,arm64}` — which selects the asset or source build to install; `decx run`
  then executes exactly the launcher that platform installed.

## Tools

Three tools are managed, one skill each: `droidasc` (`decx-droidasc`), `kuna` (`decx-kuna`)
and `afe` (`decx-afe`). Each of those skills owns its tool's install method, requirements,
launchers and command syntax — this file only covers the manager. One manifest per tool
lives in that tool's subproject, `subprojects/decx-<id>/decx-<id>.json`, so the manager's
tool list is exactly the subproject list: a new tool is a new subproject, skill and
manifest, never new manager code. Manifest field schema and the development commands:
`decx/README.md`.

## Layout

```
$DECX_HOME/bin/<name>              executables of every managed tool (`.exe`/`.cmd` on Windows)
$DECX_HOME/share/<id>/PROVENANCE   what was installed, from where (revision/tag, asset, SHA-256)
$DECX_HOME/share/<id>/…            the tool's payload (venv, entry point, …)
$DECX_HOME/share/<id>/specs/       tool-specific data its launcher points at
~/.local/bin/<name>                PATH link (see `--links`)
```

Executables share one store (so a tool with helper binaries links them together — `kuna`
adds `decomp_dbg` and `slacomp`) while payloads stay per tool. A manifest that declares
`env` installs generated launchers that export it instead of asking for shell setup
(`kuna` exports `KUNA_SPECS`). The legacy `$DECX_HOME/tools/<id>` layout (from the removed
`scripts/install-*.sh`) is neither detected nor migrated.

## Host

- Windows is a first-class host: the manager is plain Node and runs in PowerShell or cmd,
  launchers are `.cmd` shims / `.exe` files there, and no install or run step may need Git
  Bash, `uname` or POSIX tools. A command that only works under a POSIX shell is wrong.
- Quote identifiers and paths on every platform — `$`, `(`, `)`, `:`, `;` and `*` are
  parsed by the shell; in PowerShell single quotes keep a literal while `$name` expands
  inside double quotes.
- Pass artefact paths exactly as the shell hands them over: the launcher forwards argv
  unchanged (backslashes included) and never converts separators.
- AFE's optional external extractors (`debugfs`, `fsck.erofs`, `extract.erofs`) have no
  Windows builds, so AFE uses its own ext4/EROFS/ZIP readers there: collection and
  preprocessing still work, while diagnostics and fallback paths differ.

## Environment

- `DECX_HOME` — install root; a `--home`/`--prefix` argument wins.
- `DECX_LINKS_DIR` — PATH link directory; a `--links` argument wins.
- `DECX_PYTHON` — interpreter for the venv install; otherwise `python3`, then a versioned fallback.
- `KUNA_SPECS` — exported by Kuna's generated launcher; never set by the caller.

## Workspace

- The workspace is the repository root: `skills/` holds the procedures the harness loads
  (the process skills plus one skill per tool), `wiki/` the pattern pages with their index
  (plus the seeded log and skill-impact files), and `raw/` the immutable execution traces.
- `skills/` is read in place — there is no install step for skills and `decx` never writes
  to it; no skill files are copied into `$DECX_HOME`.
- The `decx_*` tools create and maintain the other two layers on demand (`decx_trace`,
  `decx_maintain`, `decx_propose`); `decx_check` is their structural gate and reports
  0 errors when the workspace is consistent.

## References

- `wiki/index.md` — evidence and history for the `tool` track (maintenance only; never read during a run).
- `decx/README.md` — manager internals: manifest schema, install pipeline, development.

# decx

DECX CLI — Decompiler + X command-line tool.

This directory contains the **Go client** that replaces the legacy TypeScript
CLI. The published npm package `@jygzyc/decx-cli` still serves the last
TypeScript release and is documented in the repository root
[`README.md`](../README.md); this README documents the Go client only.

```bash
decx -m jadx classes …                     # server module commands (JADX/DEX)
decx -m asc class-source …                 # optional ASC module (pure Python, no JVM)
decx -m kuna source …                      # optional Kuna module (Rust, native ELF/PE/Mach-O)
decx session open <target>                 # manage persistent server processes
decx -m ard-framework device system-services        # runtime plugin module workflows
decx -m ard-framework framework collect | process
decx install                               # download modules (defaults: jadx, ard-framework)
decx module list                           # list discovered modules and their install state
decx self update | skills
```

## Build

Go 1.25 or newer and a C toolchain are required (the embedded JS engine `quickjs-go` is linked through cgo).

```bash
cd decx
go build ./cmd/decx        # or: make build   → dist/decx (version-stamped)
go install ./cmd/decx      # or: make install
go test -race ./...        # or: make test    (also runs go vet)
make release               # pack the host release archive (go run ./cmd/pack)
```

## Configuration

- There is no registry file: every module (server or plugin) describes itself
  in a `decx.json` manifest. The CLI scans `$DECX_HOME/modules/<id>/decx.json`;
  an explicit leading `--config <path>` adds that path (plus its `modules/`, and
  the legacy `bin/` or `plugins/` layouts) as extra scan roots, and the nearest
  `modules/` (servers) or `plugins/` (plugins) directory above the `--config`
  path, the executable or the working directory is scanned too, so a checkout
  can be used without installing it — as long as the module's build output
  exists (`modules/decx-kuna/bin/kuna-server`, `modules/decx-asc/bin/asc-server`,
  `plugins/ard-framework/dist/`, `modules/decx-jadx/jadx-server.jar` for the JVM
  server).
- Sessions, logs and downloaded modules also live under `DECX_HOME`; point it at
  a scratch directory for experiments.
- Module command output is JSON on stdout; progress and logs go to stderr.
- Reserved top-level names never usable as module ids: `session`, `engine`,
  `plugin`, `module`, `self`, `install`, `settings`, `help`.

### Registry reference

Each component ships its own `decx.json` manifest next to a `VERSION` file;
that manifest holds both the runtime pieces (server binary/launch command,
plugin entry file, command tree) and the release source. Nothing is compatible
with the deleted `cli.json` catalog on purpose — a component without a manifest
is simply not installed, and a manifest that fails to parse is skipped with a
warning, so `decx install --force` can repair it.

- `release` — where the component's releases come from: `source: "repo"`,
  `tag` naming the release (`v{version}` when omitted), `asset` naming the
  archive with `{version}`, `{os}` and `{arch}` substituted
  (`kuna-server-{version}-{os}-{arch}.zip`), `asset_fallbacks` covering older
  names, `checksums` naming the SHA-256 digest file (the shipped components
  publish `SHA256SUMS`) and `format` (`zip`/`tar.gz`, inferred from the asset
  name when omitted). `repository` defaults to `jygzyc/decx`, and
  `--prerelease` on `decx install`/`decx self update` makes prereleases
  eligible. A component without a release source has to be installed manually.
- Server manifests (`kind: "server"`) — one module per directory under
  `$DECX_HOME/modules/<id>`, naming the `binary` (`kind: "java-jar"` or
  `"program"`, its path and environment override such as `DECX_JADX_SERVER`),
  the launch command (`{binary}`, `{target}`, `{port}`, `{home}` substituted)
  and the command tree exposed as `decx -m <id> <command>`.
- Plugin manifests (`kind: "plugin"`) — under the same `$DECX_HOME/modules/<id>`
  root (the manifest decides the kind), naming the `entry` file
  (`dist/ard-framework.js`) and the command tree reached as
  `decx -m <id> <command>`. The known table marks `jadx` and `ard-framework` as
  default modules, so a plain `decx install` installs them.
- Discovery — `$DECX_HOME/modules` is scanned first; an explicit
  `--config <path>` adds that path plus its `modules/` (and the legacy `bin/` or
  `plugins/`) as an extra root, and the nearest `modules/` (servers) or
  `plugins/` (plugins) directory above the `--config` path, the executable or
  the working directory is scanned too, so a checkout whose build output exists
  can be used without installing it. Installed modules always win over
  checkouts.

The CLI is compiled with a **known component** table
(`decx/internal/registry/known.go`) that fills in components which are not
present locally — the `jadx` (default), `asc` and `kuna` servers plus the
default `ard-framework` plugin — so a fresh machine can run
`decx install --module jadx` without any file. It carries no command tree; an
installed manifest always wins.

What the jadx module's own `decx.json` carries:

```json
{
  "manifest": 1,
  "kind": "server",
  "id": "jadx",
  "release": {
    "source": "repo",
    "tag": "jadx-server-v{version}",
    "asset": "jadx-server-{version}.zip",
    "checksums": "SHA256SUMS",
    "format": "zip"
  },
  "binary": { "kind": "java-jar", "path": "jadx-server.jar", "env": "DECX_JADX_SERVER" },
  "launch": { "command": ["java", "-jar", "{binary}", "{target}", "--port", "{port}"], "stop": "terminate", "scripts": "positional", "trailing_args": true },
  "commands": [
    { "name": "classes", "about": "List classes", "endpoint": "get_classes" }
  ]
}
```

## Modules

Server commands are registered per module and invoked as
`decx -m <module> <command>`; `decx -m <module>` alone prints that module's
command list.

| Module | Backend | Commands |
|--------|---------|----------|
| `jadx` | `jadx-server.jar` under a JVM (JADX-based, supports `--script`) | `classes`, `search-global`, `class-context`, `class-source`, `method-source`, `method-context`, `method-cfg`, `search-class`, `search-method`, `xref-method`, `xref-class`, `xref-field`, `implementations`, `subclasses`, `manifest`, `launcher-activity`, `application`, `exported-components`, `deep-links`, `dynamic-receivers`, `framework-service-implementation`, `resources`, `resource-file`, `strings`, `aidl-interfaces` |
| `asc` | `asc-server` (pure-Python ASC adapter; on-demand DEX analysis, no JVM) | `class-source`, `find-refs` |
| `kuna` | `kuna-server` (Rust Kuna decompiler; native ELF/PE/Mach-O pseudo-C) | `functions`, `source`, `xref` |

Module commands accept `--session <name>` or a direct `--port <port>`; when
neither is given the CLI auto-selects the only healthy compatible session.
`decx -m <module> <command> --help` prints the arguments a command takes.

Optional modules are installed with `decx install --module <id>` (nothing
is downloaded unless a module is selected explicitly or carries the
`default` marker).

## Sessions

```bash
decx session open <target> --engine jadx [--name <name>] [--port <port>]
                           [--timeout <seconds>] [--script <path>] [--force]
                           [-- <server arguments>]
decx session list
decx session check [<name>]
decx session close [<name> | --port <port> | --all]
```

- `--port` defaults to a free random port in `30000–40000`.
- `--script` (repeatable) runs Jadx Kotlin scripts (`.jadx.kts`) during
  decompilation; session reuse is keyed on the target **plus** the script set,
  so a different set requires `--force`.
- Open waits up to 300 seconds by default; on timeout the session record is
  kept for `session check` / `session close` instead of being silently dropped.
- `--force` replaces sessions with the same name or the same file hash after
  verifying the old JVM actually died.

## Runtime plugin workflows

Runtime plugin workflows run as `decx -m <id> <command>`; the shipped plugin
module is `ard-framework`, implemented in JavaScript
(`plugins/ard-framework`, whose own `decx.json` names
`entry: dist/ard-framework.js`). The module is installed from its release
bundle into `$DECX_HOME/modules/ard-framework` by `decx install`, and the CLI
loads it from there (a `plugins/<id>` source checkout is picked up in
place).

```bash
decx -m ard-framework device system-services [--serial <serial>] [--adb-path <path>] [--grep <keyword>]
decx -m ard-framework device permission-info <permission> [--serial <serial>] [--adb-path <path>]
decx -m ard-framework framework collect
decx -m ard-framework framework process [oem]
```

The plugin only collects, processes and packs a jar; opening it stays in the
CLI (`decx session open <jar>`), so session ownership never leaves the CLI. Framework artifacts use build metadata
under the output directory; a single connected adb device is auto-selected,
several devices require `--serial` (`ADB_DEVICE_AMBIGUOUS`), no device keeps the
offline `unknown` vendor.

## Self-management

```bash
decx install [--module <id|repo|path>]... [--all] [--prerelease] [--force] [--cli]
decx self update  [--module <id|repo|path>]... [--all] [--prerelease] [--force] [--cli]
decx self skills install [--client <client>]
```

- `decx install` downloads modules into `$DECX_HOME/modules/<id>`. Each
  `--module` source is classified in order: a module id (installed, checkout or
  known-table `jadx`, `asc`, `kuna`, `ard-framework`) is fetched from the
  `release` block of the module's `decx.json` with SHA-256 verification; an
  existing directory or `.zip`/`.tar.gz` archive is imported from that path; a
  repository (`owner/repo[@ref]`, `github.com/owner/repo`,
  `https://host/owner/repo`) has its archive downloaded and imported. An
  imported tree must carry a `decx.json` at its root or as its single
  top-level directory. Repository and path imports record their origin in
  `<module>/.decx-source.json`, so `decx self update` re-imports from the same
  place; a release install clears that record. `decx self update` only touches
  modules that are already installed, and `--all` covers every module that can
  be refreshed.
- `self update --cli` replaces the running `decx` executable with the newest
  `decx-cli-{version}-{os}-{arch}` release archive (skipped when the running
  version already matches; `--force` overrides, `--prerelease` selects
  prereleases).
- `self skills install` clones `https://github.com/jygzyc/decx.git`
  in-process with the embedded Go git implementation (`go-git`; no `git`
  binary is required), copies the skills into `$DECX_HOME/skills` and links
  them into a client skill directory (`codex`, `claude`, `cursor`, or the
  shared `~/.agents/skills` default).
- `decx module list` prints one JSON row per discovered module with its
  `id`, `kind`, `description`, `installed` state, `path` and `version` when
  installed, `installable` and `source` when it was imported; `default` marks
  the modules a bare `decx install` fetches. `path` points at the resolved
  binary for servers and the plugin directory for plugins — an installed copy
  under `$DECX_HOME/modules/<id>`, or a source checkout.

## Plugins

Runtime plugin workflows are implemented by JavaScript plugin modules under
`plugins/`, reached as `decx -m <id> <command>`. There is no catalog entry
either: the plugin's own `decx.json` manifest carries the command tree, the
`entry` naming the compiled bundle and its `release` source, and the installer
expects the manifest inside the release bundle; a source checkout under
`plugins/<id>` is discovered and run in place. Installed plugin modules live
under `$DECX_HOME/modules/<id>`, next to server modules.
The CLI
evaluates that file in its
embedded QuickJS engine (`quickjs-go`, linked through cgo) and calls the global
`handle(request)` in-process — no Node or npm toolchain is required on Windows,
Linux or macOS. The request/response ABI, the host modules available to
plugins (`fs`, `path`, `os`, `child_process`, `crypto` on a `decx` global, plus
a `Buffer`/`TextEncoder`/`TextDecoder` prelude) and the bundle layout shipped in
the release archive are documented in
[`../plugins/README.md`](../plugins/README.md).

## Documentation

- [`../modules/decx-asc/README.md`](../modules/decx-asc/README.md) and
  [`../modules/decx-kuna/README.md`](../modules/decx-kuna/README.md) describe the
  optional server module integrations.
- [`../MIGRATION.md`](../MIGRATION.md) tracks the remaining migration work.
- `tests/fixtures/sieve.apk` is the shared Android sample used by server module
  end-to-end checks (see `modules/decx-asc/README.md`).

## License

GNU-3.0

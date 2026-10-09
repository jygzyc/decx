# AGENTS.md

## Purpose

DECX is a set of agent skills, the toolkit manager that installs the native tools
those skills drive, and the standalone Android Framework Extract (AFE) utility.
It is not a decompiler, unified analysis CLI, plugin runtime, or analysis server.

- APK analysis uses upstream [DroidASC](https://github.com/MG1937/ASC) directly.
- Native binary analysis uses upstream [Kuna](https://github.com/Noelo-Lab/kuna) directly.
- `subprojects/` holds every subproject: its own `README.md`, the toolkit manifest
  `decx-<id>.json` the manager reads, and for a vendored tool its pinned `source/`
  checkout. The portable execution skills live in root `skills/`; the tool-routing
  skill is `skills/decx-tool/`, each tool's contract in `references/<id>.md`; Kuna's reference
  is upstream's own skill file copied verbatim (frontmatter dropped) and is re-copied,
  never edited, when the pin moves. DECX's own
  `decx-afe/` sits beside the vendored upstream checkouts `decx-droidasc/source` and
  `decx-kuna/source`, which are git submodules pinned by `.gitmodules` and the
  superproject gitlinks.
- Android framework collection and preprocessing lives in `subprojects/decx-afe/`.
- The portable execution skills live in root `skills/`; read `skills/AGENTS.md`
  before editing it. The wiki-maintenance process is built into the extension,
  not a separate skill.
- `decx/` is the toolkit installer and manager: a TypeScript CLI that discovers the tools in
  `subprojects/decx-<id>/decx-<id>.json`, installs, locates and runs them, and reports what is
  installed and what this host supports. Development runs TypeScript directly on
  Node 24.21+; releases ship bundled JavaScript and scriptc-native executables with
  embedded tool manifests. Native executables require no external Node. It prints
  JSON on stdout and keeps no runtime dependencies. It is the only
  install path — installs are declared as data, never as per-platform scripts.

## Boundaries

Do not restore the removed Go CLI, manifest registry, QuickJS runtime, JADX
integration, HTTP adapters, or DECX session protocol. Do not duplicate upstream
command trees or promise equivalent capabilities between analyzers. Prefer native
help and output. A thin executable launcher selecting an installed interpreter or
resource directory is acceptable; an analysis-command translation layer is not.

AFE is a native Rust program, not a JavaScript extension. Keep Android collection,
APEX handling, ext4/EROFS parsing and archive processing there. Payload extraction is
native only: an unsupported ext4/EROFS feature fails the input with an actionable error
instead of falling back to external tools. AFE produces files;
it does not start an analyzer or own analysis sessions.

The manager must not silently modify shell startup files, overwrite unrelated tools,
install agent plugins, or install skills (`npx skills` owns skill installation). Use explicit prefixes, staged installs and clear requirements, and
never run an install against the user's real home directory during tests. Upstream source
builds execute third-party code: record what was fetched, built and verified in
`share/<id>/PROVENANCE`. Installs follow each tool's manifest — kuna the official upstream `v*` release plus
its compiled SLEIGH specs, both verified against GitHub REST asset SHA-256 digests,
droidasc a private venv installing the published PyPI package with pip,
afe a prebuilt `tools-v*` archive when one carries an AFE build for the platform and
otherwise a cargo build. The rules behind them (the `env` launcher contract, `release.tagPrefix`
resolution, `--version <tag>`, when `--from-source` is offered) are documented in `decx/README.md`.
CI never modifies the pinned upstream checkouts; DroidASC installs directly from PyPI.
Installation prefers upstream distribution; repository release assets are fallback sources.
Integrity failures must stop installation, not silently switch sources.

Windows support is part of the contract: installing, using and compiling must work there
as well as on macOS and Linux. Both the Node CLI and compiled native manager run directly in
PowerShell or cmd — never require Git Bash, `uname`, `bash` or POSIX tools at install
time — and it installs `.exe`/`.cmd` names there. Keep the Windows branches covered by
tests. Rust code must build and pass tests under MSVC (no POSIX-only APIs, no `/bin/sh`
assumptions in shipped code).

The manager in `decx/` manages tools, not runtimes: it probes for Node, Python, Rust and
Git and reports the exact shortfall instead of installing them (agents run on Node
already; `mise`/`nvm`/`rustup` remain the user's choice). It also does not translate
analysis commands — `decx -m <tool>` reaches a tool's own help and output unchanged. Keep it
manifest-driven: a new tool is a new `subprojects/decx-<id>/decx-<id>.json` (with its own
`README.md` and a reference in `decx-tool`), never new
special-cased code. Installs keep every executable in `$DECX_HOME/bin` and each payload
in `$DECX_HOME/share/<id>/PROVENANCE`, and link the executables into `~/.local/bin`
(`--links`, `$DECX_LINKS_DIR`; `.cmd` shims on Windows). Keep that layout and those
PROVENANCE keys stable so `decx -m <tool>` and any reader of `share/<id>/PROVENANCE` keep
working on existing installs; the legacy `$DECX_HOME/tools/<id>` shape is not detected or
migrated.

The extension implements the WikiSkill loop inside pi: `/decx init` creates a fresh
`.decxwiki/raw` and `.decxwiki/wiki` in the current project and creates the
empty `.agents/skills` layer. It never installs skills: `npx skills` installs
`decx-tool` from the repository's root `skills/` into that directory. `/decx-wiki` consolidates traces
into patterns; `decx_propose` and `decx_gate` update or roll back the *active* skill
under `.agents/skills`, with measured validation. The wiki is maintenance material,
not an inference dependency; `SKILL.md` and references remain complete without it.
The old root-level `raw/` and `wiki/` and former skill content were archived
locally under `archive/legacy-knowledge/` and removed from version control;
root `skills/` now contains only installable, current execution skills. Never bootstrap new
projects from that archive, commit it, or treat it as a discovered workspace.

The evolution sequence is execution → trace consolidation → one-skill proposal →
validation → accept or rollback. Only the skill candidate rolls back; raw evidence and wiki
history persist. Structural lint is NOT validation performance: never claim an improvement
without measured baseline/candidate scores on the same validation split. Imported author
knowledge is bootstrap material, not rollout evidence. The pi extension assists maintenance
(its tool restrictions are not a filesystem sandbox) and its goal/facts/steps checkpoint
ledger lives under the pi agent directory, outside the three knowledge layers.

## Validation

- AFE: `cd subprojects/decx-afe && cargo build --release && cargo test` (stable Rust);
  `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` must stay clean.
- Manager: `cd decx && npm ci && npm run typecheck && npm test && npm run build`; `node src/cli.ts version` must keep printing one JSON
  envelope. Run `npm run setup:scriptc` before `npm run build:scriptc` or the independent TS-tool test;
  it installs the official SDK archive pinned by `decx/toolchains/scriptc/toolchain.json`,
  verifying SHA-256 before extraction into the ignored `.scriptc-toolchain/`, outside `npm ci`.
  `build:scriptc` compiles the typed manager with scriptc 0.2.7 and its embedded
  dynamic engine, not an external Node launcher. Run `npm run test:native` after
  compiling: native release and Python-wheel lifecycle tests remove Node from PATH.
  Four hosts are release-gated (Linux x64/arm64, macOS arm64, Windows x64);
  Windows arm64 is unsupported by scriptc and macOS x64 is outside the release matrix.
  Windows compilation links an in-binary Win32 cmd bridge using Zig (CI pins 0.16.0, matching upstream's runtime-pack build). Install tests are offline — fixture archives served locally, a local wheel installed
  with real Python/pip into a private venv, and fake toolchains for other branches — and must never touch the real home
  directory or the network; pass `--home`/`DECX_HOME` with temp dirs.
- Skills: `python3 skills/check-skills.py` verifies frontmatter, names and relative
  links; also verify every documented native command against the supported upstream
  revision. Never invent missing analysis commands.
- Decx: `node --test .pi/extensions/decx/*.test.ts` runs the extension tests. Structural validation happens against an
  initialized temporary project (`project=$(mktemp -d); node .pi/extensions/decx/cli.ts init --root "$project";
  node .pi/extensions/decx/cli.ts check --root "$project"`) because old repository knowledge is archived locally and
  is not a workspace. Use maintenance tools for routine knowledge updates; reviewed repository
  migrations may edit files directly and must regenerate/check the index. The checkpoint hook is covered by the same tests: it counts rounds and turns,
  keeps the last ten checkpoints per session and repeats the request until the pending
  round is covered.
- Analysis procedure: `decx-tool` owns per-tool syntax and the routing between tools.
  Session bookkeeping and the trace → pattern → proposal loop are `decx_*` tools;
  the `/decx-wiki` extension command orchestrates maintenance without a wiki skill.
  `decx-tool` works without the extension.

Agent plugins and extension manifests (Codex, Claude) are out of scope: the integration
contract is the portable `decx-tool` skill plus the one pi extension that owns the Decx layer
(`.pi/extensions/decx/`); nothing else may register into an agent harness. GitHub runs
workflows only from the repository root, so each subproject and area has its own file
there, scoped to its own `paths:` — keep them in sync when the crate, manifests, skills,
wiki or managed paths change. The manager and AFE workflows carry both checks and release publishing:
branch pushes and pull requests run checks, while a matching tag push (or a
`workflow_dispatch` with the `tag` input) runs release jobs instead,
each refusing to build when its tag does not match the pinned version. `decx-cli.yml`
(`cd decx && npm ci && npm run typecheck &&
npm test`, plus the JSON-envelope and usage-error smoke runs, on Linux, macOS and Windows
on the latest Node 24 release; tag `decx-v*`, checked against `decx/package.json`, builds
`dist/`, installs the pinned scriptc compiler separately and tests an independently compiled TS tool, then builds the complete native manager on four target hosts and gates release on
  offline native lifecycle tests with Node absent from PATH (no external Node at runtime), packs `decx-<version>.tar.gz` plus `decx-SHA256SUMS.txt` and a separate
`decx-pi-<version>.tar.gz` plus `decx-pi-SHA256SUMS.txt` (extension and execution
skills), and smokes the bundles and launchers on all four architectures before publishing), `decx-afe.yml` (crate fmt/clippy on Linux; test,
release build and
a `--help` smoke on Linux, macOS and Windows;
Windows arm64 cross check; tag `tools-v*`, checked against
`subprojects/decx-afe/Cargo.toml`, builds the six `afe-<version>-<platform>` archives plus
`afe-SHA256SUMS.txt`), `decx-droidasc.yml` (the manager creates a private venv,
installs the published PyPI package and invokes `droidasc --help` across platforms;
no source archive is published) and
`decx-kuna.yml` (pin, manifest and
upstream-skill-copy contract on every change; release install on Linux, macOS and Windows
weekly and on demand; every 12 hours a scheduled job compares the pinned tag with upstream's
latest release and pushes nothing when there is nothing newer — a new release moves the
submodule gitlink, re-copies the skill reference and pushes the commit. No local Kuna
release mirror is published because installs use the official upstream assets directly).
The manager and crate jobs are offline — the manager's install tests use fixture
archives, fake toolchains and temporary prefixes — while the two tool workflows
deliberately exercise the real install paths (`pip install` into the tool's venv, the Kuna
release and specs archives); no workflow compiles the vendored upstream checkouts.
The kuna manifest installs from official upstream releases — manifest 2 resolves the
newest stable `v*` tag and verifies each asset against its GitHub REST SHA-256 digest.
Keep README.md and README_zh.md aligned with the actual tools and launcher runtime requirements; do not document removed `decx` commands as current functionality.

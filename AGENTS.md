# AGENTS.md

## Purpose

DECX is a set of agent skills, the toolkit manager that installs the native tools
those skills drive, and the standalone Android Framework Extract (AFE) utility.
It is not a decompiler, unified analysis CLI, plugin runtime, or analysis server.

- APK analysis uses upstream [DroidASC](https://github.com/MG1937/ASC) directly.
- Native binary analysis uses upstream [Kuna](https://github.com/Noelo-Lab/kuna) directly.
- `subprojects/` holds every subproject: its own `README.md`, the toolkit manifest
  `decx-<id>.json` the manager reads, and for a vendored tool its pinned `source/`
  checkout. The agent skill that drives it lives in `skills/decx-<id>/`. DECX's own
  `decx-afe/` sits beside the vendored upstream checkouts `decx-droidasc/source` and
  `decx-kuna/source`, which are git submodules pinned by `.gitmodules` and the
  superproject gitlinks.
- Android framework collection and preprocessing lives in `subprojects/decx-afe/`.
- Agent workflows (the process skills plus one skill per tool) live in `skills/`; read
  `skills/AGENTS.md` before editing them.
- `decx/` is the toolkit installer and manager: a Node CLI that discovers the tools in
  `subprojects/decx-<id>/decx-<id>.json`, installs, locates and runs them, and reports what is
  installed and what this host supports. Development runs TypeScript directly on
  Node 22.18+; releases ship compiled JavaScript with bundled tool manifests. It prints
  JSON on stdout and keeps no runtime dependencies. It is the only
  install path — installs are declared as data, never as per-platform scripts.

## Boundaries

Do not restore the removed Go CLI, manifest registry, QuickJS runtime, JADX
integration, HTTP adapters, or DECX session protocol. Do not duplicate upstream
command trees or promise equivalent capabilities between analyzers. Prefer native
help and output. A thin executable launcher selecting an installed interpreter or
resource directory is acceptable; an analysis-command translation layer is not.

AFE is a native Rust program, not a JavaScript extension. Keep Android collection,
APEX handling, ext4/EROFS parsing and archive processing there. Preserve system-tool
fallbacks and actionable errors for unsupported image features. AFE produces files;
it does not start an analyzer or own analysis sessions.

The manager must not silently modify shell startup files, overwrite unrelated tools, or
install agent plugins. Use explicit prefixes, staged installs and clear requirements, and
never run an install against the user's real home directory during tests. Upstream source
builds execute third-party code: record what was fetched, built and verified in
`share/<id>/PROVENANCE`. Installs follow each tool's manifest — kuna a pinned release
archive plus its compiled SLEIGH specs, droidasc a private venv over the pinned submodule,
afe a prebuilt `tools-v*` archive when one carries an AFE build for the platform and
otherwise a cargo build. The rules behind them (the `env` launcher contract, `release.version`
pins, `--version <tag>`, when `--from-source` is offered) are documented in `decx/README.md`.
CI builds and packages the pinned upstream checkouts without modifying their source.
Installation prefers upstream distribution; repository release assets are fallback sources.
Integrity failures must stop installation, not silently switch sources.

Windows support is part of the contract: installing, using and compiling must work there
as well as on macOS and Linux. The manager is plain Node, so it runs natively in
PowerShell or cmd — never require Git Bash, `uname`, `bash` or POSIX tools at install
time — and it installs `.exe`/`.cmd` names there. Keep the Windows branches covered by
tests. Rust code must build and pass tests under MSVC (no POSIX-only APIs, no `/bin/sh`
assumptions in shipped code).

The manager in `decx/` manages tools, not runtimes: it probes for Node, Python, Rust and
Git and reports the exact shortfall instead of installing them (agents run on Node
already; `mise`/`nvm`/`rustup` remain the user's choice). It also does not translate
analysis commands — `decx run` reaches a tool's own help and output unchanged. Keep it
manifest-driven: a new tool is a new `subprojects/decx-<id>/decx-<id>.json` (with its own
`README.md` and `skills/<id>/`), never new
special-cased code. Installs keep every executable in `$DECX_HOME/bin` and each payload
in `$DECX_HOME/share/<id>/PROVENANCE`, and link the executables into `~/.local/bin`
(`--links`, `$DECX_LINKS_DIR`; `.cmd` shims on Windows). Keep that layout and those
PROVENANCE keys stable so `decx run` and any reader of `share/<id>/PROVENANCE` keep
working on existing installs; the legacy `$DECX_HOME/tools/<id>` shape is not detected or
migrated.

Decx follows WikiSkill's three sibling layers at the workspace root: `raw/` (immutable
execution records), `wiki/` (shared pattern catalog, maintenance log and skill-impact
history) and `skills/` (portable execution procedures). Never nest `raw/` inside `wiki/`,
or a wiki inside each skill. The inference agent uses skills, not the maintenance wiki, so
`SKILL.md` and its bundled resources must retain every task-critical rule; `PURPOSE.md`
maps a skill to its motivating patterns and is never an inference dependency. The
maintenance rules for these layers live in `skills/AGENTS.md`.

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
  envelope. Install tests are offline — fixture archives served locally, fake python/pip
  and cargo on `PATH` — and must never touch the real home directory or the network; pass
  `--home`/`DECX_HOME` with temp dirs.
- Skills: `python3 skills/check-skills.py` verifies frontmatter, names and relative
  links; also verify every documented native command against the supported upstream
  revision. Never invent missing analysis commands.
- Decx: `node --test .pi/extensions/decx/lib.test.ts` runs the extension tests,
  and `node .pi/extensions/decx/cli.ts check` checks the shared workspace
  (frontmatter, card sections, index sync, markdown and wikilink targets; exit 1 on
  errors). Use maintenance tools for routine knowledge updates; reviewed repository
  migrations may edit files directly and must regenerate/check the index. The checkpoint hook is covered by the same tests: it counts rounds and turns,
  keeps the last ten checkpoints per session and repeats the request until the pending
  round is covered.
- Analysis procedure: `decx-vulnhunt` owns the hunting method under the anti-drift
  checkpoint loop; the other skills own per-tool syntax, reports and PoCs. Session
  bookkeeping and the trace → pattern → proposal loop are `decx_*` tools, not skills.

Agent plugins and extension manifests (Codex, Claude) are out of scope: the integration
contract is `skills/` plus the one pi extension that owns the Decx layer
(`.pi/extensions/decx/`); nothing else may register into an agent harness. GitHub runs
workflows only from the repository root, so each subproject and area has its own file
there, scoped to its own `paths:` — keep them in sync when the crate, manifests, skills,
wiki or managed paths change: `decx-cli.yml` (`cd decx && npm ci && npm run typecheck &&
npm test`, plus the JSON-envelope and usage-error smoke runs, on Linux, macOS and Windows
across Node 22.18 and 24), `decx-afe.yml` (crate fmt/clippy on Linux; test, release build and
a `--help` smoke on Linux, macOS and Windows;
Windows arm64 cross check), `decx-droidasc.yml` (the manager's private-venv install over the
pinned checkout, then upstream `main.py --help`) and `decx-kuna.yml` (pin and manifest
contract on every change; release install on Linux, macOS and Windows weekly and on demand).
The manager and crate jobs are offline — the manager's install tests use fixture
archives, fake toolchains and temporary prefixes — while the two tool workflows
deliberately exercise the real install paths (`pip install` into the tool's venv, the Kuna
release and specs archives); the PR workflows never compile the vendored upstream checkouts.
Publishing has one workflow per released piece, each refusing to build when its tag does not
match the pinned version: `release-cli.yml` (tag `decx-v*`, checked against
`decx/package.json`; builds `dist/`, packs `decx-<version>.tar.gz` plus `decx-SHA256SUMS.txt`
and smokes the packed CLI on all three OSes before publishing), `release-afe.yml` (tag
`tools-v*`, checked against `subprojects/decx-afe/Cargo.toml`; the six
`afe-<version>-<platform>` archives plus `afe-SHA256SUMS.txt`), `release-kuna.yml` (tag
`kuna-v*`, checked against the pinned gitlink's tag; mirrors upstream's own release assets
repacked uniformly as zip, falling back to building the pinned checkout for upstream's five
targets with `make specs` only when the upstream release cannot be fetched) and `release-droidasc.yml` (tag `droidasc-v*`; packages the pinned
source tree as `droidasc-<version>-source.tar.gz` plus `droidasc-SHA256SUMS.txt`). The kuna
and droidasc assets are the repository fallback the manifests' `fallbackRelease` blocks point
at; upstream releases stay the primary source.
Keep README.md and README_zh.md aligned with the actual standalone
tools; do not document removed `decx` commands as current functionality.

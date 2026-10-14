# AGENTS.md

## Purpose

DECX is a set of agent skills, the toolkit manager that installs the native tools
those skills drive, and the standalone Android Framework Extract (AFE) utility.
It is not a decompiler, unified analysis CLI, plugin runtime, or analysis server.

- APK analysis uses upstream [DroidASC](https://github.com/MG1937/ASC) directly.
- Native binary analysis uses upstream [Kuna](https://github.com/Noelo-Lab/kuna) directly.
- `third_party/` holds tool source projects and the central toolkit catalog
  `tools.json`. Its root requires `manifest: 1`; each unversioned entry has an
  explicit tool id and `repo: "owner/repo"`; there are no per-directory manifests. The portable execution skills live in `.agents/skills/`;
  the tool-routing skill is `.agents/skills/decx-tool/`, each tool's contract in
  `references/<id>.md`; Kuna's reference is upstream's own skill file copied
  verbatim (frontmatter dropped) and is re-copied, never edited, when the pin moves.
  DECX's own `third_party/afe/` sits beside the direct upstream checkouts
  `third_party/ASC` (MG1937/ASC) and `third_party/kuna` (Noelo-Lab/kuna),
  which are git submodules pinned by `.gitmodules` and the superproject gitlinks.
- Android framework collection and preprocessing lives in `third_party/afe/`.
- The versioned portable execution skills live in `.agents/skills/`; read
  `.agents/skills/AGENTS.md` before editing them. The CLI is the unified install
  and launch entry; skills supply tool routing and execution instructions.
- `decx/` is the toolkit installer and manager: a TypeScript CLI that discovers the tools in
  `third_party/tools.json`, installs, locates and runs them, and reports what is
  installed and what this host supports. Development runs TypeScript directly on
  Node 24.21+; releases ship the public npm package `@jygzyc/decx-cli`, with a
  single bundled JavaScript executable and embedded tool catalog. Node is required
  at runtime; no native manager is published. It prints
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
afe a prebuilt `tools-v*` archive for the platform. Missing assets fail explicitly;
there is no automatic source-build fallback. The rules behind them (the `env`
launcher contract, optional `release.tagPrefix` and `--version <tag>`) are documented in `decx/README.md`.
Without a prefix, enumerate stable release pages and match every declared host
primary/extra asset using the candidate version; never hardcode tool IDs or
assume a bare version's tag. Omitted/null `checksums` requires GitHub REST SHA-256
digests for every download. Explicit checksum files remain supported; missing
integrity metadata fails without fallback. `release.repository` is internal,
derived from required `repo`; raw nested repositories and per-entry `manifest`
are invalid. Optional `requires` is `bin`/`python`/`js`, matching `launch.type`
(or inferred from it); Python 3 probing remains, package-specific minimums belong
to pip metadata. Empty `env: {}` is valid for any runtime, nonempty env remains
binary-only.
Python installs use published packages, never vendored/source-archive recipes.
CI never modifies the pinned upstream checkouts; DroidASC installs directly from PyPI.
Installation prefers upstream distribution; repository release assets are fallback sources.
Integrity failures must stop installation, not silently switch sources.

Windows support is part of the contract: installing, using and compiling must work there
as well as on macOS and Linux. The npm-installed Node CLI runs directly in
PowerShell or cmd — never require Git Bash, `uname`, `bash` or POSIX tools at install
time — and it installs `.exe`/`.cmd` names there. Keep the Windows branches covered by
tests. Rust code must build and pass tests under MSVC (no POSIX-only APIs, no `/bin/sh`
assumptions in shipped code).

The manager in `decx/` manages tools, not runtimes: it probes for Node, Python, Rust and
Git and reports the exact shortfall instead of installing them (agents run on Node
already; `mise`/`nvm`/`rustup` remain the user's choice). It also does not translate
analysis commands — `decx -m <tool>` reaches a tool's own help and output unchanged. Keep it
manifest-driven: a new tool is an entry with an explicit `id` in
`third_party/tools.json` (with a reference in `decx-tool`), never new
special-cased code. Source checkouts retain upstream repository names; AFE is
DECX-owned, not an upstream repository. The catalog uses `decx-tool.schema.json`;
invalid entries are reported separately and do not block valid tools. Installs keep every executable in `$DECX_HOME/bin` and each payload
in `$DECX_HOME/share/<id>/PROVENANCE`, and link the executables into `~/.local/bin`
(`--links`, `$DECX_LINKS_DIR`; `.cmd` shims on Windows). Keep that layout and those
PROVENANCE keys stable so `decx -m <tool>` and any reader of `share/<id>/PROVENANCE` keep
working on existing installs; the legacy `$DECX_HOME/tools/<id>` shape is not detected or
migrated.

The agent integration contract is the portable skills under `.agents/skills/`,
not an agent-specific extension, plugin manifest or maintenance runtime. Compatible
agents discover these versioned skills directly; `npx skills` owns installation,
updates and removal in other projects. Skills come directly from the repository,
independently of CLI releases; never add skill release packaging or custom skill
lifecycle commands. `SKILL.md`, references and scripts must be complete
without repository-local state or initialization commands. Keep private local
archives ignored; never import them into skills or publish target data.

## Validation

- AFE: `cd third_party/afe && cargo build --release && cargo test` (stable Rust);
  `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` must stay clean.
- Manager: `cd decx && npm ci && npm run typecheck && npm test && npm run build`; `node src/cli.ts version` must keep printing one JSON
  envelope. `npm test` builds and exercises the shipped Node bundle, including
  `npm pack`, temporary offline npm prefix installation, npm-created executable
  shims and uninstall. `npm pack` builds through `prepack`; no install lifecycle
  scripts, compiler SDK or runtime npm dependencies are shipped. Tests are
  sequential because packing rebuilds their shared bundle. Linux, macOS and
  Windows gate publication. The manager executes installed `launch.json`
  executable/argv directly, without a shell bridge or legacy launch fallback.
  Install tests are offline — fixture archives served locally, real executables and a local wheel installed
  with real Python/pip into a private venv — and must never touch the real home
  directory or the network; pass `--home`/`DECX_HOME` with temp dirs.
- Skills: `python3 scripts/check-skills.py` verifies frontmatter, names and relative
  links under `.agents/skills/`; run
  `python3 -m unittest discover -s scripts -p 'test_check_skills.py'`
  for discovery and validation failures. Also verify
  documented native commands against the supported upstream revision. Never invent
  missing analysis commands.
- Analysis procedure: `decx-tool` owns per-tool syntax and routing. Invoke tools
  through `decx <tool>` or `decx -m <tool>`; no agent initialization is required.

Agent plugins and extension manifests are out of scope; nothing registers into an
agent harness. GitHub runs workflows only from the repository root. CI covers
DECX-owned components only: the manager, AFE and portable skills. Keep their
`paths:` in sync when the crate, catalog, skills or managed paths change. Third-party acquisition and
release resolution belong to the CLI, never to per-tool Actions or scheduled pin updates. The manager and AFE workflows carry both checks and release publishing:
branch pushes and pull requests run checks, while a matching tag push (or a
`workflow_dispatch` with the `tag` input) runs release jobs,
each refusing to build when its tag does not match the pinned version. `decx-cli.yml`
(`cd decx && npm ci && npm run typecheck &&
npm test`, plus the JSON-envelope and usage-error smoke runs, on Linux, macOS and Windows
on the latest Node 24 release; tag `decx-v*`, checked against `decx/package.json`,
publishes the npm package only after all three platform gates pass. npm trusted
publishing with provenance must be configured on the existing npm package for
`jygzyc/decx` and `decx-cli.yml`. The replacement is `5.0.0`, after legacy `4.3.0`.
Do not publish to npm during tests or ordinary branch pushes), `decx-afe.yml` (crate fmt/clippy on Linux; test,
release build and
a `--help` smoke on Linux, macOS and Windows;
Windows arm64 cross check; tag `tools-v*`, checked against
`third_party/afe/Cargo.toml`, builds the six `afe-v<version>-<platform>` archives plus
`afe-SHA256SUMS.txt`), and `decx-skills.yml` (three-platform portable skill
validation and validator tests, with no scheduled maintenance or runtime dependencies).
The manager and crate jobs are offline — the manager's install tests use fixture
archives, fake toolchains and temporary prefixes. All manager tests exercise public
CLI subprocesses and real file/process outcomes, not imported functions or mocked
builtins. Third-party installation stays manifest-driven in the CLI: PyPI packages
use a private venv; release archives use generic asset-aware stable discovery and
mandatory SHA-256 verification. Actions neither query upstream tool releases nor
update their source pins. Pins and the verbatim Kuna skill copy are updated explicitly.
Live analysis suites remain available for manual validation with installed tools:
`npm run test:functional:droidasc` checks APK decompilation, manifest decoding and DEX
references; `npm run test:functional:kuna` checks decompilation, recompilation and
behavior. Use an explicit temporary `DECX_HOME`; the suites fail on absent tools
(no silent skips) and run the built Node bundle.
These suites are not part of offline CI. No workflow compiles vendored upstream
checkouts or publishes their releases; the CLI has no per-tool release rule. Existing `afe-<version>` release archives do not match the catalog's
`afe-v<version>` names: publishing matching archives is required, never add a
legacy-name fallback or silently rewrite the catalog.
Keep README.md and README_zh.md aligned with the actual tools and launcher runtime requirements; do not document removed `decx` commands as current functionality.

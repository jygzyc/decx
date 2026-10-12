# DECX

Agent workflows for reverse engineering with native tools, plus **Android Framework
Extract (AFE)** for collecting and preparing Android framework files.

DECX does not implement a decompiler or wrap tools behind a unified command API.
Use each analyzer's native interface:

| Task | Tool |
| --- | --- |
| APK / DEX analysis | [DroidASC](https://github.com/MG1937/ASC) |
| Native binary analysis | [Kuna](https://github.com/Noelo-Lab/kuna) |
| Android framework collection and preprocessing | [AFE](third_party/afe/README.md) |
| Analysis methodology, findings, reports and PoCs | [Execution skill](skills/decx-tool/) |

## Install and manage tools

The toolkit manager lives in [`decx/`](decx/README.md) — an npm CLI requiring Node 24.21+,
with no runtime dependencies and an embedded tool catalog. It installs the tools above
and reports what this host supports. Once `5.0.0` is published, install it with
(the existing npm `latest` is still legacy `4.3.0` until then):

```bash
npm install -g @jygzyc/decx-cli
decx install kuna        # upstream release for this platform, plus compiled SLEIGH specs
decx install droidasc    # private venv, pip install droidasc from PyPI
decx install afe         # prebuilt tools-v release for this platform
decx kuna --help         # runs the tool itself; arguments are never translated
decx -m kuna --help      # equivalent explicit form
decx help install        # usage for the manager or one command
```

Tools are unversioned entries with explicit `id` and GitHub `repo: "owner/repo"`
in `third_party/tools.json`, whose root requires `manifest: 1`, never code.
Optional `requires` is `bin`/`python`/`js` and must match `launch.type` (inferred
when omitted); empty `env: {}` is valid for any runtime. Archive installs discover
the newest stable release carrying all declared host assets, skipping unrelated
releases. Omitted/null `checksums` mandates GitHub REST SHA-256 digests for primary
and extra assets; explicit checksum filenames and tag prefixes remain supported.
Bare versions match listed tags/assets without assuming `v`; full tags can be
selected directly, still verified. Executables
and payloads live under `$DECX_HOME` (`bin/`, `share/<id>/` with a `PROVENANCE` record); the
manager installs tools, not language runtimes, and each tool keeps its own arguments and output.
Layout, `--links` and install rules: [`decx/README.md`](decx/README.md).
The manager ships as a single JavaScript bundle through npm; Node is required at runtime.
It does not ship a separate native executable.

### Platform support

macOS, Linux and Windows are supported for installing, using and building. The manager is
available as an npm-installed Node CLI. It runs in PowerShell or cmd on Windows
and install `.exe`/`.cmd` names there; tool installation needs no Git Bash, `uname` or POSIX tooling.

| Tool | macOS / Linux | Windows |
| --- | --- | --- |
| DroidASC | `$PREFIX/bin/droidasc` | `%PREFIX%\bin\droidasc.cmd` (launcher for `%PREFIX%\runtime\droidasc\Scripts\droidasc.exe`) |
| Kuna | `bin/kuna` (launcher for `share/kuna/bin/kuna`), `specs/` | `bin\kuna.cmd` (launcher for `share\kuna\bin\kuna.exe`), `specs\` |
| AFE | `bin/afe` | `bin\afe.exe` |

What each platform needs:

- **DroidASC** — Python 3 with `venv`; DECX probes the interpreter, while the
  published PyPI package metadata/pip enforces its minimum (currently >=3.10).
- **Kuna** — installs the upstream release (macOS/Linux arm64+x86_64, Windows x86_64) with the
  compiled SLEIGH specs as a separate asset; the generated launcher exports `KUNA_SPECS`. There is
  no Windows arm64 release, and `decx install kuna` reports that instead of building the reference
  checkout.
- **AFE** — installs a compiled, platform-specific GitHub Release asset (built from DECX's own `third_party/afe`; Rust/MSVC on Windows). Its
  ext4/EROFS/ZIP readers are fully native, so no external extractor is needed on any platform.

AFE only prepares artifacts: device collection needs ADB, unsupported image features fail with an
actionable error, and picking an analyzer for the result stays the caller's job. See the
[AFE README](third_party/afe/README.md).

## Skills

Root [`skills/`](skills/) is the installable source; [decx-tool](skills/decx-tool/) routes between the
installed tools, and each tool's own commands, output and error contract, and install
method live in its `references/` file — `droidasc.md`, `kuna.md` (upstream's own skill,
copied verbatim) and `afe.md`. This skill works with the separately installed DECX CLI
in any Agent Skills-compatible harness, without the pi extension or a source clone.
The manager does not install skills. From the target project, install a skill
with `npx skills add jygzyc/decx --skill <skill-name>` (for example
`--skill decx-tool`; choose project-level installation
in `.agents/skills/`). The package installer, not DECX, owns skill installation.

The pi extension implements the [WikiSkill](https://arxiv.org/html/2608.27454) §3 loop as commands and tools, not as a second agent skill.

The extension is optional and source-only, separate from the npm CLI package.
See its [setup instructions](.pi/extensions/decx/README.md); it is not installed by npm.
In any project, `/decx init` creates a fresh `.decxwiki/{raw,wiki}` and an **empty**
`.agents/skills/` directory; it never downloads or copies a skill. Install
`decx-tool` separately with `npx skills` as above.
The extension's `/decx-wiki` command (not a separate skill) then consolidates
execution traces, updates the wiki and checks its structure.
Old repository patterns, traces and former skill content are local-only in
ignored `archive/legacy-knowledge/`; init never imports them. Root `skills/`
contains the current installable execution skill and is never treated as a wiki.

The pi extension enforces inference/maintenance/proposal tool access and applies candidates with measured-score gating and skill rollback. See [the workflow and access boundary](.pi/extensions/decx/README.md).

```text
.decxwiki/                   # initialized in each project
  raw/traces/                # immutable execution records
  wiki/                      # pattern catalog, log and proposal ledger
    patterns/
    index.md
    logs.md
    skill-impact.md
.agents/skills/              # empty after init; npx skills installs decx-tool here
```

The extension is installed in pi separately, not copied into `.decxwiki/`.

Execution reads skills and never the wiki; the maintainer consolidates raw records into the wiki,
the proposer derives a single-skill change, validation decides whether to keep it, and rejection
rolls back the skill, never the wiki. Imported pages are bootstrap knowledge and the structural
checks are not a validation score. Raw records are gitignored by default because they may contain
target data; publish only reviewed evidence.

## Development

```bash
cd third_party/afe && cargo build --release && cargo test
cd decx && npm ci && npm test
npm ci --prefix .pi/extensions/decx
python3 skills/check-skills.py && node --test .pi/extensions/decx/*.test.ts
project=$(mktemp -d); node .pi/extensions/decx/cli.ts init --root "$project" && node .pi/extensions/decx/cli.ts check --root "$project"
```

AGENTS.md §Validation lists the full gate per area. `.github/workflows/` contains
only DECX-owned checks: `decx-cli.yml`, `decx-afe.yml` and `decx-knowledge.yml`, scoped
to their paths. Branch pushes and PRs run checks; release tags publish the npm CLI
and AFE assets. Manager and crate gates run offline (fixture archives, fake toolchains,
temp prefixes). Actions do not install upstream analyzers, query their releases,
update their source pins or compile vendored upstream checkouts. The CLI reads
`third_party/tools.json` and installs upstream distributions directly. Releases:
`decx-v*` → the public npm package `@jygzyc/decx-cli` (three-platform tests gate
publication; npm trusted publishing must be configured first); `tools-v*` →
the six `afe-v<version>-<platform>` archives +
`afe-SHA256SUMS.txt`. The catalog uses REST digests by default; the checksum file
remains available for explicit custom configurations. Existing `afe-<version>`
archives do not match the new names: matching assets must be published; no legacy
name fallback is provided. Neither DroidASC nor Kuna needs a repository release.
Source pins and the verbatim Kuna skill reference are updated explicitly, not by
Actions. `decx install kuna` resolves matching upstream release assets and verifies
GitHub REST SHA-256 digests. Live analysis checks remain available manually after
installing tools into an explicit temporary `DECX_HOME`: run
`npm --prefix decx run test:functional:kuna` or
`npm --prefix decx run test:functional:droidasc`.
They fail when tools are absent and are not part of offline CI.

## Scope and non-goals

DECX ships no analysis CLI, session manager, analyzer registry, analysis-plugin runtime, JADX
integration or analysis server, and it never translates one analyzer's command tree onto another;
`decx/` installs, locates and reports tools and passes arguments through unchanged. DroidASC and
Kuna are upstream tools used as they are. Adapters exist only for a demonstrated native-tool
limitation.

`third_party/tools.json` is the single tool catalog; tool IDs are independent of source
paths. `third_party/afe/` is DECX's own Rust tool. `third_party/ASC` (MG1937/ASC) and
`third_party/kuna` (Noelo-Lab/kuna) are direct pinned upstream git submodules
(see `.gitmodules`), with their upstream READMEs and licenses unchanged.
The skill references remain under `skills/decx-tool/`; see
[the source layout and install caveats](third_party/README.md).

## License

See [LICENSE](LICENSE). DroidASC and Kuna are distributed under their respective upstream
licenses. Installing them does not change those licenses.

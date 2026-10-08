# DECX

Agent workflows for reverse engineering with native tools, plus **Android Framework
Extract (AFE)** for collecting and preparing Android framework files.

DECX does not implement a decompiler or wrap tools behind a unified command API.
Use each analyzer's native interface:

| Task | Tool |
| --- | --- |
| APK / DEX analysis | [DroidASC](https://github.com/MG1937/ASC) |
| Native binary analysis | [Kuna](https://github.com/Noelo-Lab/kuna) |
| Android framework collection and preprocessing | [AFE](subprojects/decx-afe/README.md) |
| Analysis methodology, findings, reports and PoCs | [Execution skill](skills/decx-tool/) |

## Install and manage tools

The toolkit manager lives in [`decx/`](decx/README.md) — a Node CLI (Node 24.21+, no build step,
no dependencies, one JSON object per command) that installs the tools above and reports what this
host supports.

```bash
decx install kuna        # upstream release for this platform, plus compiled SLEIGH specs
decx install droidasc    # private venv, pip install droidasc from PyPI
decx install afe         # prebuilt tools-v release for this platform
decx kuna --help         # runs the tool itself; arguments are never translated
decx -m kuna --help      # equivalent explicit form
decx help install        # usage for the manager or one command
```

Tools are declared as data in `subprojects/decx-<id>/decx-<id>.json`, never as code. Executables
and payloads live under `$DECX_HOME` (`bin/`, `share/<id>/` with a `PROVENANCE` record); the
manager installs tools, not language runtimes, and each tool keeps its own arguments and output.
Layout, `--links` and install rules: [`decx/README.md`](decx/README.md). Direct native compilation
with scriptc 0.2.6 builds the complete manager (`cd decx && npm run setup:scriptc && npm run build:scriptc && npm run test:native`).
The native executable does not require Node; Node remains required for source development and the JavaScript release.
Local native lifecycle tests pass on macOS arm64; CI gates Linux x64/arm64, macOS arm64 and Windows x64.

### Platform support

macOS, Linux and Windows are supported for installing, using and building. The manager is
available as a Node CLI and a compiled native executable. Both run in PowerShell or cmd on Windows
and install `.exe`/`.cmd` names there; tool installation needs no Git Bash, `uname` or POSIX tooling.

| Tool | macOS / Linux | Windows |
| --- | --- | --- |
| DroidASC | `$PREFIX/bin/droidasc` | `%PREFIX%\bin\droidasc.cmd` (launcher for `%PREFIX%\runtime\droidasc\Scripts\droidasc.exe`) |
| Kuna | `bin/kuna` (launcher for `share/kuna/bin/kuna`), `specs/` | `bin\kuna.cmd` (launcher for `share\kuna\bin\kuna.exe`), `specs\` |
| AFE | `bin/afe` | `bin\afe.exe` |

What each platform needs:

- **DroidASC** — Python >=3.10 with `venv`; DECX installs the published PyPI package
  and its dependencies using the virtualenv's pip.
- **Kuna** — installs the upstream release (macOS/Linux arm64+x86_64, Windows x86_64) with the
  compiled SLEIGH specs as a separate asset; the generated launcher exports `KUNA_SPECS`. There is
  no Windows arm64 release, and `decx install kuna` reports that instead of building the reference
  checkout.
- **AFE** — installs a compiled, platform-specific GitHub Release asset (built from `subprojects/decx-afe`; Rust/MSVC on Windows). Its
  ext4/EROFS/ZIP readers are fully native, so no external extractor is needed on any platform.

AFE only prepares artifacts: device collection needs ADB, unsupported image features fail with an
actionable error, and picking an analyzer for the result stays the caller's job. See the
[AFE README](subprojects/decx-afe/README.md).

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

Download the `decx-pi-<version>.tar.gz` release bundle, unpack it and run
`pi install /path/to/decx-pi-<version>`; no repository clone is required. In any
project, `/decx init` creates a fresh `.decxwiki/{raw,wiki}` and an **empty**
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
cd subprojects/decx-afe && cargo build --release && cargo test
cd decx && npm ci && npm test
python3 skills/check-skills.py && node --test .pi/extensions/decx/*.test.ts
project=$(mktemp -d); node .pi/extensions/decx/cli.ts init --root "$project" && node .pi/extensions/decx/cli.ts check --root "$project"
```

AGENTS.md §Validation lists the full gate per area; CI is one workflow per subject under
`.github/workflows/` — `decx-cli.yml`, `decx-afe.yml`, `decx-droidasc.yml` and
`decx-kuna.yml` — each scoped to its own paths: branch pushes and PRs run checks, while release tags
publish manager and AFE assets. DroidASC and Kuna use upstream distributions directly. The manager and crate gates run offline
(fixture archives, fake toolchains, temp prefixes); the DroidASC and Kuna workflows
deliberately exercise the real install paths, and the PR workflows never compile the
vendored upstream checkouts. Releases: `decx-v*` → `decx-<version>.tar.gz` +
`decx-SHA256SUMS.txt` and `decx-pi-<version>.tar.gz` +
`decx-pi-SHA256SUMS.txt`; `tools-v*` → the six `afe-<version>-<platform>` archives +
`afe-SHA256SUMS.txt`. Neither DroidASC nor Kuna needs a repository release.
Kuna tracks upstream on its own: every 12 hours its workflow compares the pinned tag
with upstream's latest release and pushes nothing when there is nothing newer — a new
release moves the submodule pin, re-copies the skill reference and pushes the commit.
`decx install kuna` installs official upstream `v*` archives, verifying GitHub REST
asset SHA-256 digests.

## Scope and non-goals

DECX ships no analysis CLI, session manager, analyzer registry, analysis-plugin runtime, JADX
integration or analysis server, and it never translates one analyzer's command tree onto another;
`decx/` installs, locates and reports tools and passes arguments through unchanged. DroidASC and
Kuna are upstream tools used as they are. Adapters exist only for a demonstrated native-tool
limitation.

`subprojects/` holds every subproject, and each one is self-contained: its own `README.md`, the
skill reference under `skills/decx-tool/`, and the `decx-<id>.json` manifest the manager reads.
`decx-afe/` is DECX's own Rust tool; `decx-droidasc/` and `decx-kuna/` pin the upstream checkout as
a git submodule under `source/` (see `.gitmodules`).

## License

See [LICENSE](LICENSE). DroidASC and Kuna are distributed under their respective upstream
licenses. Installing them does not change those licenses.

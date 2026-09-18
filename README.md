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
| Analysis methodology, findings, reports and PoCs | [Skills](skills/) |

## Install and manage tools

The toolkit manager lives in [`decx/`](decx/README.md) — a Node CLI (Node 22.18+, no build step,
no dependencies, one JSON object per command) that installs the tools above and reports what this
host supports.

```bash
decx install kuna        # upstream release for this platform, plus compiled SLEIGH specs
decx install droidasc    # private venv over the pinned submodule
decx install afe         # prebuilt tools release, else cargo build of subprojects/decx-afe
decx run kuna --help     # runs the tool itself; arguments are never translated
decx help install        # usage for the manager or one command
```

Tools are declared as data in `subprojects/decx-<id>/decx-<id>.json`, never as code. Executables
and payloads live under `$DECX_HOME` (`bin/`, `share/<id>/` with a `PROVENANCE` record); the
manager installs tools, not language runtimes, and each tool keeps its own arguments and output.
Layout, `--links` and install rules: [`decx/README.md`](decx/README.md).

### Platform support

macOS, Linux and Windows are supported for installing, using and building. The manager is
plain Node, so it runs in PowerShell or cmd on Windows and installs `.exe`/`.cmd` names
there; no Git Bash, `uname` or POSIX tooling is involved.

| Tool | macOS / Linux | Windows |
| --- | --- | --- |
| DroidASC | `$PREFIX/bin/droidasc` | `%PREFIX%\bin\droidasc.cmd` (launcher for `%PREFIX%\share\droidasc\venv\Scripts\python.exe`) |
| Kuna | `bin/kuna` (launcher for `share/kuna/bin/kuna`), `specs/` | `bin\kuna.cmd` (launcher for `share\kuna\bin\kuna.exe`), `specs\` |
| AFE | `bin/afe` | `bin\afe.exe` |

What each platform needs:

- **DroidASC** — Python 3.11/3.12 (64-bit) with `venv`; every pinned dependency ships a
  `win_amd64` wheel, so no compiler is needed.
- **Kuna** — installs the upstream release (macOS/Linux arm64+x86_64, Windows x86_64) with the
  compiled SLEIGH specs as a separate asset; the generated launcher exports `KUNA_SPECS`. There is
  no Windows arm64 release, and `decx install kuna` reports that instead of building the reference
  checkout.
- **AFE** — always built from this repository (`subprojects/decx-afe`, Rust; MSVC on Windows). Its
  optional external extractors (`debugfs`, `fsck.erofs`, `extract.erofs`) have no Windows builds,
  so on Windows AFE always uses its native ext4/EROFS/ZIP readers.

AFE only prepares artifacts: device collection needs ADB, unsupported image features may fall back
to platform tools, and picking an analyzer for the result stays the caller's job. See the
[AFE README](subprojects/decx-afe/README.md).

## Skills

The repository's [skills](skills/) are one per analysis surface and one per tool: `decx-init`,
`decx-vulnhunt`, `decx-report` and `decx-poc` are the process skills, while `decx-droidasc`,
`decx-kuna` and `decx-afe` each drive one installed tool and carry that tool's own install, run
and error contract. Point the agent harness at `skills/`. The manager does not install skills.

DECX follows [WikiSkill](https://arxiv.org/html/2608.27454) §3: a shared workspace with three
**sibling** layers, not a wiki inside every skill.

```text
raw/                         # immutable execution records (private by default)
  traces/                    # one immutable file per session trace
wiki/
  index.md                   # shared pattern catalog
  patterns/                  # consolidated experience, not execution instructions
  logs.md                    # maintainer log (seeded; written only with log: true)
  skill-impact.md            # proposal ledger (seeded; written by decx_propose)
skills/
  <name>/
    SKILL.md                 # complete execution procedure
    PURPOSE.md               # maintenance-only links to motivating patterns
    references/              # optional executable reference material
.pi/extensions/decx/     # pi integration, outside the three knowledge layers
```

Execution reads skills and never the wiki; the maintainer consolidates raw records into the wiki,
the proposer derives a single-skill change, validation decides whether to keep it, and rejection
rolls back the skill, never the wiki. Imported pages are bootstrap knowledge and the structural
checks are not a validation score. Raw records are gitignored by default because they may contain
target data; publish only reviewed evidence.

## Development

```bash
cd subprojects/decx-afe && cargo build --release && cargo test
cd decx && npm ci && npm test
python3 skills/check-skills.py && node --test .pi/extensions/decx/lib.test.ts && node .pi/extensions/decx/cli.ts check
```

AGENTS.md §Validation lists the full gate per area; CI is one workflow per subject under
`.github/workflows/` — `decx-cli.yml`, `decx-afe.yml`, `decx-droidasc.yml` and
`decx-kuna.yml` — each scoped to its own paths. The manager and crate gates run offline
(fixture archives, fake toolchains, temp prefixes); the DroidASC and Kuna workflows
deliberately exercise the real install paths, and the PR workflows never compile the
vendored upstream checkouts. Publishing is one workflow per piece: `release-cli.yml`
(`decx-v*` → `decx-<version>.tar.gz` + `decx-SHA256SUMS.txt`), `release-afe.yml`
(`tools-v*` → the six `afe-<version>-<platform>` archives + `afe-SHA256SUMS.txt`),
`release-kuna.yml` (`kuna-v*` → builds the pinned checkout for upstream's five targets +
compiled specs) and `release-droidasc.yml` (`droidasc-v*` → the pinned source tarball). The
kuna and droidasc assets back the manifests' `fallbackRelease` blocks; upstream releases stay
the primary install source.

## Scope and non-goals

DECX ships no analysis CLI, session manager, analyzer registry, embedded JavaScript runtime, JADX
integration or analysis server, and it never translates one analyzer's command tree onto another;
`decx/` installs, locates and reports tools and passes arguments through unchanged. DroidASC and
Kuna are upstream tools used as they are. Adapters exist only for a demonstrated native-tool
limitation.

`subprojects/` holds every subproject, and each one is self-contained: its own `README.md`, the
skill that drives it under `skills/`, and the `decx-<id>.json` manifest the manager reads.
`decx-afe/` is DECX's own Rust tool; `decx-droidasc/` and `decx-kuna/` pin the upstream checkout as
a git submodule under `source/` (see `.gitmodules`).

## License

See [LICENSE](LICENSE). DroidASC and Kuna are distributed under their respective upstream
licenses. Installing them does not change those licenses.

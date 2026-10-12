# Tool sources and catalog

[`tools.json`](tools.json) is the manager's single tool catalog, validated by
[`decx-tool.schema.json`](decx-tool.schema.json). Its root requires `manifest: 1`;
the `tools` array contains unversioned objects with explicit unique IDs (`afe`,
`droidasc`, `kuna`) and required GitHub `repo: "owner/repo"`, not per-directory
manifests. `requires` is an optional runtime string matching `launch.type`
(inferred when omitted), and empty `env: {}` is allowed for every runtime. Source directory names do not determine tool IDs.

| Directory | Ownership and purpose |
| --- | --- |
| [afe/](afe/README.md) | DECX's own Rust utility, **not an upstream repository**; [Cargo.toml](afe/Cargo.toml) declares Apache-2.0 licensing. |
| [ASC/](ASC/README.md) | Direct pinned git submodule of [MG1937/ASC](https://github.com/MG1937/ASC), the upstream DroidASC repository; reference source, not the install payload. |
| [kuna/](kuna/README.md) | Direct pinned git submodule of [Noelo-Lab/kuna](https://github.com/Noelo-Lab/kuna); reference source for release tracking and the copied upstream skill, not the install payload. |

[`.gitmodules`](../.gitmodules) records upstream URLs; the superproject gitlinks
record the exact checkout pins. Upstream READMEs, licenses and notices remain
unchanged in the upstream roots and govern that code; see [DECX's LICENSE](../LICENSE)
for the surrounding project. Catalog settings and tool IDs are independent of
checkout pins. Tool contracts live in [`skills/decx-tool/references/`](../skills/decx-tool/references/).
Kuna's reference is copied verbatim from `kuna/skills/kuna/SKILL.md` without
frontmatter, never edited locally.

## Install caveats

The manager does not build these source trees or fall back to source builds.
See the [manager guide](../decx/README.md) for catalog fields and install layout.

- **AFE** installs DECX's prebuilt platform-specific `afe-v<version>-<platform>`
  assets under `tools-v*` tags. Generic discovery skips unrelated manager releases
  and requires all declared assets. Omitted/null `checksums` requires GitHub REST
  SHA-256 digests; `afe-SHA256SUMS.txt` is available for explicit custom settings.
  Existing `afe-<version>` archives no longer match; matching assets must be
  published without a legacy-name fallback. Missing assets fail explicitly. ADB is needed for device
  collection; local development builds the DECX-owned crate in `afe/`.
- **DroidASC** installs the published `droidasc` PyPI package and dependencies
  into `$DECX_HOME/runtime/droidasc`, a private venv. Python 3 with `venv` must
  already be available; package metadata/pip enforces the upstream minimum
  (currently >=3.10). DECX does not install Python. `--version` selects a
  published package version. `$DECX_HOME/share/droidasc/PROVENANCE` records the
  installed version, interpreter and pip command; no upstream checkout is copied.
- **Kuna** installs official stable upstream `v*` release archives and the
  separate `kuna-v<version>-specs.tar.gz` from the same release. Both must have
  matching GitHub REST SHA-256 asset digests; missing or mismatched digests fail.
  Binaries and specs land in `$DECX_HOME/share/kuna/`; launchers export
  `KUNA_SPECS=$DECX_HOME/share/kuna/specs`. Compiled specs are required to decode
  instructions. Releases support Linux/macOS arm64 and amd64, and Windows amd64;
  Windows arm64 has no upstream asset. `--version <tag>` selects a release.

```sh
decx install droidasc
decx update droidasc --version 0.1.0
decx droidasc --help
decx install kuna
decx kuna --version
decx -m kuna --help
```

Managed executables live in `$DECX_HOME/bin`; managed PATH links use `~/.local/bin`
by default (`.cmd` shims on Windows). Offline manager tests use local fixture
releases and a local wheel, never PyPI/GitHub or the real home directory. The
DroidASC and Kuna workflows separately exercise real upstream installations and
functional analysis on Linux, macOS and Windows.

Every 12 hours, Kuna's `sync-pin` workflow compares the pinned gitlink with the
latest upstream release. A new release updates the direct `kuna` gitlink and
re-copies the upstream skill reference; nothing is pushed when the pin is current.
There is no DECX mirror release or locally modified upstream source.

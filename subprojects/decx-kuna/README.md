# decx-kuna — native binary decompilation (upstream Kuna)

DECX installs the official [Kuna](https://github.com/Noelo-Lab/kuna) release
archives directly. The vendored `source/` checkout is pinned for the agent skill
reference and release tracking; the manager never compiles it.

## Contents

| Path | Purpose |
| --- | --- |
| `decx-kuna.json` | Manifest: official `Noelo-Lab/kuna` `v*` releases, platform archives, compiled specs, GitHub asset SHA-256 digests, three executables and the `KUNA_SPECS` launcher environment. |
| `skills/decx-tool/references/kuna.md` | Upstream Kuna's skill copied verbatim without frontmatter. |
| `source/` | Pinned upstream git submodule, not an install payload. |

## Install

```sh
decx install kuna        # latest official stable v* release + compiled SLEIGH specs
decx kuna --version      # forwards arguments and output unchanged
decx -m kuna --help      # equivalent explicit form
```

The platform archive and `kuna-v<version>-specs.tar.gz` are downloaded from the
same upstream Release. GitHub REST asset metadata publishes a SHA-256 digest
for each; DECX verifies **both** archives before extracting them and refuses
missing or mismatched digests. No repository mirror or checksum asset is
required. `--version <tag>` selects an older official release explicitly.

The binaries and specs land under `$DECX_HOME/share/kuna/`; wrappers in
`$DECX_HOME/bin/{kuna,decomp_dbg,slacomp}` export
`KUNA_SPECS=$DECX_HOME/share/kuna/specs`. Managed links in `~/.local/bin` expose
all three executables (`.cmd` shims on Windows). Without the compiled specs,
Kuna cannot decode instructions.

Supported release platforms: `linux-amd64`, `linux-arm64`, `darwin-amd64`,
`darwin-arm64`, `win-amd64`. Windows arm64 has no upstream release asset.

## Verification

```sh
decx install kuna --home /tmp/decx-home --links /tmp/decx-links
test -d /tmp/decx-home/share/kuna/specs/Ghidra/Processors
node decx/src/cli.ts --home /tmp/decx-home kuna --version
```

The weekly `release-install` job in `.github/workflows/decx-kuna.yml` exercises
the real upstream download on Linux, macOS and Windows. Offline manager tests
use local fixture releases with both valid and invalid asset digests.

## Upstream tracking

Every 12 hours, `sync-pin` compares the vendored gitlink with the latest Kuna
release. On a change it updates the pin, re-copies the upstream skill reference,
and publishes a repository `kuna-v<version>` mirror tag. The mirror workflow
still repacks archives as zip and publishes a checksum file, but the manager
now prefers and installs official upstream releases. DECX does not modify the
vendored checkout or the copied upstream skill.

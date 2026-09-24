# decx-kuna — native binary decompilation (upstream Kuna)

The subproject around [Kuna](https://github.com/Noelo-Lab/kuna), the native
decompiler for ELF/PE/Mach-O. DECX installs this repository's `kuna-v*` mirrors
of upstream's release archives and never compiles kuna (`cargo` is not needed
anywhere in this path), so `source/` is vendored for reference only.

## In this repository

| Path | What it is |
| --- | --- |
| `decx-kuna.json` | the toolkit manifest `decx` reads: the release repository (this repository's mirrors) and the `kuna-v` tag prefix the manager resolves, the per-platform asset names, the second `specs` asset, the checksums file, `KUNA_SPECS`, the three executables and the verify probe. |
| `skills/decx-tool/` | the agent skill that drives the installed launcher — upstream Kuna's own skill (`source/skills/kuna/SKILL.md`) copied verbatim into `references/kuna.md`, with only the frontmatter dropped. |
| `source/` | the vendored upstream checkout, pinned as a git submodule (`git submodule status subprojects/decx-kuna/source`). Installs never use it. |

## Install

```sh
decx install kuna        # this repository's newest kuna-v* release for this platform + compiled SLEIGH specs
decx -m kuna --help      # the tool's own interface, arguments untouched
```

Two assets are downloaded from the newest stable `kuna-v*` release of this
repository: the platform archive and `kuna-v<version>-specs.zip`, verified
against `kuna-SHA256SUMS.txt` (upstream publishes no checksum file; the mirror
adds one).

The payload lands in `$DECX_HOME/share/kuna/` (`bin/`, `specs/Ghidra/Processors/`,
`PROVENANCE`), and `$DECX_HOME/bin/{kuna,decomp_dbg,slacomp}` are launchers that
export `KUNA_SPECS=$DECX_HOME/share/kuna/specs` before running the packaged
binary; without it Kuna decodes nothing (`No sleigh specification for
AARCH64:LE:64:v8A`). `decx install` also links `kuna` into `~/.local/bin`
(a `.cmd` shim on Windows).

Platforms with an asset: `linux-amd64`, `linux-arm64`, `darwin-arm64`,
`darwin-amd64`, `win-amd64`. The manifest resolves the newest stable `kuna-v*`
tag at install time (`release.tagPrefix`); `decx install kuna --version <tag>`
installs another tag.

## Verify

```sh
decx install kuna --home /tmp/decx-home --links /tmp/decx-links
test -f /tmp/decx-home/share/kuna/PROVENANCE
test -d /tmp/decx-home/share/kuna/specs/Ghidra/Processors
env -u KUNA_SPECS decx --home /tmp/decx-home -m kuna functions /tmp/decx-home/share/kuna/bin/slacomp
```

Run that sequence after every pin move, on each platform: it checks the payload, the store
launchers (each must contain `KUNA_SPECS=`), the PATH link, and a real `kuna` invocation
whose environment has no `KUNA_SPECS`, which proves the launcher supplies it. It downloads
the release, so it stays a manual acceptance check — the weekly `release-install` job in
`.github/workflows/decx-kuna.yml` covers the real path in CI; everything else runs offline.

## Upstream

- Repository: <https://github.com/Noelo-Lab/kuna> (Apache-2.0).
- The pin tracks upstream automatically: every 12 hours the `sync-pin` job in
  `.github/workflows/decx-kuna.yml` compares it with upstream's latest release
  and pushes nothing when there is nothing newer. A new release moves the
  submodule gitlink, re-copies the skill (`awk 'NR==1 && $0=="---" {skip=1; next} skip && $0=="---" {skip=0; next} !skip' subprojects/decx-kuna/source/skills/kuna/SKILL.md > skills/decx-tool/references/kuna.md`)
  and pushes the commit with its `kuna-v<version>` tag. Manual moves follow
  the same recipe: `git -C subprojects/decx-kuna/source checkout <rev>`, commit
  the gitlink, re-copy the reference, tag `kuna-v<version>`, push.
- Repository release assets (`jygzyc/decx`, tag `kuna-v<version>`) are mirrors
  of upstream's own release, republished as zip by the release jobs in
  `.github/workflows/decx-kuna.yml`, with `kuna-SHA256SUMS.txt` added. The
  manifest installs from them directly (it resolves the newest `kuna-v*` tag);
  `decx install` never downloads from upstream.
- `source/` is upstream's code, and `skills/decx-tool/references/kuna.md` is upstream's
  own skill copied verbatim (frontmatter aside). DECX changes belong to this
  subproject — the manifest and this README — not to either file; a Kuna
  behaviour change is filed upstream, not patched into the copy.

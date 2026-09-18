# decx-kuna — native binary decompilation (upstream Kuna)

The subproject around [Kuna](https://github.com/Noelo-Lab/kuna), the native
decompiler for ELF/PE/Mach-O. DECX installs upstream's release archives and
never compiles kuna (`cargo` is not needed anywhere in this path), so
`source/` is vendored for reference only.

## In this repository

| Path | What it is |
| --- | --- |
| `decx-kuna.json` | the toolkit manifest `decx` reads: the release repository and pinned version, the per-platform asset names, the second `specs` asset, `KUNA_SPECS`, the three executables and the verify probe. |
| `skills/decx-kuna/SKILL.md` | the agent skill that drives the installed launcher. |
| `source/` | the vendored upstream checkout, pinned as a git submodule (`git submodule status subprojects/decx-kuna/source`). Installs never use it. |

## Install

```sh
decx install kuna        # upstream release for this platform + compiled SLEIGH specs
decx run kuna --help     # the tool's own interface, arguments untouched
```

Two assets are downloaded from the pinned release: the platform archive and
`kuna-v<version>-specs.tar.gz`. Upstream publishes no checksum file, so the
download is verified structurally — asset names, the three expected binaries and
a functional probe — instead of by SHA-256.

The payload lands in `$DECX_HOME/share/kuna/` (`bin/`, `specs/Ghidra/Processors/`,
`PROVENANCE`), and `$DECX_HOME/bin/{kuna,decomp_dbg,slacomp}` are launchers that
export `KUNA_SPECS=$DECX_HOME/share/kuna/specs` before running the packaged
binary; without it Kuna decodes nothing (`No sleigh specification for
AARCH64:LE:64:v8A`). `decx install` also links `kuna` into `~/.local/bin`
(a `.cmd` shim on Windows).

Platforms with an upstream asset: `linux-x64`, `linux-arm64`, `macos-arm64`,
`macos-x64`, `windows-x64`. The manifest pins `release.version` (1.515) because
upstream renames assets between releases — the archives gained their `v` in
v1.508 — so an unpinned install could silently take a different file set;
`decx install kuna --version <tag>` installs another tag.

## Verify

```sh
decx install kuna --home /tmp/decx-home --links /tmp/decx-links
test -f /tmp/decx-home/share/kuna/PROVENANCE
test -d /tmp/decx-home/share/kuna/specs/Ghidra/Processors
env -u KUNA_SPECS decx run --home /tmp/decx-home kuna functions /tmp/decx-home/share/kuna/bin/slacomp
```

Run that sequence after every pin move, on each platform: it checks the payload, the store
launchers (each must contain `KUNA_SPECS=`), the PATH link, and a real `kuna` invocation
whose environment has no `KUNA_SPECS`, which proves the launcher supplies it. It downloads
the pinned release, so it stays a manual acceptance check — `.github/workflows/test.yml`
runs offline and never fetches a release.

## Upstream

- Repository: <https://github.com/Noelo-Lab/kuna> (Apache-2.0).
- Move the pin with `git -C subprojects/decx-kuna/source checkout <rev>` and
  commit the subproject gitlink; the vendored revision is a reference, not an
  input to installs, so also check the release assets the manifest names.
- `source/` is upstream's code. DECX changes belong to this subproject — the
  manifest, the skill and this README — not to the checkout.

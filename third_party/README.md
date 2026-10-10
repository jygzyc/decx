# Tool projects

Each `decx-<id>/` contains a README and the manager's `decx-<id>.json` manifest.
The directory name does not imply that every tool is external:

- [AFE](decx-afe/README.md) is DECX's own Rust utility; its
  [Cargo.toml](decx-afe/Cargo.toml) declares Apache-2.0 licensing.
- [DroidASC](decx-droidasc/README.md) vendors a pinned
  [upstream ASC](https://github.com/MG1937/ASC) checkout in `decx-droidasc/source/`.
- [Kuna](decx-kuna/README.md) vendors a pinned
  [upstream Kuna](https://github.com/Noelo-Lab/kuna) checkout in `decx-kuna/source/`.

[`.gitmodules`](../.gitmodules) records upstream URLs; the superproject gitlinks
record the exact checkout pins. Upstream license and notice files remain in each
`source/` checkout and govern that code; see [DECX's LICENSE](../LICENSE) for the
surrounding project. Tool IDs and manifests are independent of checkout pins.

The manager installs AFE from prebuilt `tools-v*` release assets, DroidASC from
PyPI into a private venv, and Kuna from verified official upstream release assets
and compiled SLEIGH specs. It does not build these source trees or automatically
fall back to source builds. See the tool READMEs and [manager guide](../decx/README.md).

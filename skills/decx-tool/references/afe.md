# AFE

AFE (Android Framework Extract) collects and prepares Android framework files into a
packed jar. It never decompiles: the packed jar becomes an ordinary DroidASC input.
It reads device and framework images, expands APEX/ext4/EROFS payloads with native
readers, extracts DEX inputs, then writes `framework_<oem>_<vendor>.jar`.

## Commands

```text
afe collect                    pull framework files from the connected device
afe process                    expand collected inputs and pack the framework jar
afe pack                       repack a retained out_tmp into the framework jar
afe device system-services     list live Binder/system services as JSON
afe device permission-info "<permission>"    resolve one permission as JSON
```

- `afe process` already writes the packed framework jar. It removes `out_tmp`
  afterwards unless `--keep-outputs` is given, and only a retained `out_tmp` can be
  re-packed with `afe pack`.
- Device-facing commands (`afe collect`, `afe device ...`) need a connected device via
  ADB. When multiple devices are connected, provide `--serial`; choose the target
  explicitly rather than relying on ADB's implicit device selection.
- Collection and processing paths can be overridden with `--source DIR` and
  `--out DIR`. Defaults are `<AFE root>/source` and `<AFE root>/out`; the root is
  `$AFE_HOME`, then `$DECX_HOME/afe`, then `~/.decx/afe` (on Windows,
  `%USERPROFILE%\.decx\afe`). `AFE_ADB` overrides `DECX_ADB` for the adb executable.
- Each invocation writes one JSON object to stdout; diagnostics go to stderr.
  `collect`, `process` and `pack` return nested `artifact`/`layout` data and their
  operation result. `device system-services` returns `{total, services}` and
  `device permission-info` returns the permission metadata object. Read the actual
  response for paths and fields; do not infer filenames from the device model.
- Collection tries ready-made framework roots first and pulls only uncovered APEX
  modules. A supported-image parse failure is reported; unsupported ext4/EROFS
  features fail with an actionable error instead of invoking host extraction tools.
- Exact flags, positionals, output layout and JSON field names are AFE's own: run
  `afe --help` and `afe <command> --help` and consume the fields the command prints.
- Treat the packed framework jar as the analysis input: `droidasc getclass` /
  `droidasc findrefs` on that jar, with `kuna` for the native libraries it carries.

Framework artifact flow:

```bash
afe collect && afe process                  # process writes the packed jar
afe process --keep-outputs && afe pack      # only to re-pack a retained out_tmp
droidasc getclass "framework_<oem>_<vendor>.jar" "<class>"
```

## Install

```bash
decx install afe                  # prebuilt tools-v* asset when it carries this platform
decx install afe --from-source    # force a local cargo build
decx -m afe process
```

- `install` prefers the release: it looks for the `tools-v*` asset of the host platform (tag
  prefix `tools-v`; the release carries `afe-SHA256SUMS.txt`, so the download is
  checksum-verified). When no asset carries the platform, or with `--from-source`, the
  manager runs `cargo build --release` in the local AFE crate and installs its
  release binary; only that path needs Rust on PATH.
- One launcher (`afe`); the payload lives in `<DECX_HOME>/share/afe/`.
- `--from-source` forces the local crate build and requires Rust/cargo; without it,
  cargo is needed only when the release has no asset for the host platform.

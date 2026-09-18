---
name: decx-afe
description: Use when collecting or preprocessing Android framework files with AFE (Android Framework Extract) — pulling framework files from a device over ADB, expanding and packing them into the framework jar, re-packing a retained out_tmp, or reading live device services and permission info. Covers the exact `collect`/`process`/`pack`/`device` commands and what each produces.
metadata:
  requires:
    bins: ["afe"]
---

# AFE

AFE (Android Framework Extract) collects and prepares Android framework files into a
packed jar. It never decompiles: the packed jar becomes an ordinary DroidASC input.

## Routing Gate

Use for framework collection and preprocessing, and for live device reads
(`afe device ...`).

Do not use it for decompilation or cross-references — that is `decx-droidasc` on the packed
jar (and `decx-kuna` for native libraries inside the artifact). AFE itself never starts
an analyzer.

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
  ADB.
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
decx install afe --from-source    # cargo build of subprojects/decx-afe
decx run afe process
```

- `install` prefers the release: it looks for the `tools-v*` asset of the host platform (tag
  prefix `tools-v`; the release carries `afe-SHA256SUMS.txt`, so the download is
  checksum-verified). When no asset carries the platform, or with `--from-source`, the
  manager runs `cargo build --release` in `subprojects/decx-afe` and installs
  `target/release/afe`; only that path needs Rust on PATH.
- One launcher (`afe`); the payload lives in `<DECX_HOME>/share/afe/`.

Maintenance record (evidence, history, pattern pages): `wiki/` — read by the maintainer/proposer, never during execution.


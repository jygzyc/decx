# afe — Android Framework Extract

Standalone Rust CLI that pulls Android framework/dex inputs from an adb-connected
device, expands the APEX/ext4/EROFS payloads with native readers, and packs the
results into a `framework.jar`.

`decx install afe` prefers a prebuilt `tools-v*` asset for the platform and
otherwise builds this crate with cargo; the manifest is `decx-afe.json` beside it
and the agent skill is `skills/decx-afe/SKILL.md`. `release-afe.yml` publishes the
assets the manifest looks for (`afe-{version}-<platform>.tar.gz|zip` plus
`afe-SHA256SUMS.txt` under a `tools-v*` tag).

The command tree, JSON field names and error codes are a stable contract: `decx
run`, the skills and any script depend on them. Deliberate differences are listed
under Invariants.

## Build, test, run

```sh
cargo build --release        # target/release/afe
cargo test                   # 58 unit + 10 integration tests
```

The committed EROFS fixture `tests/fixtures/apex_payload_erofs.img` has SHA-256
`14609a7e7ab4a913600ba29d634accab1094229b7bc454a3ea881ca94dedbabc`.

Everything except `debugfs` / `extract.erofs` / `fsck.erofs` (used only as
fallbacks for unsupported image features) is implemented natively: EROFS and
ext4 readers, LZ4 block decompression, ZIP read/write, SHA-256.

## CLI

One JSON object per invocation on stdout; diagnostics on stderr; non-zero exit
on failure. On success stdout is the flat result object (the same fields the
TypeScript handlers returned). On failure stdout is the error payload
`{"code": ..., "message": ..., "details": ...}` and the exit code is 1 (or 2
for usage/parameter errors).

```sh
afe collect [--adb-path PATH] [--serial SERIAL] [--source DIR] [--out DIR] [--oem OEM] [--clean-source]
afe process [OEM] [--adb-path PATH] [--serial SERIAL] [--source DIR] [--out DIR] [--oem OEM] [--clean-source] [--keep-outputs]
afe pack [--source DIR] [--out DIR] [--oem OEM]
afe device system-services [--adb-path PATH] [--serial SERIAL] [--grep FILTER]
afe device permission-info PERMISSION [--adb-path PATH] [--serial SERIAL]
```

Flag aliases mirror the TypeScript ids: `--source`/`--source-dir`/`--input`,
`--out`/`-o`/`--out-dir`/`--output`, `--clean-source`/`--clean`,
`--keep-outputs`/`--keep-tmp`, `--permission`/positional `PERMISSION`.
`afe collect` accepts `--clean-source` and ignores it, exactly like the
TypeScript collect handler.

Output fields:

- `collect`: `{artifact: {session, oem, vendor, jarPath}, layout: {sourceDir, outDir, outTmpDir, artifact: {name, oem, vendor, rootDir, jarPath, updatedAt}}, collection: {scanned, pulled, skippedCoveredModules, failures: [{path, error}]}}`
- `process`: `{artifact, layout, process: {processed, outputs: [paths], failures: []}, pack: {jarPath, fileCount}}`
- `pack`: `{artifact, layout, pack: {jarPath, fileCount}}`
- `device system-services`: `{total, services: [{index, name, interfaces}]}` (`total` counts the rows kept after `--grep`)
- `device permission-info`: `{permission, package, label, description, protectionLevel, ...}` (`description` is `null` for `null`)

Metadata is written per output directory as `<outDir>/.artifact.json`; the
artifact layout follows the TypeScript rules (defaults
`<home>/output/framework/<oem>`, `source/`, `out_tmp/`,
`framework_<oem>_<vendor>.jar`, vendor/OEM auto-detected from the single
connected device when adb is usable).

`afe pack` only re-packs an existing `out_tmp`. Like the TypeScript flow,
`afe process` removes `out_tmp` once the jar is packed; pass `--keep-outputs`
(AFE extension) to retain it, otherwise `pack` fails with an actionable
message.

## Environment

| Variable | Purpose |
| --- | --- |
| `AFE_HOME`, `DECX_HOME` | Artifact home (default `$HOME`, or `%USERPROFILE%` on Windows). |
| `AFE_ADB`, `DECX_ADB` | adb binary (default `adb`). |
| `AFE_DEBUGFS`, `DECX_DEBUGFS` | debugfs binary for ext4 fallback. |
| `AFE_EXTRACT_EROFS`, `DECX_EXTRACT_EROFS` | extract.erofs binary. |
| `AFE_FSCK_EROFS`, `DECX_FSCK_EROFS` | fsck.erofs binary (preferred over extract.erofs). |

`AFE_*` wins over the legacy `DECX_*` name; `DECX_*` remains as a fallback.
Without an override the tools are looked up on `PATH`
(`fsck.erofs` before `extract.erofs`, `debugfs` by exact name, executable bit
required on Unix, native names plus `.exe` on Windows; `.cmd`/`.bat` shims are
not spawned because the tools are executed directly).

## Invariants

- Tiered collection (ready-made roots first, then only uncovered `/system/apex`
  module images → `skippedCoveredModules`), `total` = the service rows kept,
  permission parsing that stops at the next block, `adb -s` preferring the
  requested serial.
- APEX `original_apex` unwrapping, `@version` stripping, `<module>_`-prefixed dex
  outputs, 8 GiB expanded-entry cap, 30 min tool timeout / 5 min adb timeout,
  atomic `out_tmp` swap with `.previous`, `Manifest-Version`/`Created-By: decx`
  CRLF manifest, `--clean-source` semantics, and the exact missing-tool messages.
- `afe pack` is a subcommand (packing is not part of `process`); `--keep-outputs`
  retains `out_tmp` for it, otherwise `process` removes it and a later `pack`
  fails with an actionable message.
- Duplicate output names fail the run (`duplicate output <name> from <path>`)
  instead of overwriting, reported as `n framework inputs failed; previous output
  retained`.
- `AFE_*` environment names win over the legacy `DECX_*` ones; `AFE_HOME` sets the
  artifact home.
- Diagnostics are plain stderr lines and the JSON output is flat data or
  `{code, message, details}` — not a host response envelope.

# DECX v4.3.0

> [!IMPORTANT]
> **This is the last major release on the JADX-based line.**
>
> DECX is built on top of JADX, and that foundation has become the bottleneck:
>
> - JADX's decompilation pipeline holds large in-memory caches — v4.2.0 already had to bolt a bounded LRU on top of it.
> - Its memory footprint makes long analysis sessions expensive.
> - Its JVM-first design is a poor fit for AI-agent workflows that need fast, incremental, scriptable access to code.
>
> Rather than continue patching around it, **no further major version updates will be shipped on this line** — only critical fixes and small maintenance releases.
> **The next major version of DECX is already in development**, rebuilt on a new analysis stack designed for AI agents from the ground up.

v4.3.0 focuses on the CLI: automatic framework vendor detection, APEX payloads (ext4 **and** EROFS) now parsed natively in pure TypeScript, and an installer that no longer ships any native binaries.

## Features

### Framework vendor auto-detection

`decx framework process/open/run` now resolve the artifact vendor (device model) the same way OEM is resolved:

- A persisted `.artifact.json` wins; otherwise a single connected adb device is auto-selected and its `ro.product.model` is read.
- Several devices without `--serial` fail fast with `ADB_DEVICE_AMBIGUOUS`.
- No device at all keeps the offline `unknown` default, so processing stays usable without a phone attached.
- The detected vendor is persisted to the artifact, so later pack/open commands reuse it without re-querying.

### Verified jar version on install/update

- The skip-if-current check no longer trusts the config record — it parses `version.properties` straight from the installed jar's zip central directory (no new dependency).
- A missing, stale or manually replaced record no longer triggers a needless re-download of the ~50MB server jar.
- `self update` now reports the jar's actual version.

## Changes

### Native EROFS payload reader

- EROFS `apex_payload.img` images are now parsed natively in pure TypeScript (`decx-cli/src/android/erofs-reader.ts`) — same approach as the ext4 reader: no external tool, no WSL, works on every platform.
- Covers the layouts real devices produce: compact indexes, LZ4 and DEFLATE clusters (including compressed fragment tails and `ztailpacking` inline tails), PLAIN incompressible files, symlinks, and multi-lcluster extents.
- Byte-exact against `fsck.erofs --extract` on a matrix of fixtures (LZ4, DEFLATE, ztailpacking, fragments, PLAIN, empty files, symlinks).
- LZMA/ZSTD and other exotic features fall back to a system-installed `extract.erofs` (PATH or WSL on Windows).

### Dropped all packaged native binaries

- APEX payload extraction now runs entirely through the native pure-TypeScript ext4 and EROFS readers (superblock → extents → dirents; compact indexes, fragments, ztailpacking).
- Validated on a live Android 16 device: all 33 collected system APEX payloads extracted with zero external tool invocations.
- The remaining `extract.erofs` binaries (~3.9MB across four platforms) and the `debugfs` fallback are gone; exotic features resolve tools from PATH/WSL with a clear install-hint error otherwise.
- No more `bin.tar.gz` packaging, extraction to `DECX_HOME/bin`, or `.native-tools.sha256` marker bookkeeping — installer shrinks by ~1.7MB (tarball).

### Faster framework collection

- `/apex`-first tiered collection skips already-covered modules.
- Image tools are resolved lazily, so adb-only flows no longer require them.

### Dependency bumps

Applied from pending Dependabot PRs: logback 1.6.3, ktor 3.5.2, `actions/setup-java` v6.

### Build

- Replaced deprecated Kotlin DSL `by registering` delegates.
- Updated the `com.github.ben-manes.versions` plugin id to its new `io.github.ben-manes.versions` home.

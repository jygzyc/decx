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

v4.3.0 focuses on the CLI: automatic framework vendor detection, a much smaller installer that no longer packages `debugfs`, and verified jar versions on install/update.

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

### Dropped packaged `debugfs`

- APEX payload extraction now runs entirely through the native pure-TypeScript ext4 reader (superblock → extents → dirents).
- Validated on a live Android 16 device: all 33 collected system APEX payloads extracted with zero external tool invocations.
- The system fallback (`e2fsprogs` on PATH, WSL `debugfs`) is still honored when genuinely needed, with a clear install-hint error otherwise.
- EROFS extractors stay packaged.
- Packaged tools shrink 6.0MB → 3.9MB (tarball 3.8MB → 1.7MB).

### Faster framework collection

- `/apex`-first tiered collection skips already-covered modules.
- Image tools are resolved lazily, so adb-only flows no longer require them.

### Dependency bumps

Applied from pending Dependabot PRs: logback 1.6.3, ktor 3.5.2, `actions/setup-java` v6.

### Build

- Replaced deprecated Kotlin DSL `by registering` delegates.
- Updated the `com.github.ben-manes.versions` plugin id to its new `io.github.ben-manes.versions` home.

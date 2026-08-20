# DECX v4.1.2

DECX v4.1.2 adds a non-blocking update check and preserves heavily obfuscated identifiers in decompiled source.

### Features

- The CLI now runs a non-blocking update check on startup: the latest version comes from the npm registry, results are cached in `DECX_HOME/update-check.json` for 24 hours, the network refresh happens in a detached `__update-check` child process, and update hints go to stderr without affecting the current command. Set `DECX_NO_UPDATE_CHECK=1` to disable (also skipped under `CI`).
- `decx process open <file>` now defaults `--rename-flags` to `case,valid` so heavily obfuscated Unicode identifiers such as `Ď锬볝觧` survive decompilation instead of being aliased to `m0` by jadx's default `printable` rename. Explicit `--rename-flags`/`-rf` values are respected with the `printable` token stripped (`all` is rewritten to `case,valid`; `none` passes through untouched).

### Changes

- `decx self install` / `self update` no longer re-downloads `decx-server.jar` when the locally installed version already matches the latest release.


# DECX v4.1.0

DECX v4.1.0 adds Jadx Kotlin script support, makes the Android framework pipeline usable on Windows via WSL, and streamlines the CLI and its release workflow.

### Features

- `decx process open <file> --script <file.jadx.kts> [--script <file2.jadx.kts> ...]` runs Jadx Kotlin scripts during decompilation. Scripts are passed to `decx-server` as positional inputs and evaluated by the bundled `jadx-script-kotlin` plugin (top-level code at load, `jadx.afterLoad { }` blocks after classes load). Session reuse is keyed on the target file plus the exact script set.
- `decx android framework` now works on Windows: `debugfs` and the erofs extractor are delegated to WSL (`wsl.exe`) with `/mnt/<drive>/...` path translation, falling back to the packaged `linux/x86_64/extract.erofs`. Without WSL, the command fails with an explicit "Windows requires WSL" error.
- Zip/jar operations no longer need `zip`/`unzip` on Windows: they use the built-in bsdtar (`C:\Windows\System32\tar.exe`).

### Changes

- Framework collection directories: only `oppo` and `xiaomi` keep OEM-specific directory lists; every other OEM uses the default collection set.
- Build: `decx-core`'s `generateVersionProperties` now declares the version as a task input, so version bumps always refresh the embedded `version.properties` (previously stale after a version change).
- CLI internals: removed dead code, consolidated duplicated option parsing, logging, and zip helpers, and moved server port selection into `core/ports.ts`.

### Release process

- GitHub Actions publishes only on `v*` tags: npm (`release-cli.yml`) and GitHub Releases (`release-decx.yml`) both verify the tag matches the `version` file before publishing. Main-branch pushes no longer publish or generate prereleases; tags with a prerelease suffix (e.g. `v4.2.0-rc.1`) publish as GitHub prereleases.

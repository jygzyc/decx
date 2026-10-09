# scriptc toolchain

`toolchain.json` pins scriptc 0.2.7 and SHA-256 digests for the official GitHub
Release SDK archives, separately from the manager dependencies. From `decx/`, run:

```sh
npm run check:native
```

This installs the locked compiler, tests an independently compiled TS tool,
compiles the complete manager, then tests native tool lifecycles offline.
Setup verifies the pinned archive before extraction, checks the SDK metadata
and executable version, then atomically replaces `.scriptc-toolchain/`. An
integrity failure stops installation, preserving the existing SDK. `SOURCE.json`
records the version, official URL and verified digest. No npm lifecycle code runs.
The compiler path is `.scriptc-toolchain/bin/scriptc.exe` on every host.
Node is needed for build scripts, not the resulting executables.

For a local HTTP proxy, supply `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` to the
setup command's environment; setup does not change global proxy/npm settings.
The SDK download intentionally uses the official Release, not incomplete npm
platform-package publication. Updating the version requires updating all pinned
host digests and rebuilding; 0.2.7 requires runtime ABI v8.

Windows executable builds need Zig on PATH. CI uses Zig 0.16.0, matching the
upstream runtime-pack build; older Zig CRT libraries can fail to resolve
`stat64i32`. The same Zig compiler builds the in-binary Win32 process bridge.
The manager and independently compiled tools embed a UTF-8 code-page manifest
for Unicode environment variables and paths (Windows 10 1903+/Server 2022+).
There is no external Node launcher or JavaScript sidecar.

## Native source adaptations

The shared source uses builtin namespace imports accepted by both Node and
scriptc. The build copies that source unchanged, selects the HTTP/process
adapters under `src/native/`, generates `build-info.ts` with version/manifests,
and calls the shared `runEntry()` from a generated native entry point. It
invokes scriptc with `--dynamic`; it does not regex-rewrite application code.
Native fetch shares the manager's redirect, authentication and download-integrity
policy. Windows links a `CreateProcessW` FFI bridge to preserve cmd's already-escaped
command lines. Unsupported operations fail rather than generating an external-Node
fallback.

## Validation

Native tests execute outside the checkout, with Node absent from PATH:
verified tar.gz/zip releases, redirected authentication, environment launchers,
Unicode/empty/metacharacter arguments, update, checksum rejection and rollback,
removal, and a real private Python venv installing a local wheel. All prefixes,
links and caches are temporary; pip has no network access.

Local macOS arm64 tests pass. Branch and release CI gate Linux x64/arm64,
macOS arm64 and Windows x64. Help/version alone is not sufficient to publish.
The opt-in dynamic engine is part of scriptc's executable, not Node; a successful
compile is still not proof that untested runtime operations work.

# scriptc toolchain

`package.json` and `package-lock.json` pin scriptc 0.2.6 and its platform
packages separately from the manager dependencies. From `decx/`, run:

```sh
npm run check:native
```

This installs the locked compiler, tests an independently compiled TS tool,
compiles the complete manager, then tests native tool lifecycles offline.
Setup runs `npm ci` under `.scriptc-toolchain/` with lifecycle scripts disabled,
then explicitly invokes the pinned package's `installNativeCli` export.
The compiler path is `.scriptc-toolchain/node_modules/scriptc/bin/scriptc.exe`
on every host. Node is needed for build scripts, not the resulting executables.

Windows executable builds need Zig on PATH. CI uses Zig 0.16.0, matching the
upstream runtime-pack build; older Zig CRT libraries can fail to resolve
`stat64i32`. The same Zig compiler builds the in-binary Win32 process bridge.
There is no external Node launcher or JavaScript sidecar.

## Native source adaptations

The build stages typed TS modules, supplies version/manifests as constants,
and invokes scriptc with `--dynamic`. It normalizes CRLF before adapting builtin
namespace imports and the entry-point guard. Native fetch shares the manager's
redirect, authentication and download-integrity policy. Windows links a
`CreateProcessW` FFI bridge to preserve cmd's already-escaped command lines.
Unsupported operations fail rather than generating an external-Node fallback.

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

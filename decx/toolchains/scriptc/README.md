# scriptc toolchain

`package.json` and `package-lock.json` pin scriptc 0.2.2 and its platform
packages separately from the manager dependencies. From `decx/`, run:

```sh
npm run setup:scriptc
node --test tests/scriptc-tool.test.ts
npm run build:scriptc
```

Setup runs `npm ci` under `.scriptc-toolchain/` with dependency lifecycle
scripts disabled, then explicitly invokes the pinned package's
`installNativeCli` export. The compiler executable is
`.scriptc-toolchain/node_modules/scriptc/bin/scriptc.exe` on every host;
POSIX executes it as a native file, despite the suffix. Node is required for
build scripts, not for independently compiled tools.

## Verified locally

On macOS arm64, the installed native compiler prints `0.2.2`. The independent
TS fixture compiles, runs with Node absent from PATH, installs from a local
checksum-verified archive, and forwards Unicode arguments through DECX.
This does not establish that the full manager or other hosts work.

## Manager compilation remains blocked

The native build stages typed TS modules (no esbuild type erasure), supplies
version/manifests as real constants, and invokes the native compiler with
`--dynamic`. Builtin default imports are converted to namespace imports only
in staging. The source entry-point guard is also adapted because scriptc's
`import.meta.url` denotes the compile-time source path.

The latest local `npm run build:scriptc` failed with `46 errors.` after
unblocking the installer signature. The count includes dependent errors and
is not a count of independent missing features. Examples from that output:

```text
SC2020: 'spawnSync option 'env'' is part of the standard library types but has no scriptc lowering yet
SC2020: 'fs.readlinkSync' is typed by @types/node but has no scriptc lowering yet
SC2020: 'fs.symlinkSync' is typed by @types/node but has no scriptc lowering yet
SC2020: 'fs.cpSync' is typed by @types/node but has no scriptc lowering yet
SC2020: 'fs.lstatSync with 2 arguments' is part of the standard library types but has no scriptc lowering yet
SC2020: 'fs.createWriteStream' is typed by @types/node but has no scriptc lowering yet
SC2020: 'pipeline over a 'Readable'' is part of the standard library types but has no scriptc lowering yet
```

Remaining source-shape errors also include conditional/index-signature spreads
and an optional asynchronous initialization callback. Dynamic compilation is
not proof that every runtime operation works; unsupported island calls can
still fail at execution time.

Do not delete child-process environments, link ownership checks, archive
safety checks or streaming download verification to suppress these errors.
Do not publish a binary based only on help/version. Full offline installation,
tool launch, removal and failure/rollback tests must pass without an external
Node before native manager releases are enabled. Existing release CI must be
requalified; it is not proof of native manager support with this compiler.

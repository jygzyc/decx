# AGENTS.md

Coding agent instructions for the DECX engine implementations (`modules/`).

Repository-wide context (the `decx` CLI, skills, agents, release layout) lives in
the root `AGENTS.md`; this file only covers the three server modules.

## Layout

| Directory | Stack | Role |
|---|---|---|
| `modules/decx-jadx/` | Kotlin, JVM 17, Gradle | Default `jadx` server module: shared API/transport (`core/`), JADX GUI plugin (`plugin/`), standalone headless server (`server/`, `JadxServerApp`) |
| `modules/decx-asc/` | Python 3.11/3.12 + `asc/` git submodule | Optional `asc` server module: stdlib HTTP adapter over ASC (on-demand DEX analysis, no JVM) |
| `modules/decx-kuna/` | Rust + `kuna/` git submodule | Optional `kuna` server module: native ELF/PE/Mach-O decompiler server (no DEX/APK) |

Every server module is a self-contained component:

- its own `VERSION` file (independent release line) and `decx.json` manifest
  (`kind: server`, release/launch/binary metadata) read by the CLI
- released on its own tag (`jadx-server-v*`, `asc-server-v*`, `kuna-server-v*`)
  by `.github/workflows/release-<component>.yml`
- installed by `decx install --module <id>` into `$DECX_HOME/modules/<id>`

## Build And Test

```bash
cd modules/decx-jadx
./gradlew dist              # build/dist/jadx-server-<version>.jar + jadx_decx_plugin-<version>.jar
./gradlew :plugin:shadowJar # GUI plugin fat JAR
./gradlew :server:shadowJar # standalone server fat JAR
./gradlew test

cd ../decx-asc
python3 -m unittest discover -s tests -v   # adapter unit tests (stdlib only)
./build.sh                                 # dist/asc-server-<version>.zip

cd ../decx-kuna
cargo test --manifest-path server/Cargo.toml
./build.sh                                 # dist/kuna-server-<version>-<os>-<arch>.zip
```

## Rules

- Never edit inside the `asc/` or `kuna/` submodules (pinned gitlinks). Bump them
  with an explicit checkout plus a gitlink commit, and keep their license/NOTICE
  files in the release archive.
- Kuna SLEIGH specs are compiled by `slacomp` into a copy under `.build/specs`
  (`SKIP_SPECS=1` reuses it) — never into the submodule.
- Shared server behavior (routing, transport, API contract) belongs in
  `modules/decx-jadx/core`; the plugin and standalone server modules only wire it up.
- Version-specific behavior: the root `version` file drives the CLI, each
  `modules/*/VERSION` drives its own component release. Keep them in sync per release.
- New server capabilities start in `core/.../api/DecxApi` + `DecxApiImpl`, are
  registered in `DecxRoutes`, and are exposed through the module's `commands`
  list in its `decx.json` manifest — reached as `decx -m <id> <command>` — and
  through `McpToolRegistry` when appropriate.

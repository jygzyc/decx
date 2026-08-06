# DECX v4.0.2

DECX v4.0.2 is a patch release on top of v4.0.1: it fixes APK/DEX code loading in the shadowed JARs and documents the Windows `self update` recovery path for pre-v4.0.1 CLIs.

### Fix

- Build: fat JARs no longer drop JADX input plugins. Root cause: Shadow 9.6.1 applies `DuplicatesStrategy.EXCLUDE` before transformers by default, so duplicate Service Provider files were excluded before `mergeServiceFiles()` ran and `DexInputPlugin` was never written into the merged `META-INF/services/jadx.api.plugins.JadxPlugin` descriptor. As a result, `decx-server` loaded an APK's resources and generated R classes (the 16 classes seen in logs) but never read `classes.dex`. The `decx-server` / `decx-plugin` shadow JARs now set `DuplicatesStrategy.INCLUDE` for `META-INF/services/**` and `META-INF/*.kotlin_module` before merging, and the `decx-server` build verifies at build time that the merged descriptor contains `DexInputPlugin`.
- Docs: README / README_zh / decx-cli README now document the Windows `spawnSync npm.cmd EINVAL` failure of `decx self update` on CLI versions older than v4.0.1 and the manual one-time recovery (`npm.cmd install -g @jygzyc/decx-cli@latest`).

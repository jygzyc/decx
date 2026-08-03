---
name: archive-extraction
track: app
---

# archive-extraction

## Match
App extracts downloaded archive (zip/apk/jar/tar), processes zip entries, or dynamically loads code (`DexClassLoader`/`PathClassLoader`/`DexFile.loadDex`) from attacker-influenced paths.

## Non-obvious
- **Zip entry name `../` is not filtered by `ZipInputStream.getNextEntry()`** — `new File(destDir, entry.getName())` with `../app_shared_prefs/secrets.xml` writes outside `destDir`
- `ZipEntry.getName()` does NOT canonicalize — developer must check `file.getCanonicalPath().startsWith(destDir.getCanonicalPath())`
- Zip slip + FileProvider grant = arbitrary file overwrite → readback chain: overwrite `shared_prefs` → app reads attacker-controlled config → next launch loads attacker data
- **Dynamic loading from world-writable locations**: `DexClassLoader("/sdcard/plugin.apk", ...)` — if attacker can write to the path, code execution under app identity
- `PackageParser` / `PackageManager.getPackageArchiveInfo()` on attacker-supplied APK can trigger XML parsing of `AndroidManifest.xml` — XXE or billion-laughs in manifest
- OTA/self-update mechanism downloading APK to internal storage without integrity check → local code execution
- **Plugin化 frameworks** (VirtualApp, DroidPlugin, Shadow): host app loads plugin from external path — plugin runs with host's permissions and UID; plugin APK injection = host identity code execution

## Reject
Archive extracted to isolated temp dir with canonical path check on every entry, dynamically loaded code from `private` internal dir with signature verification, or no external input reaches extraction/loading path.

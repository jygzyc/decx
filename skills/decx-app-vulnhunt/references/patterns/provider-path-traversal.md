# Pattern: Provider Path Traversal

## Match

Provider, FileProvider, or file mapper builds filesystem paths from caller-controlled URI segments. Prioritize: custom `FileProvider` overriding `getFileForUri` without full canonicalization, broad `<root-path>` with empty/`./`/`/` value, `getLastPathSegment()` on attacker-controlled URI (auto URL-decodes `..%2F` to `../`), symlink swap windows, zip entry name reuse, and `openFile` paths reachable through a grant.

High-signal path-traversal shapes:
- `getLastPathSegment()` decodes percent-encoded separators before path concatenation; combined with `<root-path name="root" path="."/>` the attacker can construct `content://authority/root_file/.../.../data/data/victim/secret.db`.
- FileProvider configured with `<root-path>` whose `path` is empty/`.`/`/` — effectively shares every file the app process can read.
- Custom `FileProvider` that overrides `getFileForUri` but skips one of the canonicalization steps (decode, normalize, confine under root) — the official `androidx.core.content.FileProvider.getFileForUri` does three checks; removing any one is exploitable.
- `ACTION_SEND` / `ACTION_SEND_MULTIPLE` share target: handler does `query(uri)` to read `_display_name` from caller's provider, then uses the returned string as the destination file name. Attacker controls both source URI and displayed name; with `..%2F` they can write into any path under the app's writable space (covers the entire `external_files` / `cache` / `files` tree).
- Zip / document provider / `MediaStore` mapping reuses entry names without normalization — classic zip-slip into provider storage.

## Analyze

- entry: `openFile`, `openAssetFile`, `openFileDescriptor`, `query`, `call`, CRUD method, share-target `ACTION_SEND` handler, `copyFile(uri, filename)` helper
- control: decoded path segment, `getLastPathSegment` output, encoded separator (`%2F`, `%2E%2E%2F`), query filename, document id, file id, symlink created during the read window, zip entry, broad `root-path` with `name`/`path` values, full path constructed by `new File(parent, segment)`
- sink: `new File(uri.getPath())`, `ParcelFileDescriptor.open(file, MODE_READ_WRITE)`, `FileInputStream` / `FileOutputStream`, delete/rename/copy/unzip, DB `attach`, media decode, `File.getCanonicalPath` not called before write
- guard: `FileProvider.getFileForUri` exactly (decode + normalize + confine under immutable root), fixed id-to-file map, never use `_display_name` from caller provider as destination filename, validate `File.getCanonicalPath().startsWith(appPrivateRoot)` before any read/write/delete
- impact: private file read/write/delete, grant/result leak that chains into another pattern, write of attacker-controlled content into a path the app later loads as code (apk/dex/so → arbitrary code execution inside the app process)

## Reject

Reject when attacker input is converted to a trusted id before path use (e.g. `id → path` map), canonical confinement under the intended root is proven by code, path maps only to public/cache data, or the share-target path does not pass caller-controlled content into the destination filename.

## Codes

```java
// getLastPathSegment auto-decodes %2F, "..%2Fsecret.db" -> "../secret.db"
String fileName = uri.getLastPathSegment();
File f = new File(BASE_DIR, fileName);
return ParcelFileDescriptor.open(f, ParcelFileDescriptor.parseMode(mode));
```

```java
// custom FileProvider skips canonical confinement (decode + normalize + confine)
return new File(uri.getLastPathSegment());
```

```java
// share target uses caller's _display_name as destination path — attacker controls both
String fileName = queryDisplayName(uri);
File out = new File(getExternalFilesDir(null), fileName);
```

```java
// zip-slip — entry name reused without canonicalization
File out = new File(outDir, e.getName());
```

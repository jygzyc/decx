# Pattern: Provider Data Leak

## Match

Provider authority is exported, grant-reachable, or reached through another component (Activity/Service/Receiver/Bridge/PendingIntent/Intent redirect), and `query`, `openFile`, `openAssetFile`, `call`, `getType`, `applyBatch`, `bulkInsert`, or `insert` can return data, file handles, MIME, or oracle output to the caller.

High-signal data-leak surfaces:
- Provider exported with no `android:permission` or with a `normal` protection-level permission (any third-party app can query).
- Provider has `android:exported="false"` but `android:grantUriPermissions="true"` and another component grants `FLAG_GRANT_READ_URI_PERMISSION` / `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` / `FLAG_GRANT_PREFIX_URI_PERMISSION` to attacker-supplied target package.
- `applyBatch` / `bulkInsert` / `call` skips the per-operation authorization check applied by `query` / `insert` / `update` / `delete`.
- `getType(uri)` returns a different MIME based on a protected file's existence/content — oracle for protected state.
- Read-vs-write permission split: provider sets read permission but not write (or vice versa); attacker uses the unprotected direction to exfiltrate through the protected direction.
- FileProvider with broad `root-path` (→ `provider-path-traversal`).
- `setResult` in an exported activity forwards the caller-supplied Intent (incl. grant flags) back to the caller, giving the caller temporary `content://` access; combined with a non-exported but grantable Provider, the caller's URI access lives beyond the activity lifetime via `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` / `takePersistableUriPermission`.

## Analyze

- trace from the reachable authority or grant source into the concrete provider method. Compare the guard used by `query`/`insert`/`update`/`delete` with the guard used by `call`, `applyBatch`, `bulkInsert`, `getType`, and file-open paths; many leaks are guard skew, not missing guards everywhere.
- entry: provider method, `setResult` callback, `grantUriPermission` parameter set, Intent redirect path, share-target `ACTION_SEND` / `ACTION_SEND_MULTIPLE`, FileProvider root path
- control: URI `authority` / `path` / `query` / fragment, projection, selection, sort order, `call` method name, `applyBatch` operations, extras, file id, FileProvider's `root-path` / `files-path` / `cache-path` / `external-path` / `external-files-path` / `external-cache-path`, grant flag, request code, target package
- sink: `Cursor` rows, `Bundle`, MIME/oracle result, `ParcelFileDescriptor`, `InputStream` / `OutputStream` from `openInputStream` / `openOutputStream`, result `Intent` carrying `content://`, `grantUriPermission` to attacker package, persisted URI grant
- guard: per-method caller check (`Binder.getCallingUid()` / `getCallingPackage()`), per-row / per-path scope, projection/path allowlist, canonical file confinement via `FileProvider.getFileForUri`, do not forward caller-controlled Intent through `setResult` / `grantUriPermission` / `startActivity` / `startService`
- impact: privileged provider action, oracle that selects a later file/grant path, cross-app data exfiltration under caller identity

## Reject

Reject when URI/data is overwritten with trusted constants, the method is write-only with no readback, a non-bypassable permission/row/path guard covers the exact sink, or the grant chain does not cross the trust boundary (e.g. same UID).

## Codes

```java
// openFile builds a path from caller-controlled URI without canonicalization
File f = new File(uri.getPath());
return ParcelFileDescriptor.open(f, ParcelFileDescriptor.parseMode(mode));
```

```java
// grant flag travels back through setResult
setResult(RESULT_OK, intent);
```

```java
// boundary mistake: query() checks caller, getType() leaks existence as an oracle
return secretFile.exists() ? "vnd.android.cursor.item/secret" : "application/octet-stream";
```

```java
// extreme edge: non-exported provider becomes reachable through persisted result grant
setResult(RESULT_OK, grantIntentWith(secretContentUri, FLAG_GRANT_PERSISTABLE_URI_PERMISSION));
```

```java
// call() bypasses the per-row check that query/insert/update/delete apply
if ("secret".equals(method)) return dbHelper.fetchSecret();
```

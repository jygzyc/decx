# Pattern: URI Grant Leak

## Match

Caller-controlled flow carries `content://` URI, `ClipData`, or `FLAG_GRANT_*` into a result, redirect, share, notification, pending intent, or explicit grant path. High-signal grant-bearing flows:

1. **`setResult` returning caller-supplied Intent** — see `setresult-leak`. The attacker can pre-load `FLAG_GRANT_READ_URI_PERMISSION` / `FLAG_GRANT_WRITE_URI_PERMISSION` / `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` / `FLAG_GRANT_PREFIX_URI_PERMISSION` plus a `content://` URI; `setResult(intent)` returns the caller's own intent verbatim, giving the caller URI grant on the victim's provider.
2. **Intent redirect** — see `intent-redirect`. The nested Intent in `getParcelableExtra("target")` carries the grant flags, and the redirecting Activity launches the nested intent under victim-app identity, transitively granting the attacker the URI grant.
3. **`grantUriPermission` parameters controlled by caller** — explicit grant call where `toPackage`, `uri`, or flags come from a caller-supplied source. Combined with `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` the grant survives the activity lifetime.
4. **FileProvider misconfig + grant** — broad `<root-path name="root" path="."/>` lets any granted URI map to any path; with one of the grant primitives above, the attacker can read/write any file the app can read.

## Analyze

- entry: external Intent/result, share/chooser, FileProvider, provider result, WebView/native scheme, pending intent, `grantUriPermission`, `ACTION_SEND` / `ACTION_SEND_MULTIPLE` share target, `onActivityResult` path
- control: URI authority/path, recipient package, flags, `ClipData`, result target, provider file mapping
- sink: temporary/persistable URI grant (`takePersistableUriPermission`), returned grant-bearing `Intent`, private file/provider access by attacker recipient, downstream component launch
- guard: grant flag stripping (`Intent.removeFlags(FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION)`), provider permission/path confinement, do not forward caller-controlled Intent through any grant-bearing sink, never use `<root-path>` with `path` empty/`.`/`/`
- impact: attacker reads/writes private file/provider data or carries grant into another chain

## Reject

Reject when URI is public, recipient is trusted constant, grants are stripped, provider denies original attacker, or path is confined to non-sensitive data.

## Codes

```java
// caller's exact Intent (with FLAG_GRANT_*) returns through setResult
setResult(RESULT_OK, intent);
```

```java
// grantUriPermission with caller-controlled target package, URI, flags
grantUriPermission(data.getStringExtra("toPackage"), data.getData(), data.getIntExtra("flags", 0));
```

```java
// nested Intent carries grant flag in redirect (chains into intent-redirect)
next.setData(Uri.parse("content://com.victim.localfile/secret.db"));
next.setFlags(FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION
            | FLAG_GRANT_PERSISTABLE_URI_PERMISSION | FLAG_GRANT_PREFIX_URI_PERMISSION);
```

```xml
<!-- broad root + grant enables arbitrary file access — see provider-path-traversal
     <paths><root-path name="root" path="." /></paths> -->
```

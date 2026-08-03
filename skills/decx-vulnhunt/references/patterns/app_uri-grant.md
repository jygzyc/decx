---
name: uri-grant
track: app
---

# uri-grant

## Match
Caller-controlled flow carries `content://` URI, ClipData, or `FLAG_GRANT_*` into result/redirect/share/notification/pending intent/explicit grant path.

## Non-obvious
- `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` + `takePersistableUriPermission` = grant survives activity lifetime (persistent)
- `FLAG_GRANT_PREFIX_URI_PERMISSION` (often forgotten) extends grant to all paths under prefix
- FileProvider with broad `<root-path>` + ANY grant primitive = arbitrary file access — grant and path compose
- `setResult` returning caller-supplied Intent = URI grant to attacker
- Nested Intent in redirect carries grant flags transitively — redirecting Activity launches under victim identity, transitively granting
- `grantUriPermission` with caller-controlled `toPackage`/`uri`/`flags` is its own primitive

## Reject
URI is public, recipient is trusted constant, grant flags stripped, or path confined to non-sensitive data.

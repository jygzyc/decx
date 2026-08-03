---
name: implicit-intent-hijack
track: app
---

# implicit-intent-hijack

## Match
Sensitive data, URI grant, callback, or result sent through implicit Intent resolution (no explicit component).

## Non-obvious
- Android 5+ blocks implicit `bindService` BUT NOT implicit `startService` on exported services
- `setPackage(pkg)` is NOT sufficient — resolver can still pick any matching activity inside that package
- `startActivityForResult` with implicit Intent lets attacker return forged grant-bearing Intent via `setResult`
- `FLAG_GRANT_*` survives implicit dispatch — attacker gets `content://` URI grant without having permission

## Reject
Target is explicit (`setClassName`/`setComponent`), payload is public, or recipient verified by `ActivityInfo`.

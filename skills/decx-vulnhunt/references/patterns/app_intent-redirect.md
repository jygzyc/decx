---
name: intent-redirect
track: app
---

# intent-redirect

## Match
Exported entry, WebView/IntentScheme router, PendingIntent send, or notification path forwards caller-controlled Intent/Uri/ClipData/selector/component/package/flags to downstream sink.

## Non-obvious
- **Component field has higher precedence than `getPackage()`** — package equality check alone is insufficient
- `getCallingActivity()` / `getCallingPackage()` can return null — null check required or identity bypassed
- Untyped `getParcelableExtra` still calls target's `CREATOR.createFromParcel`: See [[app_object-parsing]]
- `Intent.parseUri` does NOT strip component/package/selector/`FLAG_GRANT_*`/ClipData on pre-API 30 — never pass raw output to `startActivity`
- Selector overrides component resolution after package check passes

## Reject
Forwarded Intent rebuilt from trusted constants, dangerous fields and grant flags stripped, downstream has no protected behavior.

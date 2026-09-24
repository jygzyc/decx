---
name: webview_entry
track: android-app
---

# webview_entry

## Match
Attacker-controlled URL or content reaches WebView `loadUrl`/`loadDataWithBaseURL`/`evaluateJavascript` without host/path/scheme allowlist. Entry paths include deep link, redirect, SSL bypass, scan/QR/NFC result, or share sheet.

Entry vectors (compose into single "attacker URL lands in WebView" signal):
- `shouldOverrideUrlLoading` checks host but not path/query where `intent://`/`javascript:`/`file://` payloads live
- `onReceivedSslError` calling `handler.proceed()` permits MITM content; default is cancel (safe), override is the danger
- `networkSecurityConfig` `debug-overrides` left in production trust user CAs — any MITM cert works
- Scan result / QR / NFC / share `_display_name` fed directly to `loadUrl`/`evaluateJavascript`/`Intent.parseUri`
- `loadDataWithBaseURL` with `file://` baseURL + attacker HTML

## Non-obvious
- Mixed content default was `MIXED_CONTENT_ALWAYS_ALLOW` on older API — `https://` page silently loads `http://` subresource
- `<application android:usesCleartextTraffic="true">` is app-wide permit (overrides per-domain config)
- `usesCleartextTraffic="true"` + WebView loading `http://` via `javascript:`/`intent://` redirect = silent MITM

## Reject
`shouldOverrideUrlLoading` blocks non-allowlisted host, `onReceivedSslError` not overridden (default cancel), `networkSecurityConfig` strict with system-only trust anchors, `setMixedContentMode(MIXED_CONTENT_NEVER_ALLOW)`, and only `https://` loaded.

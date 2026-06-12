# Pattern: WebView URL Bypass

## Match

`WebView` or its client lets an attacker-controlled URL reach `loadUrl` / deep link / redirect chain through `shouldOverrideUrlLoading` or `shouldInterceptRequest` without a host/path/scheme allowlist. The WebView then loads `intent://`, `javascript:`, `file://`, `content://`, or cross-origin `http(s)://`. Variants:
- `shouldOverrideUrlLoading` not implemented or returns `false` (default) → WebView loads the URL.
- `shouldOverrideUrlLoading` returns `true` for a non-allowlisted host but does NOT call `view.loadUrl(url)`; some impls check host but not path/query where attacker-controlled `intent://`/`javascript:`/`file://` payloads live.
- Non-HTTP(S) URL arrives via `loadDataWithBaseURL` or `onPageFinished` → `view.loadUrl("intent:" + ...)`.
- WebView reuses attacker-controlled `Referer`/`User-Agent`/cookie for an internal API call.

## Analyze

- entry: `WebViewClient.shouldOverrideUrlLoading`, `WebViewClient.shouldInterceptRequest`, `WebChromeClient.onJsPrompt` / `onJsAlert` / `onConsoleMessage`, `loadUrl` from JS bridge, `loadDataWithBaseURL`, deep link with attacker-controlled query
- control: URL host/scheme/path/query, `intent://` payload, `javascript:` payload, MIME from `shouldInterceptRequest`, `Referer` and `User-Agent`, `onReceivedSslError` behavior
- sink: `loadUrl`, `loadDataWithBaseURL`, native bridge, WebView reachability to non-allowlisted host, `Settings.Secure.ADB_ENABLED` flipped, exfiltration to attacker domain, XSS via `WebResourceResponse` MIME
- guard: host allowlist in `shouldOverrideUrlLoading`, `onReceivedSslError` calls `handler.cancel()`, reject `intent://` payload, reject `javascript:` payload from any URL source, do not build a URL from server-controlled path
- impact: cross-domain request with app cookies/identity, chain into `intent-redirect` or `provider-data-leak`, XSS via `WebResourceResponse` MIME, exfiltrate cookies/local storage

## Reject

Reject when `shouldOverrideUrlLoading` blocks non-allowlisted host, `WebSettings` does not enable JS/file/universal access, and the URL is not constructed from server-controlled path.

## Codes

```java
// default policy loads the URL regardless of host
public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return false; }
```

```java
// missing SSL error handler — proceeds on cert mismatch
public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.proceed(); }
```

```java
// shouldInterceptRequest returns attacker-controlled content for trusted origin — XSS via MIME
return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(attackerHtml.getBytes()));
```

```java
// intent:// payload loaded through WebView (no host allowlist before parseUri)
if ("intent".equals(uri.getScheme())) startActivity(Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME));
```

```java
// loadDataWithBaseURL — baseURL on file:// + html with attacker content
webView.loadDataWithBaseURL("file:///sdcard/", html, "text/html", "utf-8", null);
```

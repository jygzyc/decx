# Casebook: WebView Bugs

Use this casebook after [[patterns/webview-url-bypass]], [[patterns/webview-js-bridge]], [[patterns/webview-file-access]], or [[patterns/webview-cookie-theft]]. Cases describe transferable exploit shapes.

## Public Case: Untrusted WebView Content Reaches Native Bridge

### Source Type

Public Android security guidance and academic WebView research describing insecure native bridge exposure.

### Abstract Shape

```text
external URL/content -> WebView.loadUrl/loadData -> addJavascriptInterface/postWebMessage -> native sensitive method
```

### Key Mistake

The bridge is exposed to a WebView that can render attacker-controlled content or subframes.

### Why It Was Exploitable

- attacker can influence the page, redirect target, iframe, scan result, or HTML string
- native bridge object is reachable from that script context
- bridge method reaches token, file, component launch, account, or database functionality
- origin, frame, and navigation validation are missing or bypassable

### Generalized Detection Rule

Treat WebView bridge use as a candidate only after proving attacker-controlled script can invoke a security-relevant native method.

### Related

[[patterns/webview-url-bypass]], [[patterns/webview-js-bridge]], [[patterns/object-parsing-abuse]]

## Case: Deep Link Loads Attacker Page With Bridge

### Abstract Shape

```text
external deep link -> URL parameter -> WebView.loadUrl -> addJavascriptInterface -> token/native action
```

### Key Mistake

The app enables a native bridge in the same WebView that loads attacker-controlled or weakly validated content.

### Why It Was Exploitable

- external entrypoint controls the loaded URL or redirect target
- attacker JavaScript runs in the bridged WebView
- bridge method exposes sensitive data or native action
- origin validation is missing, partial, or checked before redirects

### Generalized Detection Rule

Bridge exposure is reportable only when attacker-controlled script reaches a sensitive bridge method.

Related: [[patterns/webview-url-bypass]], [[patterns/webview-js-bridge]]

## Case: File URL Access Exfiltrates Local Data

### Abstract Shape

```text
external HTML/base URL -> file/content access enabled -> attacker JS -> local data read/exfiltration
```

### Key Mistake

The WebView combines attacker-controlled content with privileged local file/content access.

### Why It Was Exploitable

- attacker controls loaded HTML, URL, or script context
- file/content access is enabled for that context
- local resource contains sensitive data
- exfiltration or bridge pivot is possible

### Generalized Detection Rule

WebView file settings alone are not findings; prove attacker-controlled content can use them to reach sensitive local data.

Related: [[patterns/webview-file-access]]

## Case: SSL Proceed Enables MITM Bridge Access

### Abstract Shape

```text
MITM proxy -> SSL error -> handler.proceed() -> attacker JS -> addJavascriptInterface -> token/credential extraction
```

### Key Mistake

The WebViewClient overrides `onReceivedSslError` and calls `handler.proceed()` unconditionally, allowing a MITM attacker to inject JavaScript into a bridge-enabled WebView.

### Why It Was Exploitable

- SSL error handler ignores certificate validation failures and continues loading
- MITM proxy presents a self-signed or mismatched certificate
- injected JavaScript runs in the same origin as the legitimate page
- native bridge methods remain accessible to the attacker script
- extracted tokens or credentials are exfiltrated to an attacker-controlled endpoint

### Generalized Detection Rule

Any `onReceivedSslError` that calls `proceed()` without user confirmation or pin validation creates a MITM entry point into the WebView's script context.

Related: [[patterns/webview-js-bridge]]

## Case: Shared CookieManager Leaks Auth Tokens

### Abstract Shape

```text
attacker URL -> WebView with shared cookies -> CookieManager.getCookie() -> auth token sent to attacker domain
```

### Key Mistake

The app's WebView instance shares its cookie jar with the authenticated session, allowing an attacker-controlled page to read cookies belonging to other domains.

### Why It Was Exploitable

- `CookieManager` is a process-wide singleton shared across all WebViews
- the authenticated session stores tokens in cookies for a trusted domain
- attacker page loaded in any WebView calls `CookieManager.getInstance().getCookie(trustedDomain)`
- the retrieved auth token is sent to the attacker's server via XHR or image request
- no per-WebView cookie isolation or third-party cookie blocking is configured

### Generalized Detection Rule

When a WebView can load arbitrary URLs and the app stores session tokens in cookies, verify that cookie access is scoped or that the WebView uses an isolated cookie store.

Related: [[patterns/webview-cookie-theft]]

## Case: intent:// Scheme Launches Private Component

### Abstract Shape

```text
attacker page -> intent:// URL -> Intent.parseUri() -> startActivity() -> private exported=false Activity
```

### Key Mistake

The WebView handles `intent://` URLs in `shouldOverrideUrlLoading` by parsing and launching the resulting Intent without validating the target component.

### Why It Was Exploitable

- `Intent.parseUri()` reconstructs a full Intent including component, extras, and flags
- `shouldOverrideUrlLoading` calls `startActivity(parsedIntent)` under the app's identity
- the target component may be `exported=false` but is reachable because the launch originates from within the app
- attacker controls all Intent fields including extras that carry sensitive parameters
- no package allowlist or component allowlist filters the resolved target

### Generalized Detection Rule

Any `shouldOverrideUrlLoading` handler that calls `Intent.parseUri()` followed by `startActivity()` must restrict the resolved component to an allowlisted set.

Related: [[patterns/webview-url-bypass]]

## Case: Scan Result Injects Script Into Trusted Context

### Abstract Shape

```text
QR scanner -> onActivityResult -> unvalidated URL/HTML -> WebView.loadUrl -> bridge method call
```

### Key Mistake

The app reads QR code content as a URL or HTML string and passes it directly to a trusted WebView that has native bridge access.

### Why It Was Exploitable

- QR code payload is treated as a trusted URL without scheme or host validation
- `onActivityResult` forwards the raw string to `WebView.loadUrl()` or `loadDataWithBaseURL()`
- the WebView has `addJavascriptInterface` or equivalent bridge enabled
- attacker encodes a `javascript:` URI or attacker-domain URL in the QR code
- bridge methods execute with the app's permissions under the injected script's control

### Generalized Detection Rule

Any data path from external input (QR, NFC, clipboard) to `WebView.loadUrl()` or `loadData*()` must validate scheme and host before loading, especially when the WebView has a bridge.

Related: [[patterns/webview-url-bypass]], [[patterns/webview-js-bridge]]

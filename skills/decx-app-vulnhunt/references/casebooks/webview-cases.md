# Casebook: WebView Bugs

Use this casebook after `patterns/webview-url-bypass.md`, `patterns/webview-js-bridge.md`, `patterns/webview-file-access.md`, or `patterns/webview-cookie-theft.md`. Cases describe transferable exploit shapes.

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

See: `patterns/webview-url-bypass.md`, `patterns/webview-js-bridge.md`

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

See: `patterns/webview-file-access.md`

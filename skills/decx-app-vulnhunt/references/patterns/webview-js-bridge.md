# Pattern: WebView JavaScript Bridge Exposure

## When To Use

Use this reference when attacker-controlled WebView content can reach `addJavascriptInterface`, `WebMessagePort`, `postMessage`, custom schemes, or bridge methods that call native app functionality.

## Core Concept

Untrusted web content crosses from renderer-controlled script into native app methods without origin, URL, or method-level authorization.

**Sources**
- deep link, QR/scan result, redirect, remote config, push, or Intent-provided URL/HTML; `loadUrl`, `loadData`, `loadDataWithBaseURL`, `shouldOverrideUrlLoading`; web messages, injected JavaScript, custom scheme handlers.

**Sinks**
- `addJavascriptInterface` annotated methods; bridge methods reading files, tokens, cookies, account state, contacts, location, or starting components; `evaluateJavascript` with untrusted data that reaches bridge/native code.

## Guards & Rejection

Safe when: only trusted origins load with bridge enabled, navigation is pinned after redirects, bridge is removed for untrusted content, bridge methods enforce authorization, and mixed/file content cannot inject script.

Reject when: attacker cannot execute script in the bridged WebView, the bridge is disabled before untrusted loads, methods are harmless, or origin validation is exact and enforced before bridge exposure.

## Rating

- HIGH: credential/token/data theft or native privileged action.
- MEDIUM: bounded native action or local app-only bridge abuse.
- LOW: low-value info leak or weak UI manipulation.
- IGNORED: WebView setting exists but attacker-controlled content cannot reach the bridge.

## Trace Commands

```bash
decx code xref-method "android.webkit.WebView.addJavascriptInterface(java.lang.Object,java.lang.String):void" -P <port>
decx code method-source "<bridgeMethod>" -P <port>
```

## Example Shapes

Suspicious:

```text
deep link URL -> loadUrl(attacker page) -> addJavascriptInterface -> bridge.getToken()
```

Safe:

```text
trusted origin allowlist -> bridge enabled only after verified navigation -> method-level auth
```

Report guidance -- Use: "Attacker-controlled WebView content can invoke a JavaScript bridge method that exposes sensitive native app functionality." Avoid: "JavaScript bridge exists" without proving attacker-controlled content can call security-sensitive bridge methods.

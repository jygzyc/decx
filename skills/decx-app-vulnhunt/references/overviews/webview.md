# WebView - Component Analysis Guide

Use this guide for WebView navigation, JavaScript bridge, cookie sharing, file/content access, intent scheme dispatch, SSL error handling, and scan/browser result injection targets.

## Analysis Flow

```text
1. decx code search-global "WebView" --limit 50 -P <port>
   -> locate WebView hosts
2. decx code class-context "<WebViewHost>" -P <port>
   -> overview of all methods (bridge, handlers, callbacks)
3. decx code class-source "<WebViewHost>" -P <port>
   -> inspect:
      - addJavascriptInterface / postWebMessage / WebMessagePort
      - loadUrl / loadData / loadDataWithBaseURL / evaluateJavascript
      - shouldOverrideUrlLoading / shouldInterceptRequest
      - onShowFileChooser / file chooser result handling
      - CookieManager / WebSettings
4. Trace attacker-controlled sources:
   -> Intent extras, deep links, scan results, QR parser output
   -> externally supplied URLs or HTML
5. Confirm URL/domain allowlists, scheme checks, and bridge exposure rules are non-bypassable
```

## Promotion Signals

- attacker-controlled content reaches the WebView
- content can invoke native bridge, read local data, receive cookies, or launch native components
- scheme/host/path/caller/bridge allowlists are missing or bypassable
- impact is credential/session theft, native action, private file access, or trusted-context script execution
- WebView settings (JavaScript, file access, SSL) are primitives, not standalone findings -- promote only when they enable a concrete impact path

## False Positive Guide

- **Hardcoded internal URLs only**: verify no code path passes external data to loadUrl -- a deep link handler or scan result callback may feed the same WebView instance
- **Exact allowlist with redirect blocking**: confirm the allowlist comparison happens on the same normalized value that the WebView actually navigates to
- **Bridge methods are harmless helpers**: trace each method for file reads, token access, component launches, or database queries before concluding they are safe
- **SSL proceed with no impact surface**: check whether the same WebView instance is reused for authenticated pages later in the lifecycle

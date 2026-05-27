# WebView - Overview - Security Review

Use this overview for WebView navigation, bridge, cookie, file/content, scheme, SSL, scan, and browser handoff targets. For signal-to-pattern routing, start with `vulnerability-router.md`.

## Analysis Flow

```text
1. decx code search-global "WebView" --limit 50 -P <port>
   -> locate WebView hosts
2. decx code class-context "<WebViewHost>" -P <port>
   -> quick overview of all methods (bridge, handlers, callbacks)
3. decx code class-source "<WebViewHost>" -P <port>
   -> inspect:
      - addJavascriptInterface
      - postWebMessage / WebMessagePort / addWebMessageListener
      - loadUrl / loadData / loadDataWithBaseURL / evaluateJavascript
      - onActivityResult / ActivityResultLauncher callbacks
      - shouldOverrideUrlLoading / shouldInterceptRequest
      - onShowFileChooser / file chooser result handling
      - CookieManager / WebSettings
4. Trace attacker-controlled sources:
   -> Intent extras, deep links, scan results, QR parser output
   -> externally supplied URLs or HTML
   -> file chooser URIs
5. Confirm whether URL/domain allowlists, scheme checks, and bridge exposure rules are non-bypassable
```

## Promotion Signals

- attacker-controlled content reaches the WebView
- content can invoke native bridge, read local data, receive cookies, or launch native components
- scheme/host/path/caller/bridge allowlists are missing or bypassable
- impact is credential/session theft, native action, private file access, or trusted-context script execution
- URL control, SSL bypass, shared cookies, and WebView settings are usually primitives; route to the concrete bridge, cookie, file, native, or credential impact

## Common False Positives

- WebView loads only hardcoded internal URLs with no bridge, file access, or cookie exposure
- URL validation uses exact normalized host/path allowlist and no redirects are followed
- Bridge methods are public helpers with no security-sensitive side effects
- SSL error handler proceeds but the loaded content has no meaningful impact surface
- `setJavaScriptEnabled(true)` alone is not a finding without attacker-controlled content

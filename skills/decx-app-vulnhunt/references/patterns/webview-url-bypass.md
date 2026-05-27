# Pattern: WebView URL Validation Bypass

## When To Use

Use this reference when attacker-controlled URL, HTML, redirect target, scan result, browser result, or deep-link parameter reaches WebView navigation despite scheme, host, path, or origin validation.

## Vulnerability Essence

Weak URL validation lets untrusted content execute or navigate in a trusted WebView context, then pivot to bridge, cookie, file/content, native-scheme, credential, or session impact.

## Sources

- deep link, scan result, browser result, push, remote config, QR/parser output
- `Intent` extras/data, activity result callbacks, WebView navigation callbacks
- redirects, encoded host/path, mixed-case scheme, suffix/prefix host tricks, userinfo, punycode, path normalization

## Sinks

- `loadUrl`, `loadData`, `loadDataWithBaseURL`, `evaluateJavascript`
- `shouldOverrideUrlLoading`, `shouldInterceptRequest`
- bridge/message channel, cookie manager, file/content access, `intent://` or custom scheme dispatch

## Required Trace Evidence

- Reachability: external or attacker-influenced source reaches WebView navigation.
- Controllability: attacker controls the final consumed URL/HTML/script or redirect target.
- Sink: loaded content reaches a concrete security surface such as bridge, cookie, file, native scheme, credential, or trusted session.
- Missing or bypassable guard: validation does not cover final scheme, host, port, path, navigation state, redirects, or normalized URL consumed by the sink.
- Visible impact: credential/session theft, native bridge action, local file access, protected component launch, or trusted-context abuse.

## Guard Checklist

Consider safe when exact HTTPS scheme, host, port, path, and redirect destination are validated on the final consumed URL; untrusted pages have no bridge/cookie/file/native privileges; and validation happens on the same normalized value passed to WebView APIs.

## Rejection Rules

Reject standalone URL bypass when no bridge, cookie, file/content, custom-scheme, credential, or trusted-session path is reachable. Reject when final navigation is exactly allowlisted and loaded content has no security value.

## Rating Mapping

- HIGH: token/session theft, sensitive bridge call, private file read, or protected native action.
- MEDIUM: bounded trusted-session action requiring user interaction or local app.
- LOW: weak phishing/UI-only flow.
- IGNORED: URL validation is weak but no security-relevant WebView context is reached.

## Trace Commands

```bash
decx code method-context "<webviewLoadOrCallback>" -P <port>
decx code method-source "<urlValidator>" -P <port>
```

## Example Shapes

Suspicious:

```text
deep link URL -> host suffix check -> redirect -> trusted WebView with bridge/cookies
```

Safe:

```text
deep link URL -> normalized exact allowlist -> final redirect validation -> no bridge for external pages
```

## Report Snippet

Use: "Attacker-controlled navigation bypasses WebView URL validation and reaches a trusted WebView context with sensitive impact."

Avoid: "URL validation is weak" without proving attacker content reaches bridge, cookies, files, or protected actions.

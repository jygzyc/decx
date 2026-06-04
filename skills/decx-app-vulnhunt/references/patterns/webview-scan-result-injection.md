# Pattern: WebView Scan Result Injection

## When To Use

Use this reference when QR/barcode/browser/activity result data reaches WebView navigation, HTML, JavaScript, or native scheme dispatch.

## Core Concept

Externally supplied scan or browser result data becomes trusted WebView content or navigation input without strict parsing and final-sink validation.

**Sources**
- scanner SDK callbacks; `onActivityResult`, Activity Result API callbacks, browser handoff extras; QR/barcode parser output, returned URL/HTML/script fragments.

**Sinks**
- `loadUrl`, `loadData`, `loadDataWithBaseURL`, `evaluateJavascript`; WebView bridge, cookies, file/content access, custom scheme/native dispatch.

## Guards & Rejection

Safe when: parser strips dangerous schemes, validates normalized final URL, rejects HTML/JS where URL is expected, and untrusted scan results cannot enter privileged WebView contexts.

Reject when: the scan result only opens harmless external public content, exact allowlisting protects the consumed value, or no downstream WebView/native impact is reachable.

## Rating

- HIGH: scan payload reaches bridge, cookies, file access, or protected native action.
- MEDIUM: bounded trusted-session action requiring user scanning.
- LOW: weak phishing/navigation only.
- IGNORED: source primitive with no concrete impact.

## Trace Commands

```bash
decx code method-context "<scanResultCallback>" -P <port>
decx code method-source "<parserOrWebviewSink>" -P <port>
```

## Example Shapes

Suspicious:

```text
QR/scan result passes unvalidated URL to WebView -> loads attacker content in trusted context -> pivots to bridge, cookie, file, or scheme impact
```

Safe:

```text
scan result URL validated against exact allowlist before WebView load -> untrusted content isolated from bridge/cookies/files
```

Report guidance -- Use: "Attacker-controlled scan result data is consumed as trusted WebView input and reaches a sensitive downstream sink." Avoid: "scan result reaches WebView" without proving the URL loads attacker content in a trusted context with impact.

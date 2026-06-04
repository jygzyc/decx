# Pattern: WebView SSL Error Bypass

## When To Use

Use this reference when `onReceivedSslError()` or equivalent certificate-error handling proceeds for attacker-influenced content.

## Core Concept

The app accepts attacker-controlled TLS failures in a WebView, allowing network attackers to inject content into a trusted WebView context.

**Sources**
- WebView SSL error callbacks; custom trust managers used by WebView/network bridge; attacker-controlled network content that can trigger certificate errors.

**Sinks**
- `SslErrorHandler.proceed()`; injected HTML/JS reaching bridge, cookies, file access, credentials, or native scheme dispatch.

## Guards & Rejection

Safe when: SSL errors always call `cancel()`, exceptions are limited to pinned test/debug builds, and proceeded content cannot access sensitive WebView state.

Reject when: the only impact is loading public content, proceed path is dead/debug-only, or no sensitive WebView context is reachable.

## Rating

- HIGH: MITM content reaches bridge, cookies, credentials, or native action.
- MEDIUM: authenticated UI/content tampering with user interaction.
- LOW: low-value content spoofing.
- IGNORED: proceed call is unreachable or harmless.

## Trace Commands

```bash
decx code xref-method "android.webkit.SslErrorHandler.proceed():void" -P <port>
decx code method-source "<sslErrorCallback>" -P <port>
```

## Example Shapes

Suspicious:

```text
onReceivedSslError calls handler.proceed() -> MITM content loaded in trusted WebView -> reaches bridge, cookies, or credential input
```

Safe:

```text
onReceivedSslError calls handler.cancel() -> or proceeds only for pinned self-signed certs with explicit user confirmation
```

Report guidance -- Use: "The WebView proceeds on certificate errors, letting injected network content reach a sensitive trusted-WebView surface." Avoid: "SSL error handler proceeds" without proving MITM content reaches a meaningful impact surface.

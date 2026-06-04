# Pattern: WebView Intent Scheme Injection

## When To Use

Use this reference when attacker-controlled WebView content reaches `intent://`, custom scheme parsing, or native dispatch from WebView callbacks.

## Core Concept

Untrusted web content controls native `Intent` dispatch from WebView, crossing from web origin into app/component privileges without target validation.

**Sources**
- attacker-controlled WebView URL/HTML/redirect/script; `shouldOverrideUrlLoading`, URL handlers, custom scheme routers; `Intent.parseUri`, URI parsers, route dispatch helpers.

**Sinks**
- `startActivity`, `startService`, `sendBroadcast`, `bindService`; `Intent.parseUri`, custom route launchers, grant-preserving dispatch.

## Guards & Rejection

Safe when: only exact trusted schemes/hosts dispatch, parsed intents are stripped of explicit components/selectors/grants, and final targets are allowlisted.

Reject when: scheme parsing only opens harmless external apps, non-allowlisted schemes are blocked before parsing, or no security-relevant native target is reached.

## Rating

- HIGH: private/protected component or grant reached.
- MEDIUM: bounded unauthorized native action.
- LOW: external-app launch or UI-only deception.
- IGNORED: no native security impact.

## Trace Commands

```bash
decx code method-source "<webviewUrlOverride>" -P <port>
decx code method-context "<nativeSchemeRouter>" -P <port>
```

## Example Shapes

Suspicious:

```text
attacker-controlled URL with intent:// scheme -> WebView parses and launches -> reaches exported native component with sensitive behavior
```

Safe:

```text
shouldOverrideUrlLoading blocks intent:// and custom schemes -> or strict component allowlist filters the resolved target
```

Report guidance -- Use: "Attacker-controlled WebView content can trigger native Intent dispatch without stripping or validating dangerous target fields." Avoid: "WebView handles intent:// URLs" without proving the resolved component exposes protected behavior.

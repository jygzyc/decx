# Pattern: WebView Intent Scheme Injection

## When To Use

Use this reference when attacker-controlled WebView content reaches `intent://`, custom scheme parsing, or native dispatch from WebView callbacks.

## Vulnerability Essence

Untrusted web content controls native `Intent` dispatch from WebView, crossing from web origin into app/component privileges without target validation.

## Sources

- attacker-controlled WebView URL/HTML/redirect/script
- `shouldOverrideUrlLoading`, URL handlers, custom scheme routers
- `Intent.parseUri`, URI parsers, route dispatch helpers

## Sinks

- `startActivity`, `startService`, `sendBroadcast`, `bindService`
- `Intent.parseUri`, custom route launchers, grant-preserving dispatch

## Required Trace Evidence

- Reachability: attacker content reaches the WebView callback that performs native dispatch.
- Controllability: attacker controls parsed scheme, component, package, data, extras, selector, flags, or URI grants.
- Sink: native dispatch reaches protected action, private component, grant, or chain pivot.
- Missing or bypassable guard: non-allowlisted schemes/targets are not blocked or dangerous fields are not stripped.
- Visible impact: protected component launch, sensitive grant, credential/session abuse, or privileged app action.

## Guard Checklist

Consider safe when only exact trusted schemes/hosts dispatch, parsed intents are stripped of explicit components/selectors/grants, and final targets are allowlisted.

## Rejection Rules

Reject when scheme parsing only opens harmless external apps, non-allowlisted schemes are blocked before parsing, or no security-relevant native target is reached.

## Rating Mapping

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

## Report Snippet

Use: "Attacker-controlled WebView content can trigger native Intent dispatch without stripping or validating dangerous target fields."

Avoid: "WebView handles intent:// URLs" without proving the resolved component exposes protected behavior.

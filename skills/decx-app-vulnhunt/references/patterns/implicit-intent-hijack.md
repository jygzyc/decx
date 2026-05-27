# Pattern: Implicit Intent Hijack

## When To Use

Use this reference when sensitive data, URI grants, workflow control, or protected actions are sent through an implicit `Intent` that an attacker app can resolve.

## Vulnerability Essence

The app sends security-relevant data or control to an untrusted resolver because the target component/package is not pinned.

## Sources

- app-generated implicit `Intent`
- action/category/data/type fields influenced by attacker or app state
- extras, `ClipData`, URI grants, pending intents, chooser/share flows

## Sinks

- `startActivity`, `startService`, `sendBroadcast`, chooser flows
- `setResult` or callbacks returning attacker-captured handles
- grant-bearing data delivered to resolved component

## Required Trace Evidence

- Reachability: attacker can cause the implicit dispatch or register a matching resolver.
- Controllability: attacker can receive or influence the relevant data/action/grant.
- Sink: implicit dispatch carries sensitive data, grant, handle, or protected workflow control.
- Missing or bypassable guard: no explicit component/package, signature permission, recipient allowlist, or chooser restriction protects the target.
- Visible impact: sensitive data capture, URI grant leak, workflow hijack, victim-identity handle capture, or protected action redirection.

## Guard Checklist

Consider safe when the target is explicit and trusted, sensitive payloads are removed before implicit dispatch, grants are not attached, and recipient identity is validated when callbacks/results matter.

## Rejection Rules

Reject when the implicit intent carries only public data, no attacker resolver can match, target is pinned before dispatch, or no caller-visible security effect exists.

## Rating Mapping

- HIGH: credentials, tokens, private file grants, or protected workflow handles captured.
- MEDIUM: bounded sensitive data or local workflow hijack.
- LOW: low-value metadata or weak phishing.
- IGNORED: implicit routing with no sensitive payload or impact.

## Trace Commands

```bash
decx code method-context "<implicitIntentCreator>" -P <port>
decx code method-source "<dispatchMethod>" -P <port>
```

## Example Shapes

Suspicious:

```text
app sends implicit Intent with sensitive extras/data -> attacker app resolves and receives the data
```

Safe:

```text
app sends implicit Intent with no sensitive payload -> or uses explicit Intent / signature permission receiver
```

## Report Snippet

Use: "The app sends sensitive data or grants through an implicit Intent that can be resolved by an attacker-controlled component."

Avoid: "implicit Intent is sent" without sensitive payload proof or attacker-resolvable confirmation.

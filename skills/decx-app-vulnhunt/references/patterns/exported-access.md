# Pattern: Exported Component Access Control Failure

## When To Use

Use this reference when an exported Activity, Service, Receiver, or Provider directly exposes a protected screen, data path, or action.

## Vulnerability Essence

An external app reaches an internal capability because component export or permission configuration does not enforce the app's intended trust boundary.

## Sources

- manifest-exported components, deep links, custom permissions, implicit intent filters
- `decx ard exported-components`
- component entry methods such as `onCreate`, `onStartCommand`, `onReceive`, provider CRUD/call/open methods

## Sinks

- protected UI/action, account/session data, provider rows/files, privileged app permission use, admin/settings/payment/debug flows

## Required Trace Evidence

- Reachability: external caller can trigger the component.
- Controllability: caller can reach the sensitive branch or select protected data/action.
- Sink: component performs or exposes a security-relevant operation.
- Missing or bypassable guard: no signature permission, caller/session check, or non-bypassable user confirmation blocks the path.
- Visible impact: unauthorized action, protected data exposure, or security workflow bypass.

## Guard Checklist

Consider safe when manifest permission is signature-bound, in-code caller/session checks gate the sink, or the exported surface exposes only public harmless behavior.

## Rejection Rules

Reject exported-alone claims. Reject when the component has no sensitive behavior, all sensitive branches require trusted caller/session state, or custom permission is proven non-attacker-obtainable.

## Rating Mapping

- HIGH: sensitive data or dangerous action exposed with low friction.
- MEDIUM: bounded protected workflow or local-app-triggered action.
- LOW: weak UI exposure only.
- IGNORED: reachable but harmless component.

## Trace Commands

```bash
decx ard exported-components -P <port>
decx code class-source "<ComponentClass>" -P <port>
```

## Example Shapes

Suspicious:

```text
external caller -> exported Activity with no permission -> reaches protected data screen or privileged action
```

Safe:

```text
external caller -> exported Activity with signature permission or caller validation -> sensitive branches blocked
```

## Report Snippet

Use: "An exported component exposes a protected app capability without a non-bypassable caller or permission guard."

Avoid: "component is exported" without downstream sink, guard bypass, and impact evidence.

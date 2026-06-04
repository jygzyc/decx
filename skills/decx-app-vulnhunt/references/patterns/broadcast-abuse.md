# Pattern: Broadcast Abuse

## When To Use

Use this reference when static or dynamic receivers, ordered broadcasts, custom permissions, or local/global broadcast choices expose protected data or actions.

## Core Concept

Untrusted broadcast input or observation crosses a trust boundary and reaches protected work, sensitive data, or security-relevant broadcast ordering.

**Sources**
- manifest receivers, `registerReceiver`, dynamic actions, ordered broadcasts
- `Intent` action, extras, data, sender package, custom permission
- `abortBroadcast`, result extras/data, global broadcasts carrying sensitive values

**Sinks**
- protected app action in `onReceive`
- sensitive data in broadcast extras or result extras
- ordered broadcast modification/abort affecting security outcome
- component launch or service command dispatch from receiver

## Guards & Rejection

Safe when: broadcasts are explicit/local where needed, signature permissions protect sender/receiver, action/extras are allowlisted, and ordered result data is not security-critical.

Reject when: broadcast is internal-only, extras are harmless, receiver action is public/no-op, custom permission is signature-bound, or ordered manipulation has no security outcome.

## Rating

- HIGH: sensitive data leak or dangerous protected action.
- MEDIUM: bounded unauthorized state/action via local malicious app.
- LOW: weak info leak or UI/noise.
- IGNORED: no attacker reachability or impact.

## Trace Commands

```bash
decx ard exported-components -P <port>
decx code method-source "<receiverOnReceive>" -P <port>
```

## Example Shapes

Suspicious:

```text
dynamic receiver registers for external action -> no sender permission check -> onReceive dispatches extras to protected app action
```

Safe:

```text
dynamic receiver registers with signature sender permission -> onReceive validates action/extras against allowlist -> only harmless branches reachable
```

Report guidance -- Use: "An attacker-controlled broadcast path reaches protected receiver behavior or exposes sensitive broadcast data without a strong permission guard." Avoid: "broadcast receiver is registered dynamically" without source, sink, guard bypass, and impact evidence.

# Pattern: PendingIntent Abuse

## When To Use

Use this reference when attacker-influenced `PendingIntent` creation, mutation, forwarding, `fillInIntent`, notification actions, widgets, alarms, or broadcast/service callbacks may reuse the victim app identity.

## Core Concept

Untrusted input shapes a capability object that later executes as the victim app, allowing the attacker to trigger protected actions or redirect privileged state.

**Sources**
- extras, URI, action, request code, component, package, flags used to build a `PendingIntent`
- attacker-supplied `PendingIntent` passed into app code
- mutable pending intents consumed by notifications, widgets, alarms, shortcuts, or callbacks
- `fillInIntent` data supplied by another app

**Sinks**
- `PendingIntent.getActivity`, `getService`, `getBroadcast`
- `send(...)`, `AlarmManager`, `Notification` actions, app widgets, shortcuts
- component launches or broadcasts triggered from the pending intent target

## Guards & Rejection

Safe when: pending intents are immutable, target explicit trusted components, use stable non-attacker request codes where needed, ignore untrusted fill-in fields, and repeat authorization at execution time.

Reject when: the pending intent is immutable and contains only trusted constants, the attacker cannot obtain or trigger it, execution reaches only harmless UI, or authorization is rechecked before sensitive work.

## Rating

- HIGH: victim identity triggers privileged action, private component, or sensitive data/grant path.
- MEDIUM: bounded local action with user-assisted trigger or constrained target.
- LOW: weak UI deception or notification spam only.
- IGNORED: no attacker control over the executed operation.

## Trace Commands

```bash
decx code method-context "<pendingIntentCreator>" -P <port>
decx code method-source "<pendingIntentTarget>" -P <port>
```

## Example Shapes

Suspicious:

```text
external input -> mutable PendingIntent extras/component -> attacker sends -> victim target performs protected action
```

Safe:

```text
trusted constant target -> FLAG_IMMUTABLE -> target rechecks authorization -> bounded action
```

Report guidance -- Use: "The app creates or accepts a pending intent whose attacker-controlled fields execute a protected action under the app identity." Avoid: "PendingIntent is created with caller-controlled content" without proving the PendingIntent executes under victim identity with security impact.

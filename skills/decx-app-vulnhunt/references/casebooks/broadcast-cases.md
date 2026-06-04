# Casebook: Broadcast Abuse

Use this casebook after [[patterns/broadcast-abuse]]. These cases are abstract exploit shapes, not CVE-specific instructions.

## Case: Dynamic Receiver Dispatches External Extras To Protected Action

### Abstract Shape

```text
external app -> sendBroadcast -> dynamic receiver (exported) -> onReceive dispatches on action -> startService with extras -> privileged operation
```

### Key Mistake

The app registers a dynamic BroadcastReceiver at runtime without setting the exported flag to false, allowing any external application to trigger it.

### Why It Was Exploitable

- dynamic receiver registered via `registerReceiver()` is exported by default
- no permission gate on the receiver or the broadcast action
- `onReceive()` extracts extras and dispatches to internal operations without caller validation
- dispatched operation performs a privileged action such as starting a bound service or writing config

### Generalized Detection Rule

Any dynamic receiver that dispatches to privileged code paths must either set `exported=false`, enforce a signature-level permission, or validate caller identity inside `onReceive()`.

Related: [[patterns/broadcast-abuse]]

## Case: Ordered Broadcast Abort Changes Authorization Outcome

### Abstract Shape

```text
target app -> sendOrderedBroadcast -> malicious higher-priority receiver -> abortBroadcast() or modify result -> authorization check fails or grants wrong access
```

### Key Mistake

The app relies on an ordered broadcast result to make an authorization decision but does not protect the broadcast chain against interception or modification.

### Why It Was Exploitable

- ordered broadcast allows receivers with higher priority to intercept the broadcast first
- a malicious app registers a receiver with `android:priority` set higher than the legitimate one
- the malicious receiver calls `abortBroadcast()` to prevent the result from reaching the intended receiver
- or the malicious receiver sets result data that the originator trusts without verifying the source
- authorization logic treats the broadcast result as authoritative without additional validation

### Generalized Detection Rule

Never rely solely on ordered broadcast results for authorization decisions. Use direct Binder calls or signature-enforced broadcasts for security-critical outcomes.

Related: [[patterns/broadcast-abuse]]

## Case: Weak Custom Permission Gates Sensitive Broadcast

### Abstract Shape

```text
app sends broadcast with custom normal-level permission -> any app declares uses-permission -> onReceive extracts auth token from extras
```

### Key Mistake

The app declares a custom permission with `protectionLevel="normal"` to protect a broadcast carrying sensitive data, but any application can declare that permission at install time without user confirmation.

### Why It Was Exploitable

- custom permission with `normal` protection level is automatically granted to any requesting app
- the broadcast extras contain authentication tokens, session keys, or other secrets
- no additional runtime check validates the receiver's identity
- the permission name is predictable and easily discovered from the manifest

### Generalized Detection Rule

Custom permissions protecting sensitive broadcasts must use `signature` or `signatureOrSystem` protection level. If `normal` is required for compatibility, add a separate Binder-based identity check.

Related: [[patterns/broadcast-abuse]]

## Case: Global Broadcast Carries Sensitive Authentication Token

### Abstract Shape

```text
app -> sendBroadcast(action, extras with token) -> any app's BroadcastReceiver -> extract sensitive token from extras
```

### Key Mistake

The app uses `sendBroadcast()` without specifying a receiver permission, placing session tokens or credentials in the broadcast extras where any registered receiver can read them.

### Why It Was Exploitable

- `sendBroadcast()` with no receiver permission delivers to all matching receivers on the device
- broadcast extras are serialized into the Intent and visible to every matching receiver
- authentication tokens, OAuth refresh tokens, or session identifiers are included in the extras bundle
- a malicious app only needs to register a receiver for the same action string

### Generalized Detection Rule

Never place sensitive tokens in broadcast extras. Use LocalBroadcastManager for intra-app communication or enforce a signature-level permission on both sender and receiver.

Related: [[patterns/broadcast-abuse]]

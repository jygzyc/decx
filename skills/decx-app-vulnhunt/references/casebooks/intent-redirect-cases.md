# Casebook: Intent Redirect

Use this casebook after [[patterns/intent-redirect]]. These cases are abstract exploit shapes, not CVE-specific instructions.

## Public Case: Nested Intent Unsafe Launch

### Source Type

Public Android security guidance on unsafe nested Intent launches and explicit target validation.

### Abstract Shape

```text
external app -> exported component -> nested Intent extra -> victim-context launch -> private action/grant
```

### Key Mistake

The app treats a nested `Intent` supplied by an external caller as trusted and launches it without constraining target, selector, flags, or grants.

### Why It Was Exploitable

- exported entrypoint is reachable by a third-party app
- attacker controls the nested object or security-relevant fields
- victim app performs the launch or grant from its own context
- target component, URI grant, or extras reach behavior unavailable to the attacker directly

### Generalized Detection Rule

If an exported component forwards caller-controlled Intent objects, require exact component/package allowlisting and stripping of selector, `ClipData`, and grant flags before the sink.

### Related

[[patterns/intent-redirect]], [[patterns/uri-grant-leak]], [[patterns/setresult-leak]]

## Case: Exported Activity Redirects To Private Component

### Abstract Shape

```text
external app -> exported Activity -> nested Intent extra -> startActivity -> private Activity
```

### Key Mistake

The exported Activity trusts a caller-supplied nested `Intent` as if it came from internal app code.

### Why It Was Exploitable

- external entrypoint is reachable
- attacker controls nested component, data, extras, or flags
- victim app performs the launch under its own package context
- downstream component exposes sensitive behavior or data

### Generalized Detection Rule

If an exported component forwards caller-controlled `Intent` fields without exact target validation, trace the downstream target as an intent redirect candidate.

Related: [[patterns/intent-redirect]]

### Not Required

Do not require exact package names, exact class names, or a public CVE. The finding depends on the proven source, forwarded fields, sink, guard, and impact.

## Case: Redirect Preserves URI Grants

### Abstract Shape

```text
external app -> exported forwarder -> ClipData/content URI + grant flags -> private file consumer
```

### Key Mistake

The forwarder validates only the action or scheme and preserves grant-bearing data.

### Why It Was Exploitable

- attacker controls target or grant recipient
- sensitive `content://` URI remains attached
- grant flags survive forwarding
- downstream consumer or recipient gains private data access

### Generalized Detection Rule

When a redirect touches `ClipData`, data URI, selector, or `FLAG_GRANT_*`, trace both the component launch and the caller-visible grant path.

Related: [[patterns/intent-redirect]]

## Case: Implicit Broadcast Captures Sensitive Extras

### Abstract Shape

```text
external app -> sendBroadcast(action, extras) -> target onReceive -> extract sensitive data -> unprotected storage or display
```

### Key Mistake

A dynamically registered or exported BroadcastReceiver handles a broadly scoped action and trusts extras from any caller.

### Why It Was Exploitable

- broadcast action is generic or matches a well-known system action string
- receiver does not validate the sender identity or package
- sensitive data extracted from extras is stored, logged, or displayed without sanitization
- attacker crafts a matching implicit broadcast with crafted extras from a third-party app
- no LocalBroadcastManager or signature-level permission restricts delivery

### Generalized Detection Rule

When a receiver for a non-protected action extracts and processes data from extras without sender validation, trace the data flow to a sensitive sink.

Related: [[patterns/intent-redirect]]

## Case: Selector-Based Redirect Bypasses Package Check

### Abstract Shape

```text
external app -> exported Activity -> Intent with selector overriding package check -> startActivity -> private Activity
```

### Key Mistake

The exported component validates only the target package name but the attacker sets `Intent.setSelector()` to override resolution after the check passes.

### Why It Was Exploitable

- exported entrypoint inspects `getPackage()` or component class but ignores selector
- selector overrides component resolution at `startActivity` time
- the forwarded intent retains flags and extras from the original
- downstream private component executes under the app's identity
- validation order matters: check-then-set-selector wins because selector is applied late

### Generalized Detection Rule

Any intent-forwarding path that checks package or component but does not strip or reject the selector field is a redirect candidate.

Related: [[patterns/intent-redirect]]

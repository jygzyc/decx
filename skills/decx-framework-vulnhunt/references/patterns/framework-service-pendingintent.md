# Pattern: Framework Service PendingIntent Abuse

## When To Use

Use this reference when Binder input reaches framework-service `PendingIntent` creation, mutation, storage, dispatch, cancellation, or identity reuse.

## Vulnerability Essence

Untrusted callers can cause a privileged framework service to create or send a `PendingIntent` with attacker-controlled action, target, extras, flags, user, or authority.

## Sources

- Binder parameters carrying `Intent`, `PendingIntent`, package, request code, flags, extras, user ID, or callback token
- stored caller-provided `PendingIntent` later sent by system service code
- fill-in intents, mutable pending intents, or caller-controlled update/cancel paths

## Sinks

- `PendingIntent.getActivity`, `getService`, `getBroadcast`, `getForegroundService`
- `PendingIntent.send`
- `ActivityOptions`, URI grant, or cross-user dispatch tied to a pending intent

## Required Trace Evidence

- Reachability: attacker can invoke the Binder method or register the callback/token.
- Controllability: attacker controls target, flags, extras, fill-in data, recipient, or user.
- Sink: framework creates, stores, mutates, or sends the pending intent under privileged context.
- Missing or bypassable guard: no caller binding, target allowlist, immutable flag enforcement, package/signature check, or user restriction blocks abuse.
- Visible impact: privileged launch, protected broadcast/service action, cross-user action, URI grant, or confused-deputy operation.

## Guard Checklist

Consider safe when the service uses immutable pending intents, trusted constant targets, exact caller UID/package binding, cross-user checks, and strips caller-controlled dangerous flags/extras before dispatch.

## Rejection Rules

Reject when the pending intent target is trusted and immutable, caller can only trigger its own identity, validation binds package to UID, or the only effect is benign UI noise.

## Rating Mapping

- CRITICAL: pending intent abuse directly enables system-level compromise or persistent privileged action.
- HIGH: system identity can be abused for protected launch, broadcast, grant, or cross-user action.
- MEDIUM: bounded unauthorized action requiring strong local prerequisites.
- IGNORED: no privileged identity reuse or no attacker-controlled security field.

## Trace Commands

```bash
decx code method-context "<binderMethod>" -P <port>
decx code xref-method "android.app.PendingIntent.send():void" -P <port>
decx code search-global "PendingIntent.get" --limit 50 -P <port>
```

## Report Snippet

Use: "A Binder-exposed framework path lets attacker-controlled PendingIntent data be created or dispatched under privileged service context."

# Pattern: Framework Service Intent Launch

## When To Use

Use this reference when Binder input reaches framework-service `Intent` construction, forwarding, broadcast, activity/service launch, or URI grant paths. Use `framework-service-pendingintent.md` when the primary sink is `PendingIntent` creation, mutation, storage, or dispatch.

## Vulnerability Essence

Untrusted IPC input controls a privileged framework launch or grant path, causing system identity to perform an attacker-selected action.

## Sources

- Binder parameters carrying `Intent`, action, data URI, package, component, extras, flags, user ID
- framework service helper that constructs an `Intent` from caller fields

## Sinks

- `startActivityAsUser`, `startService`, `sendBroadcast`, `sendBroadcastAsUser`
- `grantUriPermission`, result or callback paths carrying `Intent`/URI

## Required Trace Evidence

- Reachability: attacker can invoke the Binder method or callback.
- Controllability: attacker controls launch target, data, extras, flags, grant recipient, or user.
- Sink: framework service performs launch/grant/broadcast under privileged context.
- Missing or bypassable guard: no exact target/recipient/user/signature validation or permission check blocks the path.
- Visible impact: protected component launch, cross-user action, URI grant, privileged broadcast, or security workflow bypass.

## Guard Checklist

Consider safe when targets are exact-allowlisted, dangerous flags/grants are stripped, user boundaries are enforced, recipients are trusted, and downstream components perform their own permission checks.

## Rejection Rules

Reject when launched target is trusted constant, input only affects benign extras, a non-bypassable permission guard exists before launch, or downstream behavior has no security impact.

## Rating Mapping

- CRITICAL: system identity launches or grants into a path causing device-level compromise.
- HIGH: protected component/action/grant under system identity.
- MEDIUM: bounded unauthorized launch requiring extra prerequisites.
- IGNORED: no attacker-controlled target or no impact.

## Trace Commands

```bash
decx code method-context "<binderMethod>" -P <port>
decx code xref-method "<frameworkLaunchSink>" -P <port>
```

## Report Snippet

Use: "A framework Binder method lets attacker-controlled launch data reach a privileged Intent sink without exact target validation."

# Pattern: Framework Service Intent Launch

## When To Use

Use this reference when Binder input reaches framework-service `Intent` construction, forwarding, broadcast, activity/service launch, or URI grant paths. Use `framework-service-pendingintent.md` when the primary sink is `PendingIntent` creation, mutation, storage, or dispatch.

## Core Concept

Untrusted IPC input controls a privileged framework launch or grant path, causing system identity to perform an attacker-selected action.

**Sources**
- Binder parameters carrying `Intent`, action, data URI, package, component, extras, flags, user ID
- framework service helper that constructs an `Intent` from caller fields

**Sinks**
- `startActivityAsUser`, `startService`, `sendBroadcast`, `sendBroadcastAsUser`
- `grantUriPermission`, result or callback paths carrying `Intent`/URI

## Required Trace Evidence

- Reachability: attacker can invoke the Binder method or callback.
- Controllability: attacker controls launch target, data, extras, flags, grant recipient, or user.
- Sink: framework service performs launch/grant/broadcast under privileged context.
- Missing or bypassable guard: no exact target/recipient/user/signature validation or permission check blocks the path.
- Visible impact: protected component launch, cross-user action, URI grant, privileged broadcast, or security workflow bypass.

## Guards & Rejection

Safe when: targets are exact-allowlisted, dangerous flags/grants are stripped, user boundaries are enforced, recipients are trusted, and downstream components perform their own permission checks. Intent target, component, flags, grants, and user must be validated or pinned before any privileged launch or grant.

Reject when: launched target is trusted constant, input only affects benign extras, a non-bypassable permission guard exists before launch, or downstream behavior has no security impact.

## Rating

- CRITICAL: system identity launches or grants into a path causing device-level compromise.
- HIGH: protected component/action/grant under system identity.
- MEDIUM: bounded unauthorized launch requiring extra prerequisites.
- IGNORED: no attacker-controlled target or no impact.

## Trace Commands

```bash
decx code method-context "<binderMethod>" -P <port>
decx code xref-method "<frameworkLaunchSink>" -P <port>
```

## Example Shapes

Suspicious:
```text
public void launchForCaller(Intent intent, UserHandle user) {
    // no target or flag validation before launch
    mContext.startActivityAsUser(intent, user); // system_server launches attacker-controlled intent
}
```

Safe:
```text
public void launchForCaller(Intent intent, UserHandle user) {
    ComponentName target = intent.getComponent();
    if (!ALLOWED_COMPONENTS.contains(target)) {
        throw new SecurityException("Untrusted target");
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    intent.setClipData(null); // strip attacker extras
    mContext.startActivityAsUser(intent, user);
}
```

Report guidance -- Use: "A framework Binder method lets attacker-controlled launch data reach a privileged Intent sink without exact target validation." Avoid: "The service starts an activity" (must show attacker controls the target/flags/grant and the launch occurs under privileged identity without pinning).

# Pattern: Framework Service Intent Launch

## Match

Binder input reaches framework `Intent` construction, forwarding, broadcast, service/activity launch, result/callback intent, or URI grant path under privileged identity. High-signal launch patterns: forwarding a lower-privileged callback's `Intent`, rebuilding from caller-supplied `ComponentName`, returning the caller's grant-bearing `Intent` through a result/callback, or dispatching a pending/indirect launch with forgeable caller identity metadata.

## Analyze

- entry: Binder method/callback carrying `Intent`, `Bundle`, action, data URI, package, component, flags, selector, `ClipData`, user; indirect launch callback; `startActivityAsUser`; `startServiceAsUser`; `sendBroadcastAsUser`; result/callback path
- control: target component/package, flags/grants, selector, `ClipData`, extras, user, recipient, `Intent.parseUri` parsed field, `ComponentName.unflattenFromString`, external callback response
- sink: `startActivityAsUser`, `startService`, `sendBroadcast*`, `grantUriPermission`, result/callback intent, private target reached through the launch
- guard: exact target/recipient/user allowlist; `Intent.getPackage()` equals self; caller identity check via `getCallingActivity()` / `getCallingPackage()`; binder caller UID rebinding at the dispatch site; strip dangerous flags (`FLAG_GRANT_*`); forbid the calling UID from supplying a `ComponentName` directly; validate indirect launch metadata at the final dispatch site
- impact: protected launch/broadcast/grant, cross-user action, private component reachability, security workflow bypass, grant flag and `content://` URI flowing to attacker through a result/callback, or foreground launch under the wrong caller identity

## Required Trace Evidence

Reachability, Controllability, Sink, Missing guard, Visible impact

## Reject

Reject when launched target is a trusted constant, input only affects benign extras, a non-bypassable guard exists before launch (`enforceCallingOrSelfPermission` + caller-uid-rebuilt `ComponentName`), dangerous fields and grant flags are stripped before forwarding, indirect launch identity is re-derived at dispatch, or downstream behavior has no security impact.

## Codes

```java
// service forwards callback-supplied Intent into a privileged launch path
startActivityAsUser(callbackResult.getParcelable("intent"), user);
```

```java
// service rebuilds an Intent from a caller-supplied ComponentName and starts it;
// no allowlist, no caller-uid rebinding
startActivityAsUser(new Intent().setComponent(componentFromBinder), user);
```

```java
// service returns the caller's exact Intent (with FLAG_GRANT_* and a content:// URI)
// via setResult; the caller receives a temporary grant on the privileged provider
result.send(RESULT_OK, callerIntent);
```

# Pattern: Framework Service Permission Missing

## Match

Binder-exposed framework method performs privileged work, returns protected state, changes policy/configuration, launches/grants, or proxies data before a non-bypassable permission, app-op, UID/package, or user restriction check. Four common shapes: a Binder method that never calls `enforceCallingOrSelfPermission`; a method that only checks on the client-side wrapper while the service-side implementation is unprotected; the special `dump` / `shellCommand` paths where the default `Binder.onShellCommand` check is bypassed by overriding `onShellCommand`; and a method that checks `Binder.getCallingUid()` but trusts a caller-supplied `packageName` without binding it to the UID.

## Analyze

- trace from the public Binder/manager facade to the first privileged sink. Record the earliest guard that dominates the sink, then check whether alternate branches (`dump`, `onShellCommand`, callback, batch loop, helper overload) bypass that guard.
- entry: Binder Stub/manager method, shell/system service entrypoint, callback reachable by lower-privileged caller, `onShellCommand` override, `applyBatch` per-operation loop
- control: method parameters, package/UID/user, attribution tag, `Intent`, `Uri`, `Bundle`, token, callback, caller-supplied `packageName` / `userId` / `attributionTag`
- sink: settings/package/user/device policy, account/notification/location/telephony/storage/permission operation, provider/file access, privileged launch/broadcast, grant/PI dispatch, `dumpsys` output, `cmd xxx yyy` shell command
- guard: signature/system permission via `enforceCallingOrSelfPermission` (or `enforcePermission` + `Binder.getCallingPid`), app-op via `AppOpsManager`, UID/package ownership via `AppOpsManager.checkPackage(uid, pkg)` or `isSameApp`, user restriction via `UserManager`/`DevicePolicyManager`, callee guard before sink, package-to-UID binding in every Binder entry that accepts `packageName` as a parameter
- impact: protected data/action, state change, privilege misuse, persistent device effect, shell/dump exposure, or privileged diagnostic output

## Required Trace Evidence

Reachability, Controllability, Sink, Missing guard, Visible impact

## Reject

Reject when caller cannot reach the method, guard covers every path before sink, operation is public/harmless, or a lower-level callee enforces the same non-bypassable guard. For shell command paths, reject when the service uses `handleShellCommand` (so the default `Binder.onShellCommand` UID=root/shell check applies) or every `ShellCommand` action re-checks permission/UID.

## Codes

```java
// missing service-side gate before protected state/action
return mPolicyStore.getUserPolicy(userId).isKeyguardDisabled(packageName);
```

```java
// boundary mistake: check exists only in manager/client wrapper, not Binder implementation
managerWrapper.enforcePermission();
mService.setPolicy(pkg, value); // Binder entry bypasses wrapper
```

```java
// extreme edge: override skips Binder's default root|shell onShellCommand gate
override onShellCommand(...) -> new MyShellCommand(...).exec(...)
```

```java
// shell path opens caller-selected file under system_server; should use ShellCallback FD
new FileOutputStream(pathFromArgs);
```

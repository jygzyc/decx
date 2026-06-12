# Pattern: Framework Service Data Leak

## Match

Binder-exposed framework code returns protected system/package/user/account/policy/device/service state, callback payload, `Bundle`, list, FD, cursor data, or result to a lower-privileged caller. Most data-leak cases are either a sub-case of missing permission (the method returns because the guard is missing) or a sub-case of caller-forged scope (the method trusts a caller-supplied string and returns the wrong data). A specific framework data-leak shape is the `applyBatch` / `call` path: `query`/`insert`/`update`/`delete` enforce a permission, but `applyBatch` or `call` skip the per-operation check and return rows/file descriptors to the caller.

## Analyze

- entry: Binder read/query method, callback registration, manager facade, provider/file helper, `call()`, `applyBatch()`, permission/package/user/account/device-state getter, process/task listing getter, cross-profile listing getter
- control: package/user/account/scope/flags, attribution, token, callback, query filter, `app-op` mode, `UserManager.getUserInfo`, `UserHandle.getIdentifier`
- sink: return value, callback, `Bundle`, list, FD, cursor, broadcast/result payload, account/notification/settings/policy state
- guard: signature permission via `enforceCallingOrSelfPermission`, package-to-UID binding via `AppOpsManager.checkPackage(uid, pkg)`, user/profile check via `getCallingUserId` / `INTERACT_ACROSS_USERS`, per-caller filtering of returned data, lower-level callee guard, `applyBatch` per-operation permission check (rarely present)
- impact: protected state visible to unauthorized caller or scope widened beyond caller-owned package, user, account, profile, process, or device state

## Required Trace Evidence

Reachability, Controllability, Sink, Missing guard, Visible impact

## Reject

Reject when data is public, caller-owned, synthetic/debug-only, fully filtered before return, or all paths enforce caller authorization for selected scope. For `applyBatch` / `call`, reject when the lower-level `query` / `insert` / `update` / `delete` is reachable with the same permission guard and the call is restricted to public data.

## Codes

```java
// getter returns per-package data keyed on a caller-supplied packageName without
// AppOpsManager.checkPackage
```

```java
// provider call() / applyBatch bypasses the per-operation permission gate
```

```java
// exported system provider declares no android:permission and leaks protected content
// to any caller that knows the authority
```

```java
// getter returns data for the caller's request without filtering to caller scope
// (cross-package, cross-user, or all-instances)
```

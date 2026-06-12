# Pattern: Framework Service Identity Confusion

## Match

Service trusts caller-supplied package, UID, user, attribution tag, account, profile, cached record, callback token, or pending intent identity instead of deriving and binding it from Binder/PackageManager state. Two main shapes: (1) the service treats `Binder.getCallingUid()` as the source of truth for who is asking, but the parameter it consumes comes from a caller-supplied identity field and is never bound to that UID; or (2) the service clears caller identity to system, then performs the work with caller-supplied package/user metadata, so the privileged actor and recorded owner diverge.

## Analyze

- trace where the identity value is derived, where it is bound, and where it is consumed. Treat any parameter named `packageName`, `uid`, `userId`, `attributionTag`, `account`, or `token` as untrusted until it is rebound to Binder state or an owner record.
- entry: Binder method/callback accepting identity-bearing parameters, identity-cleared block re-using caller-provided identity, cached identity from a prior Binder call, accountManager / keyguard / notification manager
- control: package, UID, user/profile, attribution, account, device ID, token, callback, pending intent creator/target, `AppOpsManager.checkPackage`
- sink: app-op/permission decision, package/user-scoped data/action, account/notification/location/storage/device policy, cross-user/profile access, settings mutation, credential/key access, scoped provider query
- guard: package-to-UID binding via `AppOpsManager.checkPackage(uid, pkg)` (preferred), `PackageManager.getPackageUid(pkg) == Binder.getCallingUid()`, or `ActivityManager.isSameApp(uid1, uid2)`; `UserHandle.getUserId(Binder.getCallingUid())` for caller-user derivation; `INTERACT_ACROSS_USERS` enforcement before any cross-user work; token ownership bound to a specific UID at registration; cached record invalidated when identity or auth state changes
- impact: cross-package/cross-user data/action, policy bypass, wrong identity launch/grant, persistent state mutation that the legitimate owner cannot revoke; in the framework, identity confusion almost always chains with provider-data-leak or intent-launch to produce a full confused-deputy chain

## Required Trace Evidence

Reachability, Controllability, Sink, Missing guard, Visible impact

## Reject

Reject when identity is used only for logging, package/user is rebound to `Binder.getCallingUid()` and `UserHandle.getUserId(uid)`, target access is enforced before sink via a non-bypassable check, the token is owner-bound at registration and re-bound at use, or impact remains caller-owned.

## Codes

```java
// service-owned callback has no caller identity; writable state becomes identity input
String owner = settings.getString("owner_package");
privilegedSpawner.setOwner(owner);
```

```java
// caller-supplied packageName keys protected state without checkPackage(callingUid, packageName)
return mStore.readPolicy(packageName, userId);
```

```java
// boundary mistake: identity checked at registration, cached package reused at async dispatch
mRecords.put(token, new Record(packageName));
sendPrivilegedCallback(mRecords.get(token).packageName);
```

```java
// extreme edge: clear identity, then record caller-supplied package/user as owner
withCleanCallingIdentity(() -> mDeviceState.setOwner(packageNameFromBinder, userIdFromBinder));
```

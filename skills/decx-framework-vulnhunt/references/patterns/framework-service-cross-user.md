# Pattern: Framework Service Cross-User

## Match

Binder input controls target user/profile or per-user key, and service reads/writes/launches/returns state for a different user without same-user or cross-user authorization. Two recurring shapes: an API whose `userId` parameter is taken as a target without first checking that the caller has `INTERACT_ACROSS_USERS` / `INTERACT_ACROSS_USERS_FULL` (e.g. `areNotificationsEnabledForPackage`, `getDefaultSmsPackage`); and an API that asks the caller to pass a `uid` and trusts that the uid belongs to the right user without binding to the caller UID. Cross-user content URIs are written `content://<userId>@authority/path` and require explicit cross-user permission to open.

## Analyze

- trace the target user from Binder input, URI prefix, or cached record to the sink. Derive caller user from `Binder.getCallingUid()` and prove the exact branch when `targetUser != callerUser`.
- entry: Binder method, manager facade, callback, provider/launch helper with target user, content URI authority prefix `10@authority/...` denoting userId 10
- control: user ID, profile ID, `UserHandle`, account/profile target, per-user package/state key, `UserHandle.getIdentifier()`, `ActivityManager.getCurrentUser()`, `getCallingUserId()`
- sink: `Context.startActivityAsUser(intent, userHandle)`, `sendBroadcastAsUser`, `sendOrderedBroadcastAsUser`, `getContentResolver().query(uri)` with `crossUserUriPermission`, per-user store (Settings.Secure, account manager, notification manager, keyguard), package/account/settings state, cross-profile action
- guard: derive caller user from `Binder.getCallingUid()` (e.g. `UserHandle.getUserId(callingUid)`); require `INTERACT_ACROSS_USERS` or `INTERACT_ACROSS_USERS_FULL` when `targetUser != callerUser`; in API code, reject `uid` parameters that resolve to another user's UID unless the caller has cross-user permission; for provider code, strip the `userId@` prefix from content URIs and re-enforce cross-user permission
- impact: other-user/profile data read, action, grant, state change, or policy bypass

## Required Trace Evidence

Reachability, Controllability, Sink, Missing guard, Visible impact

## Reject

Reject when target user is caller user, `INTERACT_ACROSS_USERS` is enforced before the sink (caller passes the check), the profile relationship is verified (`UserManager.isSameProfileGroup`), the returned data is filtered to caller scope, or the only cross-user branch is on a known trusted same-app context (e.g. an internal service that always operates on the system user).

## Codes

```java
// caller-selected userId reaches per-user state without same-user/cross-user gate
Settings.Secure.getStringForUser(mResolver, key, userId);
```

```java
// boundary mistake: caller supplies uid; service derives user from that uid, not Binder uid
int userId = UserHandle.getUserId(uidFromBinder);
```

```java
// extreme edge: content://10@authority path opens another user's provider data
resolver.query(Uri.parse("content://10@settings/secure/sms_default_application"), ...);
```

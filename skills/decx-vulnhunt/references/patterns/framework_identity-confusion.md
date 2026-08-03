---
name: identity-confusion
track: framework
---

# identity-confusion

## Match
Service trusts caller-supplied package, UID, user, attribution tag, account, profile, cached record, callback token, or PI creator identity instead of deriving from `Binder.getCallingUid()` / `PackageManager`.

Also covers **cross-user** confusion: caller-supplied `userId`/`uid` trusted across user/profile boundary.

## Non-obvious
- **Two shapes**: (1) `getCallingUid()` read but consumed identity comes from caller-supplied field, never bound; (2) caller identity cleared, then caller-supplied package/user recorded as owner under system identity
- `AppOpsManager.checkPackage(uid, pkg)` is preferred binding; alternatives: `PackageManager.getPackageUid(pkg) == getCallingUid()` or `ActivityManager.isSameApp(uid1, uid2)`
- Cross-user content URI literal: `content://<userId>@authority/path` — the `userId@` prefix is the signal
- `ActivityManager.getCurrentUser()` (foreground user) ≠ `getCallingUserId()` (caller's user) — confusing them is itself a bug
- `UserManager.isSameProfileGroup` is the profile-relationship check (work vs personal), distinct from cross-user check
- `INTERACT_ACROSS_USERS` (lighter) vs `INTERACT_ACROSS_USERS_FULL` (full per-user data access)
- Token ownership must be bound to specific UID at registration; token-to-package cache that doesn't survive UID change is the bug
- Service-owned callback reading writable state (e.g. `Settings.getString("owner_package")`) to feed `setOwner` = confused-deputy chain
- `withCleanCallingIdentity` + caller-supplied `packageName`/`userId` as owner argument = confused-deputy (chains with provider proxy or intent launch)

## Reject
Identity used only for logging, package/user rebound to `getCallingUid()` + `UserHandle.getUserId(uid)`, target access enforced before sink, or token owner-bound at registration and re-bound at use.

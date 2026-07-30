---
name: permission-missing
track: framework
---

# permission-missing

## Match
Binder-exposed framework method performs privileged work, returns protected state, changes policy, launches/grants, or proxies data before non-bypassable permission/app-op/UID-package/user-restriction check.

Also covers `data-leak` shape: protected framework data returned to lower-privileged caller without scope binding.

## Non-obvious
- **Four recurring shapes**: (1) never calls `enforceCallingOrSelfPermission`; (2) client-side check only, not in service-side Binder impl; (3) `onShellCommand` override **bypasses** default `Binder.onShellCommand` UID=root/shell gate; (4) trusts caller-supplied `packageName` while only checking `Binder.getCallingUid()`
- `applyBatch`/`call()` **routinely bypass** per-operation authorization that `query`/`insert`/`update`/`delete` enforce — guard skew
- `AppOpsManager.checkPackage(uid, pkg)` or `isSameApp` is the UID/package ownership check; `enforceCallingOrSelfPermission` alone is NOT
- `enforcePermission` + `Binder.getCallingPid()` is the PID-binding variant for UID-spoofing resistance
- `dumpsys` output and `cmd xxx yyy` shell command are sinks — data disclosure to dump-permission holder is the bug
- Exported system provider with no `android:permission` leaks to any caller knowing the authority
- `UserManager`/`DevicePolicyManager` are user-restriction gate sources; absence for cross-user APIs is the bug

## Reject
Caller cannot reach method, guard covers every path before sink, operation is public/harmless, or lower-level callee enforces same guard.

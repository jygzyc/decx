# Pattern: Framework Service ContentProvider Proxy

## Match

Binder input reaches `ContentResolver`, provider proxy, URI grant, file descriptor, provider `call`, or stored URI/grant operation performed under system/cleared/framework identity. High-signal shapes include broad provider roots plus grant primitive, `applyBatch` bypassing per-row checks, `call` returning protected data, and `openFileDescriptor` returning a `ParcelFileDescriptor` to a caller-influenced path.

## Analyze

- trace the URI from Binder input or stored grant creation into the exact provider operation. Check authority, path, user prefix, grant recipient, and whether the provider sees the original caller or the framework service identity.
- entry: Binder method/callback accepting `Uri`, authority/path, projection/selection, `Bundle`, `ClipData`, user, package, FD target; `ContentResolver.query/openInputStream/openOutputStream/call/applyBatch` invoked from framework code; `FileProvider` with broad `<root-path>`; `grantUriPermission` on caller-supplied target package/URI
- control: URI authority/path/user/operation, projection, provider method, grant recipient, returned data scope, `Uri.getUserInfo()`, `Uri.getQueryParameter`, file id, document id, `applyBatch` operation array
- sink: `query/insert/update/delete/call/openFileDescriptor/openInputStream`, `grantUriPermission`, persistable grant (`takePersistableUriPermission`), returned cursor/FD/data, `Intent.setData` carrying the proxy URI
- guard: authority/path allowlist (e.g. `Settings.AUTHORITY`, `Telephony.Carriers.AUTHORITY`), canonicalization, original-caller provider permission (`enforceCallingOrSelfPermission` on the provider's own gate), package/UID binding via `AppOpsManager.checkPackage`, user/profile check, returned-data filtering, reject `file://` URIs in `Intent` extras, drop the user prefix from cross-user content URIs unless the caller has `INTERACT_ACROSS_USERS_FULL`
- impact: protected provider read/write/delete/call, URI grant leak, cross-user provider access, privileged FD exposure, persistent grant of URI access to attacker package (via `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` + persistable grants)

## Required Trace Evidence

Reachability, Controllability, Sink, Missing guard, Visible impact

## Reject

Reject when provider data is public/caller-owned, URI is a trusted constant, the provider enforces original-caller permission at the URI path level, returned data is fully filtered, or authority/path/user is allowlisted before any privileged access. For `call`, reject when the method name is in a public allowlist and the parameters are not user-influenced.

## Codes

```java
// privileged proxy: caller Uri is opened by framework identity
resolver.openFileDescriptor(callerUri, "r");
```

```java
// boundary mistake: CRUD path is scoped, but provider call() method is caller-selected
Bundle result = resolver.call(uri, methodFromBinder, null, extras);
```

```java
// extreme edge: framework writes a persistent grant to attacker package
mContext.grantUriPermission(attackerPackage, callerUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
takePersistableUriPermission(callerUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
```

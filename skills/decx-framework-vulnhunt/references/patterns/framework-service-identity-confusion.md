# Pattern: Framework Service Identity Confusion

## When To Use

Use this reference when a framework service trusts caller-supplied package/user/UID attribution, cached identity, or cross-user target data instead of deriving identity from Binder and package manager state.

## Core Concept

Attacker-controlled identity fields are mistaken for trusted caller identity, allowing cross-package or cross-user access to privileged operations.

**Sources**
- package name, attribution tag, user ID, UID, `UserHandle`, account, profile, device ID parameters
- Binder caller UID/user ID
- callbacks, tokens, pending intents, or cached records that mix caller and target identity

**Sinks**
- package/user-scoped data reads or writes
- permission/app-op decisions
- account, notification, location, telephony, storage, or device policy operations
- cross-user or profile-boundary access

## Required Trace Evidence

- Reachability: untrusted caller can invoke the service method.
- Controllability: attacker supplies or influences identity fields used by the decision.
- Sink: privileged operation applies to another package/user/profile or returns protected state.
- Missing or bypassable guard: no UID-to-package, user/profile, ownership, or permission validation binds supplied identity to caller.
- Visible impact: cross-package/cross-user data access, unauthorized state change, or policy bypass.

## Guards & Rejection

Safe when: caller UID is derived from Binder, package is checked against UID, target user access is enforced, app-op attribution is verified, and cached tokens cannot be replayed across users/packages. Package/UID must be derived from Binder.getCallingUid() and PackageManager; never trust caller-supplied identity fields for authorization.

Reject when: supplied identity is used only for logging, the service rebinds it to `Binder.getCallingUid()`, cross-user checks are enforced before sink, or impact remains caller-owned.

## Rating

- CRITICAL: cross-user/system policy bypass with persistent device-level impact.
- HIGH: protected data/action for another app/user/profile.
- MEDIUM: bounded cross-package or cross-profile state confusion.
- IGNORED: identity field is not security-relevant.

## Trace Commands

```bash
decx code method-context "<binderMethod>" -P <port>
decx code method-source "<identityCheckOrSink>" -P <port>
```

## Example Shapes

Suspicious:
```text
public Bundle getAppData(String packageName) {
    // trusts caller-supplied package name without binding to Binder UID
    return mPackageManager.getPackageInfo(packageName, 0); // returns data for arbitrary package
}
```

Safe:
```text
public Bundle getAppData(String packageName) {
    int callerUid = Binder.getCallingUid();
    String[] packages = mPackageManager.getPackagesForUid(callerUid);
    if (!Arrays.asList(packages).contains(packageName)) {
        throw new SecurityException("Package mismatch");
    }
    return mPackageManager.getPackageInfo(packageName, 0);
}
```

Report guidance -- Use: "The service trusts caller-supplied identity fields without binding them to the Binder caller before a privileged operation." Avoid: "The method uses a string parameter for package name" (must show the parameter reaches a privileged decision without Binder-identity binding).

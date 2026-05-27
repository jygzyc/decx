# Pattern: Framework Service Identity Confusion

## When To Use

Use this reference when a framework service trusts caller-supplied package/user/UID attribution, cached identity, or cross-user target data instead of deriving identity from Binder and package manager state.

## Vulnerability Essence

Attacker-controlled identity fields are mistaken for trusted caller identity, allowing cross-package or cross-user access to privileged operations.

## Sources

- package name, attribution tag, user ID, UID, `UserHandle`, account, profile, device ID parameters
- Binder caller UID/user ID
- callbacks, tokens, pending intents, or cached records that mix caller and target identity

## Sinks

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

## Guard Checklist

Consider safe when caller UID is derived from Binder, package is checked against UID, target user access is enforced, app-op attribution is verified, and cached tokens cannot be replayed across users/packages.

## Rejection Rules

Reject when supplied identity is used only for logging, the service rebinds it to `Binder.getCallingUid()`, cross-user checks are enforced before sink, or impact remains caller-owned.

## Rating Mapping

- CRITICAL: cross-user/system policy bypass with persistent device-level impact.
- HIGH: protected data/action for another app/user/profile.
- MEDIUM: bounded cross-package or cross-profile state confusion.
- IGNORED: identity field is not security-relevant.

## Trace Commands

```bash
decx code method-context "<binderMethod>" -P <port>
decx code method-source "<identityCheckOrSink>" -P <port>
```

## Report Snippet

Use: "The service trusts caller-supplied identity fields without binding them to the Binder caller before a privileged operation."

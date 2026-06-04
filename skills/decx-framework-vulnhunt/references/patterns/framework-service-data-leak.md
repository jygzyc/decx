# Pattern: Framework Service Data Leak

## When To Use

Use this reference when Binder-exposed framework code returns protected system, package, user, account, policy, device, or service state to a lower-privileged caller.

## Core Concept

Untrusted callers can read privileged framework data because authorization, identity binding, or user-boundary checks do not protect the returned value.

**Sources**
- Binder method parameters, package/user/UID selectors, attribution tags, callbacks
- service caches, manager facade methods, provider/file reads under system identity

**Sinks**
- return values, callbacks, bundles, lists, file descriptors, provider cursor data, broadcast/result payloads

## Required Trace Evidence

- Reachability: attacker can call the Binder/service method.
- Controllability: attacker can select or influence the protected data scope.
- Sink: returned data is protected and visible to the caller.
- Missing or bypassable guard: no permission, app-op, UID/package ownership, same-user/cross-user, or caller validation protects the read.
- Visible impact: sensitive system/user/app data disclosure or chain-enabling protected metadata.

## Guards & Rejection

Safe when: the service enforces the right signature permission, binds package to UID, enforces user/profile boundaries, filters returned data per caller, and lower-level callees repeat the guard. Returned data must be filtered per caller UID/package/user; no raw privileged state reaches lower-privileged callers.
Reject when: data is public, caller-owned, synthetic, debug-only, or fully filtered before return.

## Rating

- CRITICAL: leak directly enables device/system compromise or high-value auth material theft.
- HIGH: sensitive system/user/app data disclosure.
- MEDIUM: bounded protected metadata with practical chain value.
- IGNORED: public or caller-owned data only.

## Trace Commands

```bash
decx code method-context "<binderReadMethod>" -P <port>
decx code method-source "<dataProducerOrFilter>" -P <port>
```

## Example Shapes

Suspicious:
```text
Binder method returns List<ApplicationInfo> filtered by caller-supplied flags → no permission check → caller reads all installed packages including system-hidden apps
```

Safe:
```text
Binder method enforces GET_PACKAGE_INFO permission → binds calling UID to package → filters returned fields per caller identity before returning
```

Report guidance -- Use: "A Binder-exposed framework method returns protected service data without enforcing caller authorization for the selected scope." Avoid: "Data returned without checks."

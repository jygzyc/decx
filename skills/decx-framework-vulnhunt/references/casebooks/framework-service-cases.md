# Casebook: Framework Service Bugs

Use this casebook after the framework service pattern references. These are generalized exploit-chain shapes, not runtime validation claims.

## Public Case: Binder Service Missing Guard Before System-Identity Sink

### Source Type

Public Android framework security bulletin/guidance pattern for Binder-exposed privileged operations.

### Abstract Shape

```text
lower-privileged app -> Binder method params -> weak/missing guard -> system_server sink
```

### Key Mistake

The service assumes only trusted callers reach the method, or it checks identity after entering a privileged sink path.

### Why It Was Exploitable

- Binder method is reachable from a lower-privileged caller
- attacker controls target package, user, URI, Intent, or operation parameter
- service performs data access, launch, grant, or state change as a privileged process
- permission, app-op, UID/package, and user-boundary checks are absent or stale

### Generalized Detection Rule

For each Binder-exposed method, bind caller UID/package/user to the requested target before any privileged sink, identity-clearing block, async handoff, provider proxy, or launch.

### Related

[[patterns/framework-service-permission-missing]], [[patterns/framework-service-clear-identity]], [[patterns/framework-service-identity-confusion]]

## Case: Missing Permission Before Privileged State Change

### Abstract Shape

```text
unprivileged app -> Binder method -> no enforce/check before sink -> protected setting/state update
```

### Key Mistake

The service assumes the method is only reachable by trusted callers or relies on a lower-level helper that does not actually enforce the required permission.

### Why It Was Exploitable

- Binder surface is callable by a lower-privileged app
- attacker controls the operation parameter or target
- protected state changes before any non-bypassable guard
- visible consequence is system-level or security-relevant

### Generalized Detection Rule

Every Binder-exposed privileged operation needs an explicit permission, UID/package ownership, app-op, or user-boundary check before the sink.

## Case: Identity Cleared Too Early

### Abstract Shape

```text
unprivileged app -> Binder method params -> clearCallingIdentity -> attacker-selected privileged operation
```

### Key Mistake

Caller authorization or target validation happens after identity is cleared, or not at all.

### Why It Was Exploitable

- attacker reaches the method
- attacker controls work inside the cleared block
- service identity masks the original caller
- sink trusts privileged identity

### Generalized Detection Rule

For every `clearCallingIdentity` block, prove all attacker-controlled branches were authorized before clearing.

## Case: Cross-User Target Confusion

### Abstract Shape

```text
caller user A -> Binder target user B -> no cross-user guard -> data/action for user B
```

### Key Mistake

The service treats a caller-supplied user ID as an authorized target user.

### Why It Was Exploitable

- caller controls target user/profile value
- service reaches an `asUser` or per-user store sink
- no same-user or cross-user permission check applies
- result exposes or modifies another user's state

### Generalized Detection Rule

Target user/profile parameters are untrusted until bound to Binder caller identity and cross-user permissions.

## Case: Privileged Intent Launch Without Target Validation

### Abstract Shape

```text
unprivileged app -> Binder Intent params -> no target/flag/user validation -> framework startActivityAsUser under system identity
```

### Key Mistake

Framework service constructs or forwards a caller-supplied Intent to startActivityAsUser/startService/sendBroadcastAsUser without pinning the target component, stripping dangerous flags, or validating the user boundary.

### Why It Was Exploitable

- Binder surface is callable
- attacker controls action, data URI, package, component, extras, flags
- framework service performs launch under system identity
- no exact-target or user-boundary check before launch

### Generalized Detection Rule

Every Binder-exposed Intent launch path must pin the target component or validate the package/UID match, strip caller-controlled flags/grants/selector/ClipData, and enforce user boundaries before the launch sink.

### Related

[[patterns/framework-service-intent-launch]], [[patterns/framework-service-pendingintent]]

## Case: Framework PendingIntent Identity Reuse

### Abstract Shape

```text
unprivileged app -> Binder -> framework creates PI with caller data -> stored/sent PI uses system identity -> victim launch or grant
```

### Key Mistake

Framework service creates a PendingIntent with attacker-controlled action, target, extras, flags, or user, then stores or sends it. The PI later executes under system identity regardless of the original caller.

### Why It Was Exploitable

- Caller controls PI target and fill-in data
- framework creates PI under privileged context
- PI is dispatched later when attacker can trigger it
- immutable flags are not enforced

### Generalized Detection Rule

Every Binder-exposed PendingIntent creation must enforce immutable flags, validate the target against caller identity, bind the package to calling UID, and strip caller-controlled mutable fields before storing or dispatching.

### Related

[[patterns/framework-service-pendingintent]], [[patterns/framework-service-intent-launch]]

## Case: ContentProvider Proxy Data Leak

### Abstract Shape

```text
unprivileged app -> Binder URI param -> framework ContentResolver.query under system identity -> protected rows returned to caller
```

### Key Mistake

Framework service uses caller-supplied URI to query a ContentProvider under privileged identity without checking URI authority, path, or whether the caller has access to the requested data.

### Why It Was Exploitable

- Binder surface accepts URI parameters
- framework performs provider access under system identity
- URI authority/path is not allowlisted
- returned cursor data is protected
- caller receives data they should not access

### Generalized Detection Rule

Every Binder-exposed ContentResolver operation must validate URI authority against an immutable allowlist, canonicalize paths, enforce caller UID/package binding, and filter returned data per caller identity before returning.

### Related

[[patterns/framework-service-content-provider-proxy]], [[patterns/framework-service-data-leak]]

## Case: Protected Framework Data Returned to Lower-Privileged Caller

### Abstract Shape

```text
unprivileged app -> Binder query/manager method -> framework reads protected state -> unfiltered return to caller
```

### Key Mistake

Framework service method returns protected system, user, or package state without checking whether the caller is authorized for the requested scope or filtering the response per caller identity.

### Why It Was Exploitable

- Binder method is callable
- attacker selects target package, user, or data scope
- service reads protected state under system identity
- no caller authorization or response filtering before return

### Generalized Detection Rule

Every Binder-exposed method that returns privileged state must bind the requested scope to caller UID/package/user, enforce signature permission or app-op, and filter the response to exclude data the caller is not authorized to see.

### Related

[[patterns/framework-service-data-leak]], [[patterns/framework-service-permission-missing]]

## Case: TOCTOU in Async Authorization

### Abstract Shape

```text
unprivileged app -> Binder check (authorized) -> async callback/registry change -> stale check -> privileged sink with wrong state
```

### Key Mistake

Framework service checks caller authorization, then performs the privileged operation after an async boundary (handler, callback, observer, register) without rechecking that the authorization state is still valid.

### Why It Was Exploitable

- Attacker can trigger concurrent Binder calls that modify state between check and use
- async boundary changes target identity, permission, or registration
- privileged operation uses stale authorized state
- no lock or recheck at the final sink

### Generalized Detection Rule

Every privileged operation after an async boundary must rebind identity/user/package at the final sink using Binder.getCallingUid() or an immutable snapshot, not rely on a pre-async check.

### Related

[[patterns/framework-service-race-condition]], [[patterns/framework-service-permission-missing]], [[patterns/framework-service-clear-identity]]

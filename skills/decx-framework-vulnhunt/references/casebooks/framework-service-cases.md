# Casebook: Framework Service Bugs

Use this casebook after the framework service pattern references. These are generalized exploit-chain shapes, not runtime validation claims.

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

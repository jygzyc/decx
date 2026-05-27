# Pattern: Framework Service Cross-User Boundary

## When To Use

Use this reference when framework service methods accept user IDs, profile IDs, handles, package names, account names, or state keys that may cross Android user/profile boundaries.

## Vulnerability Essence

Caller-controlled target-user data reaches privileged operations without enforcing whether the Binder caller may act for that user or profile.

## Sources

- `userId`, `UserHandle`, profile ID, parent/managed profile ID, account/profile/package parameters
- URI, `Intent`, or token fields that imply a target user
- service records cached per user but looked up with caller-controlled keys

## Sinks

- cross-user data reads/writes
- package, settings, policy, notification, account, permission, storage, or intent operations for another user/profile
- broadcasts or launches using `asUser` variants

## Required Trace Evidence

- Reachability: caller can invoke the method with chosen target user/profile data.
- Controllability: attacker controls the target user/profile or indirectly selects it.
- Sink: service reads/writes/launches/returns state for a different user/profile.
- Missing or bypassable guard: no `INTERACT_ACROSS_USERS`, profile ownership, same-user, or user restriction check blocks the path.
- Visible impact: cross-user data disclosure, unauthorized state change, or policy bypass.

## Guard Checklist

Consider safe when caller user is derived from Binder, target user is checked against caller permissions/profile relationship, `asUser` calls use validated users, and per-user stores cannot be indexed by attacker-controlled IDs.

## Rejection Rules

Reject when target user is forced to the caller user, cross-user permission is enforced on all paths, data is public/non-sensitive, or no cross-user sink is reached.

## Rating Mapping

- CRITICAL: cross-user policy/device compromise or persistent protected state tampering.
- HIGH: sensitive data/action across users or profiles.
- MEDIUM: bounded cross-profile state change.
- IGNORED: no cross-user effect.

## Trace Commands

```bash
decx code method-context "<binderMethod>" -P <port>
decx code method-source "<crossUserSink>" -P <port>
```

## Report Snippet

Use: "The service applies attacker-selected target-user data to a privileged operation without enforcing cross-user authorization."

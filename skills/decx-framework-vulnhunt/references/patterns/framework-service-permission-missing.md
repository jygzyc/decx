# Pattern: Framework Service Permission Missing

## When To Use

Use this reference when a Binder-exposed framework method performs privileged work, returns protected state, or changes system configuration without a strong caller permission or UID/package check.

## Vulnerability Essence

Untrusted Binder input crosses into `system_server` or another privileged service and reaches privileged operations before a non-bypassable authorization check.

## Sources

- Binder interface methods, manager service stubs, shell/system service entrypoints
- method parameters, caller UID/user ID, package name, attribution tag, `Intent`, `Uri`, `Bundle`

## Sinks

- protected settings, package/user/device policy, account, notification, location, telephony, storage, or permission operations
- file/provider reads or writes under system identity
- privileged component launches or broadcasts

## Required Trace Evidence

- Reachability: attacker app or lower-privileged caller can invoke the Binder method.
- Controllability: attacker controls parameters used by the privileged operation.
- Sink: operation affects protected state/data/action.
- Missing or bypassable guard: no enforced signature/system permission, app-op, UID/package ownership, or user restriction check applies before sink.
- Visible impact: system-level data/action exposure, protected state change, privilege escalation, or persistent DoS.

## Guard Checklist

Consider safe when the method enforces the right signature permission, verifies UID/package ownership, checks target user restrictions, validates app-ops where relevant, and repeats checks after identity-clearing or async boundaries.

## Rejection Rules

Reject when the caller cannot reach the method, permission is enforced on all paths before the sink, the operation is harmless/public, or a lower-level callee enforces the same non-bypassable guard.

## Rating Mapping

- CRITICAL: broad system compromise, privileged code execution, root/system capability, persistent device-level impact.
- HIGH: protected system data/action exposure or meaningful privilege misuse.
- MEDIUM: bounded settings/state change with additional prerequisites.
- IGNORED: missing-looking check is covered by a proven callee guard or no impact.

## Trace Commands

```bash
decx ard system-service-impl "<Interface>" -P <port>
decx code method-context "<binderMethod>" -P <port>
decx code method-source "<privilegedSinkOrCallee>" -P <port>
```

## Report Snippet

Use: "A Binder-exposed framework method performs a privileged operation before enforcing a non-bypassable caller permission."

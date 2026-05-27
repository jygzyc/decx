# Pattern: Framework Service clearCallingIdentity Misuse

## When To Use

Use this reference when framework service code calls `Binder.clearCallingIdentity()`, `withCleanCallingIdentity()`, or equivalent identity-clearing helpers around attacker-influenced work.

## Vulnerability Essence

Attacker-triggered work runs with privileged service identity because authorization or target validation is incomplete before caller identity is cleared.

## Sources

- Binder method parameters
- caller-controlled `Intent`, `Uri`, package, user ID, operation name, file path, or callback
- async work scheduled while identity is cleared or with captured attacker-controlled state

## Sinks

- privileged file/provider/package/settings/user/device operations
- component launch or broadcast under system identity
- callbacks or scheduled work that outlive the intended identity boundary

## Required Trace Evidence

- Reachability: attacker can invoke the method containing or reaching the identity-cleared block.
- Controllability: attacker shapes work performed inside the cleared identity scope.
- Sink: privileged operation executes after identity is cleared.
- Missing or bypassable guard: authorization, ownership, target, and user checks are absent, incomplete, or performed after clearing.
- Visible impact: protected state/data/action changes under system identity.

## Guard Checklist

Consider safe when all authorization and target validation finish before clearing, the cleared block is minimal and uses trusted constants, `restoreCallingIdentity` is reliably fenced, and async callbacks do not inherit uncontrolled privileged work.

## Rejection Rules

Reject when the cleared block performs only harmless bookkeeping, all attacker-controlled branches are validated before clearing, or the privileged callee performs its own non-bypassable checks.

## Rating Mapping

- CRITICAL: identity clearing enables broad system compromise or persistent device-level impact.
- HIGH: protected data/action under system identity.
- MEDIUM: bounded privileged action with strong prerequisites.
- IGNORED: no attacker-controlled privileged work in cleared scope.

## Trace Commands

```bash
decx code xref-method "android.os.Binder.clearCallingIdentity():long" -P <port>
decx code method-cfg "<methodWithClearedIdentity>" -P <port>
```

## Report Snippet

Use: "The service clears Binder caller identity before completing authorization, allowing attacker-controlled work to run with privileged service identity."

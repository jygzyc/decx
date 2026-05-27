# Pattern: Framework Service Race Condition

## When To Use

Use this reference when authorization, identity, user selection, file/provider state, or privileged operations depend on mutable framework state across asynchronous or concurrent boundaries.

## Vulnerability Essence

Attacker-controlled timing changes state between check and use, allowing a privileged framework operation to execute with stale authorization or wrong target state.

## Sources

- Binder calls racing shared maps, tokens, callbacks, file/provider paths, package/user state, pending operations
- async handlers, locks, callbacks, observers, broadcasts, delayed runnables

## Sinks

- privileged state update, data return, package/user/policy change, file/provider access, identity-cleared work, cross-user launch

## Required Trace Evidence

- Reachability: attacker can trigger the relevant concurrent or asynchronous paths.
- Controllability: attacker can influence the checked state or target state across the race window.
- Sink: stale or changed state reaches a privileged operation.
- Missing or bypassable guard: no lock, atomic recheck, immutable snapshot, token binding, or final authorization check protects use.
- Visible impact: protected data/action, policy bypass, cross-user confusion, or persistent DoS.

## Guard Checklist

Consider safe when checks and use share a lock or immutable snapshot, identity/user/package is rebound at the final sink, and callbacks cannot mutate the target between validation and operation.

## Rejection Rules

Reject speculative races without attacker-controlled timing, without a reachable concurrent path, or without visible security impact.

## Rating Mapping

- HIGH: race reaches privileged data/action or system policy bypass.
- MEDIUM: bounded state confusion with practical prerequisites.
- LOW: fragile transient effect with limited impact.
- IGNORED: no attacker-controlled race window.

## Trace Commands

```bash
decx code method-cfg "<checkedMethod>" -P <port>
decx code method-context "<asyncOrCallbackMethod>" -P <port>
```

## Report Snippet

Use: "Framework service authorization depends on mutable state that can change before the privileged sink is reached."

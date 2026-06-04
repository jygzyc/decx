# Pattern: Lifecycle State Exposure

## When To Use

Use this reference when Activity/Service/WebView lifecycle boundaries preserve, expose, or continue sensitive state into attacker-relevant context.

## Core Concept

Sensitive resources or state survive a lifecycle transition and become reachable through external navigation, callbacks, background work, task reuse, or stale UI.

**Sources**
- `onCreate`, `onNewIntent`, `onResume`, `onPause`, `onStop`, `onDestroy`, service lifecycle
- saved instance state, cached Intent data, WebView/session state, background callbacks, retained fragments

**Sinks**
- stale credential/session display, continued recording/location/network action, reused grant/result, stale WebView bridge/cookie context, background protected work

## Guards & Rejection

Safe when: sensitive state is cleared on exit, revalidated on every entry, background work is cancelled or permission-gated, and stale Intents/results/grants are not reused.

Reject when: lifecycle behavior only causes display glitches, harmless state persistence, or crash/noise with no security consequence.

## Rating

- HIGH: stale state exposes credentials/tokens or continues dangerous permission use.
- MEDIUM: bounded protected action or data exposure through lifecycle race/reentry.
- LOW: weak but real state leakage.
- IGNORED: no security-relevant state crosses the lifecycle boundary.

## Trace Commands

```bash
decx code class-context "<LifecycleClass>" -P <port>
decx code method-source "<LifecycleMethod>" -P <port>
```

## Example Shapes

Suspicious:

```text
Activity pauses with active grant/session -> attacker triggers lifecycle transition -> stale grant or session remains usable in attacker context
```

Safe:

```text
Activity releases grants and invalidates sensitive state in onStop/onPause -> no stale resource survives lifecycle boundary
```

Report guidance -- Use: "Sensitive app state crosses a lifecycle boundary and becomes attacker-reachable without revalidation or cleanup." Avoid: "lifecycle method exists" without proof that stale state or grants survive into an attacker-relevant context.

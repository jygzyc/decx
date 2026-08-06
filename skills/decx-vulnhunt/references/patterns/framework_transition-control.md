---
name: transition-control
track: framework
---

# transition-control

## Match
Lower-privileged caller registers/influences WindowOrganizer, TransitionPlayer, RemoteTransition, remote animation, `SurfaceControl.Transaction`, transition token, or `WindowContainerTransaction` registration/finish path.

## Non-obvious
- **Transition-player registration surface** is the framework analog of tapjacking — Binder lets lower-privileged callers register player, set WCT fields, or withhold `finishTransition`
- Required guard: `MANAGE_ACTIVITY_TASKS` and/or `SYSTEM_UID` (not just `getCallingUid()`) for transition methods
- Floating window primitive: `FLAG_NOT_TOUCH_MODAL | FLAG_NOT_FOCUSABLE | FLAG_WATCH_OUTSIDE_TOUCH` — taps pass through to confirmation dialog
- `filterTouchesWhenObscured` default on Android 12+; pre-12 OEM must explicitly add — version split is the bug
- System-uid PI accepted as background activity start by `BackgroundActivityStartController`: See [[framework_intent-launch]]
- `finishTransition` callback with attacker-controlled WCT fields — scope validation must happen before `mWindowOrganizer.applyTransaction`
- `SurfaceControl` transaction registration without thread/binder identity check leaks transition metadata

## Reject
Caller cannot reach surface, callback is per-caller only, protected metadata filtered, finish data ignored/revalidated, effect is caller-owned/cosmetic, or overlay doesn't cover actionable confirmation with `filterTouchesWhenObscured="true"`.

# Pattern: Framework Service Transition Control

## Match

Lower-privileged caller can register or influence WindowOrganizer, TransitionPlayer, RemoteTransition, remote animation, `SurfaceControl.Transaction`, transition token, or `WindowContainerTransaction` registration/finish path. The framework-side analog of the floating-window tapjacking primitive is the transition-player registration surface: a Binder that allows lower-privileged callers to register a transition player, set `WCT` fields, or withhold `finishTransition` callbacks. The windowing code paths (transition registration, `WCT` mutation, finish timing) are typically reachable from shell/SystemUI; misuse comes from services that expose them without `MANAGE_ACTIVITY_TASKS` / `SYSTEM_UID` enforcement.

## Analyze

- entry: Binder transition/organizer method, remote delegate registration, finish callback, shell/system UI facade, `IWindowManager` transition API, `WindowContainerTransaction` callback, `SurfaceControl` transaction registration, floating window (`TYPE_APPLICATION_OVERLAY`) with `FLAG_NOT_TOUCH_MODAL | FLAG_NOT_FOCUSABLE | FLAG_WATCH_OUTSIDE_TOUCH`
- control: transition player/delegate Binder, token, callback, WCT fields, bounds/windowing mode/task/container, finish timing, overlay target window, tap-jacking surface state
- sink: global transition callback, transition metadata, `finishTransition`, WCT mutation, SurfaceControl/task/window state, overlay-tap pass-through to legitimate confirmation dialog, credential entry UI spoofed by overlay
- guard: SYSTEM/Shell/SystemUI identity check (or `SYSTEM_UID` / `MANAGE_ACTIVITY_TASKS` for transition methods), trusted app-thread binding, token owner check, WCT scope validation; for floating window, the user must explicitly grant `SYSTEM_ALERT_WINDOW`, and the floating window must be opaque or must NOT cover sensitive confirmation dialogs (Android 12+ enforces `filterTouchesWhenObscured` by default; for pre-12 OEM must explicitly add the flag)
- impact: transition interception, protected task/surface metadata, UI freeze, persistent task/window mutation, credential/approval UI control; for floating window, the user thinks they are confirming a legitimate action but is actually approving the attacker's request

## Required Trace Evidence

Reachability, Controllability, Sink, Missing guard, Visible impact

## Reject

Reject when caller cannot reach the surface, callback is per-caller only, protected metadata is filtered, finish data is ignored/revalidated, or effect is caller-owned/cosmetic. For floating window, reject when the overlay does not cover an actionable confirmation dialog, when the confirmation UI has `filterTouchesWhenObscured="true"` and `onFilterTouchEventForSecurity` rejects the tap, or the user can dismiss the overlay with a back-press.

## Codes

```java
// floating window covers a confirmation dialog with FLAG_NOT_TOUCH_MODAL |
// FLAG_NOT_FOCUSABLE | FLAG_WATCH_OUTSIDE_TOUCH; taps pass through to the
// confirmation below
```

```java
// transition-player registration path accepts lower-privileged callers without
// SYSTEM_UID / MANAGE_ACTIVITY_TASKS / shell check
```

```java
// system-uid process hands out PendingIntents that the BackgroundActivityStartController
// accepts as "realCallingUid is system-uid", letting any app start an activity in
// the background
```

```java
// transition finish callback is invoked with attacker-controlled WCT fields; nothing
// validates the fields before mWindowOrganizer.applyTransaction
```

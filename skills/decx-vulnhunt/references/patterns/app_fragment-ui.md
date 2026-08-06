---
name: fragment-ui
track: app
---

# fragment-ui

## Match
UI/state trust abuse: caller-controlled Fragment class name, task affinity/launch mode impersonation, overlay/tap-jacking, or lifecycle state reuse.

Three primitive shapes:
- **Fragment injection**: `PreferenceActivity.EXTRA_SHOW_FRAGMENT` → `Fragment.instantiate` via `getClassLoader().loadClass(name)`; `isValidFragment(String)` is the guard
- **UI trust abuse**: task affinity/launch mode/overlay influences credential entry or protected approval
- **Lifecycle state exposure**: sensitive state/grant/result survives lifecycle/task switch/process restart

## Non-obvious
- `isValidFragment` override returning `true` for everything re-introduces the bug even if base is restrictive
- `EXTRA_SHOW_FRAGMENT_ARGUMENTS` Bundle is also caller-controlled — fragment reached with forged args
- `onCreate(savedInstanceState)` re-parses same untrusted fragment name on config change (chains to `object-parsing`)
- **StrandHogg**: `allowTaskReparenting` + `taskAffinity` impersonate victim's task in overview
- Floating-window tapjacking flags + `filterTouchesWhenObscured` version split: See [[framework_transition-control]]
- `START_REDELIVER_INTENT` re-delivers attacker payload on every crash — stable DoS, no new Intent required
- `onNewIntent` overwrites `getIntent()` without clearing extras — `singleTask`/`singleTop` attacker re-launches treated as continuation
- Sensitive action closed in `onDestroy` (not `onPause`) keeps running when app backgrounds

## Reject
Fragments are public constants, `isValidFragment` strictly rejects caller-controlled names, no protected input/action, or task/overlay protections block attacker control.

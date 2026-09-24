---
name: fragment_ui
track: android-app
---

# fragment_ui

## Match
UI/state trust abuse via caller-controlled Fragment class, task affinity/launch mode, overlay, or lifecycle state reuse.

Primitive shape:
- **Fragment injection**: `PreferenceActivity.EXTRA_SHOW_FRAGMENT` → `Fragment.instantiate` via `getClassLoader().loadClass(name)`; `isValidFragment(String)` is the guard

## Non-obvious
- `isValidFragment` override returning `true` for everything re-introduces the bug even if base is restrictive
- `EXTRA_SHOW_FRAGMENT_ARGUMENTS` Bundle is also caller-controlled — fragment reached with forged args
- `onCreate(savedInstanceState)` re-parses same untrusted fragment name on config change (chains to `object-parsing`)
- **StrandHogg**: `allowTaskReparenting` + `taskAffinity` impersonate victim's task in overview
- Floating-window tapjacking flags + `filterTouchesWhenObscured` version split: See [[android-framework-transition_control]]
- `START_REDELIVER_INTENT` re-delivers attacker payload on every crash — stable DoS, no new Intent required
- `onNewIntent` overwrites `getIntent()` without clearing extras — `singleTask`/`singleTop` attacker re-launches treated as continuation

## Reject
Fragments are public constants, `isValidFragment` strictly rejects caller-controlled names, no protected input/action, or task/overlay protections block attacker control.

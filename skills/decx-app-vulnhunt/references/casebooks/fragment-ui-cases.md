# Casebook: Fragment and UI Trust

Use this casebook after [[patterns/fragment-injection]], [[patterns/ui-trust-abuse]]. These cases are abstract exploit shapes, not CVE-specific instructions.

## Case: Deep Link Fragment Parameter Opens Admin Settings Fragment

### Abstract Shape

```text
external app -> exported Activity -> Fragment.instantiate(class from extra) -> admin settings Fragment loaded with elevated privileges
```

### Key Mistake

The exported Activity resolves a Fragment class name from an Intent extra or URI parameter without validating it against an allowlist of permitted Fragment classes.

### Why It Was Exploitable

- exported Activity is reachable from any third-party application
- Fragment class name is caller-controlled via extra or URI query parameter
- `Fragment.instantiate` or `FragmentManager` loads any class within the app package
- the loaded Fragment inherits the hosting Activity's permissions and view context
- no class allowlist or package restriction limits which Fragments can be instantiated

### Generalized Detection Rule

If an exported component derives a Fragment class name from caller input and instantiates it without an explicit allowlist, trace the resulting Fragment to determine whether it exposes privileged UI or actions.

Related: [[patterns/fragment-injection]], [[patterns/ui-trust-abuse]]

## Case: Task Affinity Hijack Overlays Login Activity

### Abstract Shape

```text
malicious app -> Activity with matching taskAffinity -> inserted into victim task -> overlay on top of login Activity -> user enters credentials into malicious Activity
```

### Key Mistake

The victim Activity declares a predictable or default `taskAffinity`, allowing a malicious app to insert its own Activity into the victim's task stack and overlay sensitive screens.

### Why It Was Exploitable

- victim Activity uses the default package affinity or an explicitly declared affinity that is guessable
- malicious app declares an Activity with the same `taskAffinity` value
- Android task management places the attacker Activity into the victim's back stack
- the attacker Activity visually mimics the login screen, tricking the user
- no `FLAG_ACTIVITY_NEW_TASK` combined with `FLAG_ACTIVITY_CLEAR_TASK` isolates the victim task

### Generalized Detection Rule

When an Activity handling authentication or other sensitive input uses a predictable affinity and does not isolate its task, evaluate whether a third-party app can inject a visually similar Activity into the same task.

Related: [[patterns/ui-trust-abuse]]

## Case: Navigation Component Route Bypass Is Inconsistent

### Abstract Shape

```text
external deep link -> Navigation deep link -> destination Fragment loaded -> authentication check skipped because graph entry is assumed internal
```

### Key Mistake

The app uses Jetpack Navigation with deep link support but assumes navigation graph destinations are only reachable through internal traversal, so authentication checks are applied inconsistently across entry points.

### Why It Was Exploitable

- Jetpack Navigation exposes deep link URIs that map directly to destination Fragments
- authentication logic is attached to navigation graph transitions rather than the Fragments themselves
- deep links bypass the normal transition path and load the destination directly
- some destinations lack independent authentication checks because they assume the caller is internal
- the navigation graph does not enforce a global login requirement for protected destinations

### Generalized Detection Rule

When Navigation deep links can reach protected destinations without passing through an authentication gate in the graph, flag the inconsistency between graph-level and destination-level access control.

Related: [[patterns/fragment-injection]], [[patterns/ui-trust-abuse]]

## Case: Obscured Touch Approves Protected Action

### Abstract Shape

```text
malicious app -> SYSTEM_ALERT_WINDOW overlay -> transparent button aligned over victim's confirm button -> user taps -> protected action approved in victim app
```

### Key Mistake

The victim app performs a sensitive action on a button press without verifying that the touch event originated from its own window and not from an overlay drawn by another application.

### Why It Was Exploitable

- attacker holds the `SYSTEM_ALERT_WINDOW` permission, available to most third-party apps
- overlay positions a transparent or disguised touch target directly over the victim's confirm button
- the victim app does not detect window overlap or use `MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED`
- the user believes they are dismissing a harmless notification or dialog
- the protected action executes with the victim app's full privileges

### Generalized Detection Rule

When a sensitive confirmation button can be obscured by a system overlay and the app does not check for obscured touch flags, evaluate whether a tapjacking attack can silently approve a privileged operation.

Related: [[patterns/ui-trust-abuse]]

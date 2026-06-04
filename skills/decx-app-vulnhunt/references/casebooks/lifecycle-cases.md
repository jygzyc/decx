# Casebook: Lifecycle State Exposure

Use this casebook after [[patterns/lifecycle-state-exposure]]. These cases are abstract exploit shapes, not CVE-specific instructions.

## Case: onNewIntent Re-entry Uses Stale Intent Without Revalidation

### Abstract Shape

```text
first launch (safe Intent) -> Activity running -> onNewIntent(attacker Intent) -> UI updates but background handler still uses original extras -> stale data reaches sensitive operation
```

### Key Mistake

The exported `singleTop` Activity updates its UI in `onNewIntent` but a background branch or handler continues reading data from the original `getIntent()` rather than the new Intent.

### Why It Was Exploitable

- Activity is exported and `singleTop`, so `onNewIntent` delivers a second caller-controlled Intent
- `onNewIntent` updates the Intent for display but does not propagate it to all consumers
- a background thread, handler, or pending callback still references the old Intent extras
- the stale data path skips validation that was applied to the new Intent
- race condition between `onNewIntent` update and background handler read allows stale values to reach sinks

### Generalized Detection Rule

When an exported `singleTop` or `singleTask` Activity receives a new Intent via `onNewIntent`, check whether all code paths that read Intent data reference the updated Intent rather than the original.

Related: [[patterns/lifecycle-state-exposure]]

## Case: Background Service Continues Sensitive Work After Activity Exit

### Abstract Shape

```text
Activity -> startService(location tracking) -> user leaves Activity -> onStop does not stop service -> location data continues collecting without user awareness
```

### Key Mistake

The Activity starts a bound or started service for sensitive data collection but does not stop or unbind the service in `onStop` or `onDestroy`, allowing collection to continue invisibly.

### Why It Was Exploitable

- service is started in `onCreate` or `onResume` without a corresponding stop in `onStop`
- the service has no independent timeout or user-visible indicator
- location, microphone, or other sensor data continues to be collected in the background
- user believes collection has stopped because the Activity is no longer visible
- no foreground service notification requirement is enforced on older API levels

### Generalized Detection Rule

When a service performing sensitive data collection is started by an Activity but not stopped in the Activity's lifecycle teardown methods, trace whether the service continues operating without user awareness.

Related: [[patterns/lifecycle-state-exposure]]

## Case: onPause Does Not Release Active URI Grant

### Abstract Shape

```text
Activity -> URI grant received in onResume -> user navigates away -> onPause does not call releaseUriPermission -> grant persists while Activity is paused
```

### Key Mistake

The Activity receives a content URI permission grant in `onResume` but does not release it in `onPause`, allowing the grant to persist while the Activity is in the background.

### Why It Was Exploitable

- `onResume` calls `takeUriPermission` or accepts a grant via Intent flags
- `onPause` does not call `releaseUriPermission` or clear the grant
- the granted URI remains accessible to the Activity's process while it is paused
- another app can interact with the paused Activity's task and reach the persisted grant
- the grant scope is broader than the visible lifetime of the Activity

### Generalized Detection Rule

When an Activity acquires a URI permission grant in `onResume`, verify that the corresponding release occurs in `onPause` so the grant does not outlive the Activity's foreground lifetime.

Related: [[patterns/lifecycle-state-exposure]]

## Case: WebView Session Cookies Survive Navigation To Attacker Page

### Abstract Shape

```text
WebView loads trusted site -> cookies set -> navigation to attacker URL -> cookies sent with request -> attacker captures authenticated session
```

### Key Mistake

The WebView loads an authenticated trusted page and then navigates to an attacker-controlled URL without clearing the cookie store, causing session cookies to be sent to the attacker domain.

### Why It Was Exploitable

- WebView loads a trusted authenticated URL and receives session cookies
- cookie store is shared across all navigations within the same WebView instance
- navigation to an external or attacker-controlled URL occurs via redirect, deep link, or JavaScript
- cookies with broad path or domain scope are included in the outgoing request
- `CookieManager` is not flushed or cleared between trusted and untrusted navigations

### Generalized Detection Rule

When a WebView loads both authenticated content and external or caller-controlled URLs in the same instance, check whether session cookies from the trusted domain are transmitted to the untrusted destination.

Related: [[patterns/lifecycle-state-exposure]]

---
name: poc-base
description: Shared contract for DECX PoC construction references.
---

# Base PoC Contract

## Current Template

All `decx-poc` references assume the same split template:

- Android side: `ExploitEntry`, `ExploitRegistry`, `PoCActivity`
- Web side: `server/public/index.html`, `server/public/payload.html`, `server/public/scenario.js`, `server/server.mjs`

The Android template is intentionally small:

- one launcher activity
- one browsable route shape: `poc-<target>://run/trigger?exploit=<id>`
- one exploit registry with dynamic buttons

The server template is intentionally minimal:

- `index.html`: build one deep link or one `intent://` URL
- `payload.html`: add one script block for the active WebView payload
- `scenario.js`: render the generated links and ADB commands

The normal workflow is:

1. add one hyperlink variant in `index.html` if the trigger changes
2. add or replace one script block in `payload.html` if the payload changes

## Registration Shape

Use the current template, not an imaginary base class:

```java
static {
    register("example-id", "Example Exploit", () -> runExample());
}

private static void runExample() {
    Log.i("PoC", "Replace with the verified exploit path");
}
```

Snippet convention:

- examples show the exploit body shape, not a drop-in full file
- `appContext` is a placeholder for the actual `Context` you wire into the current PoC project
- replace imports, helper fields, and registration placement to match the active target project

## Common Rules

- one exploit id proves one finding
- keep helper code close to the exploit unless a real Manifest component is required
- replace every placeholder package, action, URI, extra key, Binder method, and host value
- log visible proof, not theory
- model two-stage exploits explicitly as `capture -> trigger`
- prefer local `server/` assets over remote infrastructure unless origin really matters
- use `AndroidHiddenApiBypass` only for framework Binder paths that truly need it

## Success Signals

Good:

- returned rows, files, tokens, or Binder results
- actual target component launch
- actual grant or `PendingIntent` reuse
- actual privileged state change

Bad:

- `Exploit executed`
- `Target may be vulnerable`
- `Should lead to escalation`

## Support Components

Add helpers only when the verified path requires them:

- helper `Activity`: task hijack, result capture, UI-assisted steps
- helper `BroadcastReceiver`: interception or broadcast leak capture
- helper `Service`: long-lived listener, overlay, notification observation
- server asset: browser-driven link, WebView payload, JS bridge, or result capture

If the finding does not need a helper, do not add one.

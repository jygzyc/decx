---
name: poc-base
description: Shared contract for DECX PoC construction references.
---

# Base PoC Contract

## Template

All references assume the same split template:

- Android: `ExploitEntry`, `ExploitRegistry`, `PoCActivity`
- Web: `server/public/index.html`, `server/public/scenario.js`, `server/public/payload.html`, `server/server.mjs`

Normal workflow: add one hyperlink variant in `index.html` and one script block in `payload.html` per active PoC.

## Registration Shape

```java
static {
    register("example-id", "Example Exploit", () -> runExample());
}

private static void runExample() {
    Log.i("PoC", "Replace with the verified exploit path");
}
```

- Examples show the exploit body shape, not a drop-in full file.
- `appContext` is a placeholder for the actual `Context` you wire into the project.
- Replace imports, helper fields, and registration placement to match the active target.

## Common Rules

- One exploit id proves one finding.
- Keep helper code close to the exploit unless a real Manifest component is required.
- Replace every placeholder package, action, URI, extra key, Binder method, and host value.
- Log visible proof, not theory.
- Model two-stage exploits explicitly as `capture -> trigger`.
- Prefer local `server/` assets over remote infrastructure unless origin really matters.

## Success Signals

Good: returned rows, files, tokens, or Binder results; actual component launch; actual grant or `PendingIntent` reuse; actual privileged state change; actual framework service response with privileged data.

Bad: `Exploit executed`, `Target may be vulnerable`, `Should lead to escalation`.

Framework-specific success signals: privileged Binder method returns a result without required permission, identity confusion causes cross-user action, `clearCallingIdentity` discard leads to privileged execution under system identity.

## Support Components

Add helpers only when the verified path requires them:

- helper `Activity`: task hijack, result capture, UI-assisted steps
- helper `BroadcastReceiver`: interception or broadcast leak capture
- helper `Service`: long-lived listener, overlay, notification observation
- server asset: browser-driven link, WebView payload, JS bridge, or result capture

If the finding does not need a helper, do not add one.

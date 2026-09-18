---
name: webview
track: android-poc
---

# webview

## Match
WebView deep link delivers an attacker-controlled URL or HTML (`scenario-page` shape).

## Non-obvious
- The shape is valid only when the spec proves the controlled URL parameter or HTML source reaches the WebView; deep link prefix, victim package/activity, payload action and `successSignal` are required spec fields.
- `server.mjs` is a zero-dependency Node server on `HOST` 0.0.0.0 / `PORT` 8000 serving `public/` with permissive CORS and `/` mapped to `index.html`.
- `index.html` is the link builder, `scenario.js` generates the trigger variants, and `payload.html` is the attacker page loaded by the victim WebView.
- Every PoC adds one link variant (raw deep link, browser `intent://` URL, equivalent `adb shell am start`) and one payload block; the deep link encodes the attacker URL, which defaults to `<serverOrigin>/payload.html`.
- A helper-app trigger is registered only if the spec requires an app-side launch.

## Reject
The controlled URL/HTML never reaches `loadUrl`, or the WebView sink is assumed rather than proven — stop instead of hosting a payload nothing loads.

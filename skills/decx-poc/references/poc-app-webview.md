---
name: poc-app-webview
description: WebView PoC routing for deep-link driven hosted payloads.
---

# WebView PoC Reference

## Shape

Use `scenario-page` when the spec proves attacker-controlled URL/HTML reaches WebView.

## Required Spec Fields

- deep link prefix
- victim package/activity
- controlled URL parameter or HTML source
- payload action
- successSignal

## Implementation Slots

Server files and their contracts are defined in `poc-base.md` (`Server Contract` section):

- add one link variant in the link builder page (`index.html`) or its variant generator (`scenario.js`);
- add one payload block in the hosted payload page (`payload.html`);
- optionally register helper-app trigger if the spec requires app-side launch.

## Variants

- raw deep link
- browser `intent://` URL
- equivalent adb command

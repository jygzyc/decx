---
name: poc-app-intent
description: Intent PoC routing for PendingIntent, URI grants, implicit intents, classloader, and parcel mismatch.
---

# Intent PoC Reference

## Matrix

| Signal | Shape | Support |
|---|---|---|
| mutable PendingIntent / returned handle | `returned-handle` | capture step only if proven |
| URI grant / implicit Intent | `interception` | helper component matching spec |
| classloader / parcel mismatch | `direct-trigger` | custom payload only if proven |

## Required Spec Fields

- source of handle or trigger Intent
- target action/component/data
- extra keys / flags / grant URI
- capture step, if proven
- successSignal

## Implementation Slots

- register one exploit id;
- implement capture and trigger as separate methods for two-stage flows;
- add helper component only when `supportComponents` requires it;
- log `successSignal`.

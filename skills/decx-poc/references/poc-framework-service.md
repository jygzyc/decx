---
name: poc-framework-service
description: Framework Binder PoC routing for service calls and race drivers.
---

# Framework Service PoC Reference

## Matrix

| Signal | Shape | Support |
|---|---|---|
| permission/identity/data/intent Binder issue | `binder-caller` | hidden API |
| race condition | `binder-caller` | hidden API + concurrency driver |

## Required Spec Fields

- service name
- interface descriptor
- method or transact code
- parameter types and values
- identity/guard fact ids
- successSignal

## Implementation Slots

- add hidden API exemption;
- resolve service via ServiceManager;
- call exactly one verified method/transact path;
- add concurrency only when `pocShape` requires it;
- log `successSignal`.

## Boundary

Do not use app component delivery (`startActivity`, `bindService`, `sendBroadcast`) for framework Binder findings.

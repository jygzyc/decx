---
name: poc-app-provider
description: Provider PoC routing for query, file, call, batch, getType, and grants.
---

# Provider PoC Reference

## Matrix

| Signal | Shape | Support |
|---|---|---|
| query / SQL injection / `getType()` | `direct-trigger` | none |
| file/path access | `direct-trigger` | none |
| `call()` / batch | `direct-trigger` | none |
| returned grant / FileProvider chain | `returned-handle` | capture step only if proven |

## Required Spec Fields

- provider authority
- URI/path/method/batch body
- selection/sort/order args, if used
- grant handle source, if used
- successSignal

## Implementation Slots

- register one exploit id;
- call exactly one provider API family from the spec;
- do not invent grant acquisition;
- log `successSignal`.

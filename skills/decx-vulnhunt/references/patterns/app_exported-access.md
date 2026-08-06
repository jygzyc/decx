---
name: exported-access
track: app
---

# exported-access

## Match
Component reached through manifest export, implicit-export (`<intent-filter>` without `android:exported`), deep link, dynamic receiver, or bindable service.

## Non-obvious
- Activity/Service/Receiver with `<intent-filter>` defaults `exported="true"` (all API levels); API 31+ install **rejected** if filter-bearing component lacks explicit `exported`
- Provider export default flips at API 17: `< 17` = true, `>= 17` = false
- Non-exported but `<intent-filter>`-bearing component still reachable via `intent-redirect` or `object-parsing` — exported is not the only entry axis
- API 31+ explicit `exported="true"` is only safe when paired with signature permission or `setPackage` + caller check

## Reject
Signature-only permission covers the exact sink, target unreachable from non-system apps, or no protected downstream.

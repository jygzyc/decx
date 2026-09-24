---
name: exported_access
track: android-app
---

# exported_access

## Match
Component reached through manifest export, deep link, dynamic receiver, or bindable service. Implicit export means an `<intent-filter>` without `android:exported`.

## Non-obvious
- Activity/Service/Receiver with `<intent-filter>` defaults `exported="true"` (all API levels); API 31+ install **rejected** if filter-bearing component lacks explicit `exported`
- Provider export default flips at API 17: `< 17` = true, `>= 17` = false
- Non-exported but `<intent-filter>`-bearing component still reachable via `intent-redirect` or `object-parsing` — exported is not the only entry axis

## Reject
Signature-only permission covers the exact sink, target unreachable from non-system apps, or no protected downstream.

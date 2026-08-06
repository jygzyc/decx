---
name: intent-launch
track: framework
---

# intent-launch

## Match
Binder input reaches framework Intent construction/forwarding/broadcast/service/activity launch/result-callback/URI grant under privileged identity.

## Non-obvious
- **Indirect launch via callback result** is distinct from direct launch — framework calls back into lower-privileged caller, caller returns Intent, framework launches under system identity
- `Intent.parseUri` and `ComponentName.unflattenFromString` are parser forgery vectors — checking rebuilt ComponentName ≠ checking source string
- `FLAG_GRANT_*` flows to attacker when result Intent returned via `setResult`/callback — caller gets transient grant on privileged provider
- `getCallingActivity()`/`getCallingPackage()` identity warning: See [[app_intent-redirect]]
- Caller supplying `ComponentName` directly is higher-risk than action/data (controls identity, not just extras)
- Selector, ClipData, grant flags must be stripped before forwarding; missing strip = leak
- `BackgroundActivityStartController` accepts PI as "realCallingUid is system-uid" when handed out by system-uid process — any app can start in background

## Reject
Launched target is trusted constant, input affects only benign extras, non-bypassable guard exists, dangerous fields stripped, indirect launch identity re-derived at dispatch, or no security impact.

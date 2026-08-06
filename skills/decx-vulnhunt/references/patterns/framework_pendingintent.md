---
name: pendingintent
track: framework
---

# pendingintent

## Match
Framework service creates/stores/mutates/sends/cancels/accepts PendingIntent where caller controls target, extras, flags, package, request code, user, fill-in data, or callback token.

## Non-obvious
- **Mutability rule**: pre-API 31 PendingIntent defaults to mutable; targetSdk 31+ requires explicit `FLAG_MUTABLE` or `FLAG_IMMUTABLE` (omission throws `IllegalArgumentException`) — any PI without explicit `FLAG_IMMUTABLE` is mutable
- Empty base Intent (no target/action) + no `FLAG_IMMUTABLE` = anti-pattern — recipient fills target/action at dispatch, PI runs under system identity
- `FLAG_UPDATE_CURRENT` + stable request code collision primitive: See [[app_pendingintent]]
- "Mutable only for extras" is a misread — fill-in replaces data, action, AND grants (`FLAG_GRANT_READ_URI_PERMISSION` survives fill-in)
- Stored PI keyed on request code must re-validate original caller at dispatch; absence = stored-PI replay
- PI use sites: `addAccount` response, notification action, media-session event, credential reset, widget/remote-view click
- Sinks: master-clear, device-admin removal, account-remove — all reachable via PI dispatch

## Reject
PI is immutable with trusted constants, attacker cannot obtain/trigger, target rechecks authorization, or caller-controlled fields stripped before dispatch.

---
name: pendingintent
track: app
---

# pendingintent

## Match
Attacker influences PendingIntent creation, accepts one as extra, or triggers dispatch via notification/widget/alarm/shortcut/callback.

## Non-obvious
- **Pre-API 31 PendingIntent defaults to mutable**; targetSdk 31+ has no default — omitting both `FLAG_MUTABLE` and `FLAG_IMMUTABLE` throws `IllegalArgumentException`. Detection rule: treat any PI without explicit `FLAG_IMMUTABLE` as mutable
- `FLAG_UPDATE_CURRENT` + stable request code = collision primitive to replace stored PI
- AppWidget host PI fires with desktop identity but victim's permission set
- Fill-in mask replaces data, action, AND grants — `FLAG_GRANT_*` survives fill-in
- Caller-supplied PI via extra + `pi.send(this, 0, intent)` — recipient mutates and sends under creator identity

## Reject
PI is `FLAG_IMMUTABLE` with trusted constants, attacker cannot obtain/trigger, or target re-checks authorization on `send()`.

# pendingintent

## Match
Framework service creates/stores/mutates/sends/cancels/accepts PendingIntent where caller controls target, extras, flags, package, request code, user, fill-in data, or callback token.

## Non-obvious
- **SDK default flip**: `FLAG_IMMUTABLE` default on pre-31; `FLAG_MUTABLE` default on 31+ — both directions create bugs
- Empty base Intent (no target/action) + no `FLAG_IMMUTABLE` = anti-pattern — recipient fills target/action at dispatch, PI runs under system identity
- `FLAG_UPDATE_CURRENT` + stable request code = collision primitive: attacker replaces stored PI by matching request code
- "Mutable only for extras" is a misread — fill-in replaces data, action, AND grants (`FLAG_GRANT_READ_URI_PERMISSION` survives fill-in)
- Stored PI keyed on request code must re-validate original caller at dispatch; absence = stored-PI replay
- PI use sites: `addAccount` response, notification action, media-session event, credential reset, widget/remote-view click
- Sinks: master-clear, device-admin removal, account-remove — all reachable via PI dispatch

## Reject
PI is immutable with trusted constants, attacker cannot obtain/trigger, target rechecks authorization, or caller-controlled fields stripped before dispatch.

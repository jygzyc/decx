---
name: service-cmd
track: app
---

# service-cmd

## Match
Exported service, IntentService, AIDL/Binder, Messenger, or Job/WorkManager consuming attacker-controlled action/extras/command/URI/nested Intent/message/`replyTo`.

## Non-obvious
- **AIDL bytecode reflection** — attacker decompiles `Stub$Proxy` or `dex2jar` to regenerate interface; doesn't need `.aidl` source to `transact` any method
- Implicit `<intent-filter>` on service means `exported="true"` unless explicit declaration on API 31+
- `IntentService` `onHandleIntent` deserialization exceptions in `getSerializableExtra`/`getParcelableExtra` crash service (DoS, redelivered on `START_REDELIVER_INTENT`)
- AIDL `onTransact` reading Parcelable — subclass/reader mismatch shifts read position (chains to `object-parsing`)
- `Messenger` `Handler` dispatching `msg.what`/`Bundle` to command switch — no caller check is default

## Reject
Service unreachable, command from trusted constants, or AIDL method unreachable to privileged branch on attacker input.

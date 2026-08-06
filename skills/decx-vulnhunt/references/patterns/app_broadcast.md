---
name: broadcast
track: app
---

# broadcast

## Match
Exported `<receiver>` or dynamic `registerReceiver` (without `RECEIVER_NOT_EXPORTED`; flag introduced at API 33, mandatory from targetSdk 34 / Android 14), especially ordered-broadcast result callbacks.

## Non-obvious
- **Ordered broadcast result mutation is a distinct primitive** from Intent hijack: attacker writes into `setResultData`/`setResultExtras`; downstream receivers see forged security decision in the result, not the original Intent
- `setPackage(self)` on sender side does NOT close the door — receiver is still exported, trusts external extras
- `RECEIVER_NOT_EXPORTED` (introduced API 33, enforced as mandatory only from targetSdk 34 / Android 14) is the only built-in lockdown for dynamic receivers; pre-33 has no equivalent — check minSdk
- `getResultData`/`getResultExtras` reads in downstream receivers see attacker-controlled result — downstream guard checks the wrong value
- Weak custom permission (defined non-signature) gating a broadcast path = bypassable

## Reject
Signature-protected receiver, no ordered broadcast in trace, or result consumed only as UI hint with no security decision.
